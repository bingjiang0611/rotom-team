/** Own retained native processes, authorization gates, warm starts and proven closure. */
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseWithWork } from "../perf-channels.ts";
import { teamResourceRevision } from "../rotom-resources.ts";
import { startRotomKernel, verifyRotomKernel } from "../rotom-kernel.ts";
import { RotomJournal, type AsyncRotomJournal, type KernelBinding } from "../rotom-journal.ts";
import type { RotomRpc } from "../rotom-rpc.ts";
import type {
    Authorize,
    Prepare,
    Running,
    PersistentKernel,
    Owned,
    KernelLaunchContext,
} from "./contracts.ts";

/** The most warm processes not used yet, over all members; each member has at most one. */
const WARM_TOTAL = 3;
/** A warm process no request used retires after this long. */
const WARM_UNUSED_MS = 5 * 60_000;

export class NativeProcesses {
    readonly kernels = new Map<string, PersistentKernel>();
    readonly #unused = new Map<
        string,
        { sessionId: string; binding: Readonly<KernelBinding>; timer: NodeJS.Timeout }
    >();
    /** Warm starts on their way, by segment. A request for that segment waits for its start instead of a second. */
    readonly warming = new Map<string, { memberId: string; done: Promise<boolean> }>();
    #closing = false;

    readonly data: string;
    readonly journal: AsyncRotomJournal;
    readonly authorize: Authorize;
    readonly prepare: Prepare | undefined;
    readonly running: Map<string, Set<Running>>;

    constructor(
        data: string,
        journal: AsyncRotomJournal,
        authorize: Authorize,
        prepare: Prepare | undefined,
        running: Map<string, Set<Running>>,
    ) {
        this.data = data;
        this.journal = journal;
        this.authorize = authorize;
        this.prepare = prepare;
        this.running = running;
    }

    /**
     * Start a native process for `binding` on its session, with its own spending gate: the gate admits a request only
     * for `gateState.active`, so a process started with nothing active can spend nothing. `owned` holds each resource
     * as it is made, for the caller to close should this fail. Not entered in `#kernels`: the caller does that.
     */
    async launch(
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
        const token = randomBytes(32).toString("base64url");
        const gate = createServer(async (req, res) => {
            // This process has one immutable binding; only the currently active receipt may spend.
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

                const value = parseWithWork("native-gate", body);

                const active = gateState.active;

                if (!active || active.operation === "discover") {
                    throw new Error("No active inference receipt");
                }

                if (
                    !["inference", "refresh", "usage"].includes(value.operation) ||
                    value.provider !== binding.provider ||
                    (value.operation !== "refresh" && value.model !== binding.model)
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
                        this.journal.childUsage(active.receipt.id, value.usage),
                    );
                    await active.usageWrites;
                    res.writeHead(204).end();

                    return;
                }

                if ((await this.journal.receipt(active.receipt.id)).status !== "dispatch-intent") {
                    throw new Error("attempt is not active");
                }

                if (active.running.aborted) {
                    throw new Error("execution stopped");
                }

                const auth = await this.authorize(binding, value.operation, sessionId);

                // No journal await after authorization: that would reopen a revocation/Stop window.
                // This owner clears active before every finish/fail, so the latch also fences settlement.
                if (active.running.aborted || gateState.active !== active) {
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
        const folder = join(this.data, "kernel-gates");

        mkdirSync(folder, { recursive: true, mode: 0o700 });

        if (
            realpathSync(folder) !== folder ||
            !lstatSync(folder).isDirectory() ||
            lstatSync(folder).mode & 0o077
        ) {
            throw new Error("Kernel gate directory must be canonical and private");
        }

        const gateFile = join(folder, `${name}.json`);

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
            thinkingLevel: await this.journal.thinkingLevel(sessionId),
            teamAgentDir: join(this.data, "team-agent"),
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
            state,
        };
    }

    /**
     * Start session `sessionId`'s native process before its member sends, so the send finds it ready. Only for an idle
     * session on the pinned kernel, after the same admission checks as a send, and only one unused warm process per
     * member and `WARM_TOTAL` in all: a member's warm process for another session is retired for this one. The process
     * gets its own spending gate with nothing active, so it can spend nothing until a request is admitted. Unused, it
     * retires after `WARM_UNUSED_MS`. Resolves to whether the session has a process now; never throws.
     */
    async warm(sessionId: string): Promise<boolean> {
        try {
            const admitted = await this.journal.session(sessionId);
            const segmentId = admitted.segmentId;
            const memberId = admitted.binding.memberId;
            const pending = this.warming.get(segmentId);

            if (pending) {
                return await pending.done;
            }

            if (this.kernels.has(segmentId)) {
                return true;
            }

            if (
                this.#closing ||
                (this.running.get(sessionId)?.size ?? 0) > 0 ||
                verifyRotomKernel().version !== admitted.binding.kernelVersion
            ) {
                return false;
            }

            for (const [other, each] of this.#unused) {
                if (each.binding.memberId === memberId) {
                    await this.#retireUnused(other);
                }
            }

            // Checked again after that wait, with nothing awaited from here until this start is in `#warming`: a send
            // that began meanwhile keeps its own start, and one that begins later waits for this one.
            if (
                this.#closing ||
                this.warming.has(segmentId) ||
                this.kernels.has(segmentId) ||
                (this.running.get(sessionId)?.size ?? 0) > 0 ||
                [...this.warming.values()].some((each) => each.memberId === memberId) ||
                this.#unused.size + this.warming.size >= WARM_TOTAL
            ) {
                return false;
            }

            const done = this.#warmStart(sessionId, admitted).finally(() =>
                this.warming.delete(segmentId),
            );

            this.warming.set(segmentId, { memberId, done });

            return await done;
        } catch {
            return false;
        }
    }

    async #warmStart(
        sessionId: string,
        admitted: ReturnType<RotomJournal["session"]>,
    ): Promise<boolean> {
        const binding = Object.freeze(admitted.binding);
        const owned: Owned = {};

        try {
            await this.authorize(binding, "admission", sessionId);
            const prepared = this.prepare?.(binding, sessionId);
            const revision = teamResourceRevision(join(this.data, "team-agent"), binding.workspace);
            const persistent = await this.launch(
                binding,
                sessionId,
                (await this.journal.session(sessionId)).sessionFile,
                prepared,
                {},
                `warm-${randomUUID()}`,
                revision,
                owned,
            );

            // Admission checks awaited; the session must still be where it was. A request that came meanwhile waits
            // for this start (`#execute`), and takes this process.
            if (
                this.#closing ||
                (await this.journal.session(sessionId)).segmentId !== admitted.segmentId ||
                this.kernels.has(admitted.segmentId)
            ) {
                throw new Error("The session moved on while its process started");
            }

            this.kernels.set(admitted.segmentId, persistent);
            const timer = setTimeout(
                () => void this.#retireUnused(admitted.segmentId).catch(() => {}),
                WARM_UNUSED_MS,
            );

            timer.unref();
            this.#unused.set(admitted.segmentId, { sessionId, binding, timer });

            return true;
        } catch {
            owned.gate?.closeAllConnections();
            await new Promise<void>((resolve) => owned.gate?.close(() => resolve()) ?? resolve());
            await owned.kernel?.close().catch(() => {});

            for (const file of [owned.gateFile, owned.contextFile]) {
                if (file) {
                    rmSync(file, { force: true });
                }
            }

            return false;
        }
    }

    /** A request took this segment's process: it is no longer a warm process waiting to be used. */
    used(segmentId: string): void {
        clearTimeout(this.#unused.get(segmentId)?.timer);
        this.#unused.delete(segmentId);
    }

    /** Retire this segment's warm process if no request has used it; it leaves `#kernels` before it closes. */
    async #retireUnused(segmentId: string): Promise<void> {
        if (!this.#unused.has(segmentId)) {
            return;
        }

        // Out of `#kernels` at once, before any wait: no request may take a process that is closing.
        const persistent = this.kernels.get(segmentId);

        this.used(segmentId);
        this.kernels.delete(segmentId);

        if (persistent) {
            await this.#close(persistent);
        }
    }

    /** The warm processes no request has used yet: their segment, session and binding. */
    unusedWarm(): { segmentId: string; sessionId: string; binding: Readonly<KernelBinding> }[] {
        return [...this.#unused].map(([segmentId, { sessionId, binding }]) => ({
            segmentId,
            sessionId,
            binding,
        }));
    }

    /** Retire this segment's warm process, should no request have used it yet. */
    retireUnused(segmentId: string): Promise<void> {
        return this.#retireUnused(segmentId);
    }

    /** Retire every warm process of `memberId` no request has used: their account changed. */
    async retireUnusedOf(memberId: string): Promise<void> {
        for (const { segmentId, binding } of this.unusedWarm()) {
            if (binding.memberId === memberId) {
                await this.#retireUnused(segmentId);
            }
        }
    }

    async retire(segmentId: string): Promise<void> {
        // A warm start on its way finishes first, so what it started is retired too.
        await this.warming.get(segmentId)?.done;
        this.used(segmentId);
        const persistent = this.kernels.get(segmentId);

        if (!persistent) {
            return;
        }

        persistent.gateState.active = undefined;
        persistent.gate.closeAllConnections();
        await new Promise<void>((resolve) => persistent.gate.close(() => resolve()));

        await persistent.kernel.close();
        this.kernels.delete(segmentId);
        rmSync(persistent.gateFile, { force: true });

        if (persistent.contextFile) {
            rmSync(persistent.contextFile, { force: true });
        }
    }

    /** Close a process already out of `#kernels`, and its gate and files. */
    async #close(persistent: PersistentKernel): Promise<void> {
        persistent.gateState.active = undefined;
        persistent.gate.closeAllConnections();
        await new Promise<void>((resolve) => persistent.gate.close(() => resolve()));
        await persistent.kernel.close();
        rmSync(persistent.gateFile, { force: true });

        if (persistent.contextFile) {
            rmSync(persistent.contextFile, { force: true });
        }
    }

    close(): Promise<void> {
        this.#closing = true;

        return (async () => {
            await Promise.all([...this.warming.values()].map((each) => each.done));

            for (const segmentId of [...this.kernels.keys()]) {
                await this.retire(segmentId);
            }

            await this.journal.close();
        })();
    }
}
