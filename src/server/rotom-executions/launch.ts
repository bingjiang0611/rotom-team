import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdirSync, lstatSync, realpathSync, writeFileSync } from "node:fs";
import { parseWithWork } from "../perf-channels.ts";
import { startRotomKernel } from "../rotom-kernel.ts";
import type { RotomRpc } from "../rotom-rpc.ts";
import type { AsyncRotomJournal, KernelBinding } from "../rotom-journal.ts";
import type { KernelLaunchContext, Owned, PersistentKernel } from "./contracts.ts";
export interface LaunchContext {
    journal: AsyncRotomJournal;
    data: string;
    authorize: (
        binding: Readonly<KernelBinding>,
        operation: "admission" | "inference" | "refresh" | "fork",
        sessionId: string,
    ) => Promise<unknown>;
}

export async function launchRotom(
    ctx: LaunchContext,
    binding: Readonly<KernelBinding>,
    sessionId: string,
    sessionFile: string | undefined,
    prepared: KernelLaunchContext | undefined,
    gateState: PersistentKernel["gateState"],
    name: string,
    revision: string,
    owned: Owned,
    hooks: { beforeStart?: () => void; started?: (kernel: RotomRpc) => void } = {},
): Promise<PersistentKernel> {
    let identity = { binding, prepared, token: randomBytes(32).toString("base64url") };
    const gate = createServer(async (req, res) => {
        // Rotation invalidates old tokens and authorization already waiting on account checks.
        const admittedIdentity = identity;
        const authorization = Buffer.from(String(req.headers.authorization ?? "")),
            expected = Buffer.from(`Bearer ${admittedIdentity.token}`);

        if (
            req.method !== "POST" ||
            req.url !== "/authorize" ||
            authorization.length !== expected.length ||
            !timingSafeEqual(authorization, expected)
        ) {
            res.writeHead(403).end();

            return;
        }

        try {
            let body = "";

            for await (const chunk of req) {
                body += chunk;

                if (Buffer.byteLength(body) > 2048) {
                    throw new Error("gate request too large");
                }
            }

            const value = parseWithWork("native-gate", body);

            const active = gateState.active;

            if (!active || active.operation === "discover" || identity !== admittedIdentity) {
                throw new Error("No active inference receipt");
            }

            if (
                !["inference", "refresh", "usage"].includes(value.operation) ||
                value.provider !== admittedIdentity.binding.provider ||
                (value.operation !== "refresh" && value.model !== admittedIdentity.binding.model)
            ) {
                throw new Error("identity denied");
            }

            // A subagent's response: its entries stay in its own session, so the gate records what it spent.
            if (value.operation === "usage") {
                if (!value.usage || typeof value.usage !== "object") {
                    throw new Error("usage must be an object");
                }

                // childUsage itself checks the receipt and inserts atomically; no read/await/write gap.
                active.usageWrites = active.usageWrites.then(() =>
                    ctx.journal.childUsage(active.receipt.id, value.usage),
                );
                await active.usageWrites;
                res.writeHead(204).end();

                return;
            }

            if ((await ctx.journal.receipt(active.receipt.id)).status !== "dispatch-intent") {
                throw new Error("attempt is not active");
            }

            if (active.running.aborted) {
                throw new Error("execution stopped");
            }

            const auth = await ctx.authorize(admittedIdentity.binding, value.operation, sessionId);

            // No journal await after authorization: that would reopen a revocation/Stop window.
            // This owner clears active before every finish/fail, so the latch also fences settlement.
            if (
                active.running.aborted ||
                gateState.active !== active ||
                identity !== admittedIdentity
            ) {
                throw new Error("attempt ended during authorization");
            }

            if (admittedIdentity.prepared && value.operation === "inference") {
                if (!auth) {
                    throw new Error("No request auth");
                }

                const body = JSON.stringify(auth);

                if (Buffer.byteLength(body) > 65536) {
                    throw new Error("Request auth is too large");
                }

                active.inferenceAdmitted = true;
                res.writeHead(200, {
                    "Content-Type": "application/json",
                    "Cache-Control": "no-store",
                }).end(body);
            } else {
                if (value.operation === "inference") {
                    active.inferenceAdmitted = true;
                }

                res.writeHead(204).end();
            }
        } catch {
            res.writeHead(403).end();
        }
    });

    owned.gate = gate;
    gate.listen(0, "127.0.0.1");
    await once(gate, "listening");
    const folder = join(ctx.data, "kernel-gates");

    mkdirSync(folder, { recursive: true, mode: 0o700 });

    if (
        realpathSync(folder) !== folder ||
        !lstatSync(folder).isDirectory() ||
        lstatSync(folder).mode & 0o077
    ) {
        throw new Error("Kernel gate directory must be canonical and private");
    }

    const gateFile = join(folder, `${name}.json`);

    const writeIdentity = (flag: "wx" | "w") =>
        writeFileSync(
            gateFile,
            JSON.stringify({
                url: `http://127.0.0.1:${(gate.address() as { port: number }).port}/authorize`,
                token: identity.token,
                provider: identity.binding.provider,
                model: identity.binding.model,
                ...(identity.prepared
                    ? { modelDefinition: identity.prepared.modelDefinition }
                    : {}),
            }),
            { mode: 0o600, flag },
        );

    writeIdentity("wx");
    owned.gateFile = gateFile;
    let contextFile: string | undefined;

    if (prepared?.frozen) {
        contextFile = `${gateFile}.context`;
        writeFileSync(contextFile, prepared.frozen.context, {
            mode: 0o600,
            flag: "wx",
        });
        owned.contextFile = contextFile;
    }

    hooks.beforeStart?.();
    const kernel = await startRotomKernel({
        ...binding,
        thinkingLevel: await ctx.journal.thinkingLevel(sessionId),
        teamAgentDir: join(ctx.data, "team-agent"),
        gateFile,
        sessionFile,
        configuration: prepared?.frozen && {
            contextFile: contextFile!,
            skills: prepared.frozen.skills,
        },
    });

    owned.kernel = kernel;
    hooks.started?.(kernel);
    const state = (await kernel.request({ type: "get_state" })) as {
        sessionFile: string;
        sessionId: string;
        sessionName?: string;
        thinkingLevel: string;
    };
    const prefix = join(binding.home, ".pi/agent/sessions") + "/";

    if (
        typeof state.sessionId !== "string" ||
        typeof state.sessionFile !== "string" ||
        !state.sessionFile.startsWith(prefix) ||
        realpathSync(dirname(state.sessionFile)) !== dirname(state.sessionFile)
    ) {
        throw new Error("Native session outside admitted HOME");
    }

    return {
        revision,
        kernel,
        gate,
        gateFile,
        ...(contextFile ? { contextFile } : {}),
        gateState,
        modelApi: prepared?.modelDefinition.api,
        needsReload: false,
        rebind: (nextBinding, nextPrepared) => {
            identity = {
                binding: nextBinding,
                prepared: nextPrepared,
                token: randomBytes(32).toString("base64url"),
            };
            writeIdentity("w");
        },
        state,
    };
}
