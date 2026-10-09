/** Non-replayable team-owned execution journal around the real rotom loop. Not a model-provider adapter. */
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
    constants,
    closeSync,
    fstatSync,
    existsSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
    RotomJournal,
    type KernelBinding,
    type KernelEntry,
    type KernelReceipt,
} from "./rotom-journal.ts";
import { startRotomKernel, verifyRotomKernel } from "./rotom-kernel.ts";
import { type RotomRpc, type RpcRecord, RpcFailure } from "./rotom-rpc.ts";

export type KernelRequestAuth = {
    apiKey?: string;
    baseUrl?: string;
    headers?: Record<string, string | null>;
};
export type KernelLaunchContext = {
    modelDefinition: {
        id: string;
        name: string;
        api: string;
        baseUrl: string;
        [key: string]: unknown;
    };
    context: string;
    skills: string[];
};

export class RotomExecutions {
    readonly journal: RotomJournal;
    readonly #data: string;
    readonly #authorize: (
        binding: Readonly<KernelBinding>,
        operation: "admission" | "inference" | "refresh",
        sessionId: string,
    ) => Promise<KernelRequestAuth | void>;
    readonly #prepare?: (
        binding: Readonly<KernelBinding>,
        sessionId: string,
    ) => KernelLaunchContext;
    readonly #running = new Map<string, { aborted: boolean; kernel?: RotomRpc }>();
    #active = 0;
    constructor(
        data: string,
        authorize: (
            binding: Readonly<KernelBinding>,
            operation: "admission" | "inference" | "refresh",
            sessionId: string,
        ) => Promise<KernelRequestAuth | void>,
        prepare?: (binding: Readonly<KernelBinding>, sessionId: string) => KernelLaunchContext,
    ) {
        this.journal = new RotomJournal(data);
        this.#data = data;
        this.#authorize = authorize;
        this.#prepare = prepare;
    }

    async abort(sessionId: string): Promise<void> {
        const run = this.#running.get(sessionId);

        if (!run) {
            return;
        }

        run.aborted = true;

        if (run.kernel) {
            await run.kernel.request({ type: "abort" });
        }
    }

    async run(
        sessionId: string,
        requestId: string,
        prompt: string,
        onProvisionalEvent?: (event: RpcRecord) => void,
    ): Promise<KernelReceipt> {
        const binding = Object.freeze(this.journal.session(sessionId).binding);

        // Old receipts are returned, never fed to a new subprocess. Even unknown is a durable result of admission.
        await this.#authorize(binding, "admission", sessionId);
        const previous = this.journal.existing(sessionId, requestId, prompt);

        if (previous) {
            return previous;
        }

        if (!prompt.trim() || prompt.trimStart().startsWith("/")) {
            throw new Error(
                "Kernel execution requires ordinary prompt text; product commands are not team submissions",
            );
        }

        if (verifyRotomKernel().version !== binding.kernelVersion) {
            throw new Error("Kernel version differs from the immutable session binding");
        }

        const prepared = this.#prepare?.(binding, sessionId);
        const receipt = this.journal.reserve(sessionId, requestId, prompt);
        // Admission is asynchronous: an earlier request may have created the native file while it was pending.
        const session = this.journal.session(sessionId);

        this.#active++;
        const running: { aborted: boolean; kernel?: RotomRpc } = { aborted: false };

        this.#running.set(sessionId, running);
        let kernel: RotomRpc | undefined,
            closed = false;
        let failureStatus: "unknown" | "rejected" = "unknown";
        const token = randomBytes(32).toString("base64url");
        let gateFile: string | undefined;
        let contextFile: string | undefined;
        const gate = createServer(async (req, res) => {
            // The capability belongs to one attempt. Never accept a caller-supplied payer or session identity.
            const authorization = Buffer.from(String(req.headers.authorization ?? "")),
                expected = Buffer.from(`Bearer ${token}`);

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

                const value = JSON.parse(body);

                if (
                    !["inference", "refresh"].includes(value.operation) ||
                    value.provider !== binding.provider ||
                    (value.operation === "inference" && value.model !== binding.model)
                ) {
                    throw new Error("identity denied");
                }

                if (this.journal.receipt(receipt.id).status !== "dispatch-intent") {
                    throw new Error("attempt is not active");
                }

                if (running.aborted) {
                    throw new Error("execution stopped");
                }

                const auth = await this.#authorize(binding, value.operation, sessionId);

                if (
                    running.aborted ||
                    this.journal.receipt(receipt.id).status !== "dispatch-intent"
                ) {
                    throw new Error("attempt ended during authorization");
                }

                if (prepared && value.operation === "inference") {
                    if (!auth) {
                        throw new Error("No request auth");
                    }

                    const body = JSON.stringify(auth);

                    if (Buffer.byteLength(body) > 65536) {
                        throw new Error("Request auth is too large");
                    }

                    res.writeHead(200, {
                        "Content-Type": "application/json",
                        "Cache-Control": "no-store",
                    }).end(body);
                } else {
                    res.writeHead(204).end();
                }
            } catch {
                res.writeHead(403).end();
            }
        });

        try {
            gate.listen(0, "127.0.0.1");
            await once(gate, "listening");
            const folder = join(this.#data, "kernel-gates");

            mkdirSync(folder, { recursive: true, mode: 0o700 });

            if (
                realpathSync(folder) !== folder ||
                !lstatSync(folder).isDirectory() ||
                lstatSync(folder).mode & 0o077
            ) {
                throw new Error("Kernel gate directory must be canonical and private");
            }

            gateFile = join(folder, `${receipt.id}.json`);
            writeFileSync(
                gateFile,
                JSON.stringify({
                    url: `http://127.0.0.1:${(gate.address() as { port: number }).port}/authorize`,
                    token,
                    provider: binding.provider,
                    model: binding.model,
                    ...(prepared ? { modelDefinition: prepared.modelDefinition } : {}),
                }),
                { mode: 0o600, flag: "wx" },
            );

            if (prepared) {
                contextFile = `${gateFile}.context`;
                writeFileSync(contextFile, prepared.context, { mode: 0o600, flag: "wx" });
            }

            kernel = await startRotomKernel({
                ...binding,
                gateFile,
                sessionFile: session.sessionFile,
                configuration: prepared && { contextFile: contextFile!, skills: prepared.skills },
            });
            running.kernel = kernel;
            const state = (await kernel.request({ type: "get_state" })) as {
                sessionFile: string;
                sessionId: string;
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

            this.journal.attach(receipt.id, state.sessionFile, state.sessionId);
            // Recheck after startup/catalog work, immediately before sending the user request.
            await this.#authorize(binding, "admission", sessionId);

            if (onProvisionalEvent) {
                kernel.onEvent(onProvisionalEvent);
            }

            if (running.aborted) {
                throw new RpcFailure("rejected", "Stopped before prompt dispatch");
            }

            const disposition = await kernel.prompt(prompt);

            await kernel.close();
            closed = true;
            const entries =
                disposition === "handled" && !session.sessionFile && !existsSync(state.sessionFile)
                    ? []
                    : readNativeEntries(state.sessionFile, state.sessionId, binding.workspace);

            return this.journal.finish(receipt.id, disposition, entries);
        } catch (error) {
            // A rejection is known only if the kernel said so. Timeout, missing disk entries or process loss remain unknown.
            failureStatus =
                error instanceof RpcFailure && error.outcome === "rejected"
                    ? "rejected"
                    : "unknown";
        } finally {
            gate.closeAllConnections();
            await new Promise<void>((resolve) => gate.close(() => resolve()));

            // Keep the active lease and account reservation until child close is observed. A close failure must not release the writer lock.
            if (kernel && !closed) {
                try {
                    await kernel.close();
                } catch (error) {
                    this.journal.fail(receipt.id, "unknown");

                    throw error;
                }
            }

            if (gateFile) {
                rmSync(gateFile, { force: true });
            }

            if (contextFile) {
                rmSync(contextFile, { force: true });
            }

            this.#running.delete(sessionId);
            this.#active--;
        }

        const attached = this.journal.session(sessionId).sessionFile;
        const unmaterialized =
            failureStatus === "rejected" &&
            !session.sessionFile &&
            attached !== undefined &&
            !existsSync(attached);

        return this.journal.fail(receipt.id, failureStatus, unmaterialized);
    }

    close(): void {
        if (this.#active) {
            throw new Error("Kernel executions are still active; do not release the writer lock");
        }

        this.journal.close();
    }
}

function readNativeEntries(path: string, sessionId: string, workspace: string): KernelEntry[] {
    if (realpathSync(path) !== path) {
        throw new Error("Native session path changed");
    }

    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);

    try {
        const stat = fstatSync(fd);

        if (!stat.isFile() || stat.size > 32 * 1024 * 1024) {
            throw new Error("Native session requires a bounded streaming importer above 32 MiB");
        }

        const content = readFileSync(fd, "utf8");

        if (!content.endsWith("\n")) {
            throw new Error("Incomplete native session tail");
        }

        const entries: KernelEntry[] = content
            .trimEnd()
            .split("\n")
            .map((line) => JSON.parse(line));
        const header = entries[0];

        if (
            header?.type !== "session" ||
            header.version !== 3 ||
            header.id !== sessionId ||
            header.cwd !== workspace
        ) {
            throw new Error("Native session header mismatch");
        }

        const ids = new Set<string>();

        for (const entry of entries.slice(1)) {
            if (
                entry.type === "session" ||
                typeof entry.id !== "string" ||
                ids.has(entry.id) ||
                (entry.parentId !== null &&
                    (typeof entry.parentId !== "string" || !ids.has(entry.parentId)))
            ) {
                throw new Error("Native session tree is incomplete or inconsistent");
            }

            ids.add(entry.id);
        }

        return entries;
    } finally {
        closeSync(fd);
    }
}
