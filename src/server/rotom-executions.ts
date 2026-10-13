/** Non-replayable team-owned execution journal around the real rotom loop. Not a model-provider adapter. */
import { createServer } from "node:http";
import type { ImageContent } from "@earendil-works/pi-ai";
import { once } from "node:events";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
    constants,
    closeSync,
    chmodSync,
    fsyncSync,
    fstatSync,
    existsSync,
    lstatSync,
    mkdirSync,
    openSync,
    readSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
    RotomJournal,
    KernelRequestConflict,
    type KernelBinding,
    type KernelEntry,
    type KernelReceipt,
} from "./rotom-journal.ts";
import { startRotomKernel, verifyRotomKernel, nativeSessionManager } from "./rotom-kernel.ts";
import { publicNativeHistory } from "./rotom-history.ts";
import { type RotomRpc, type RpcRecord, RpcFailure } from "./rotom-rpc.ts";

export type QoderRequestAuth = {
    credential: {
        accessToken: string;
        fingerprint: string;
        expiresAt: number;
        uid: string | number;
        org: string | number;
        machineId: string;
    };
    catalog: { scope: string; checkedAt: number; metadata: unknown };
};

export type KernelRequestAuth = {
    qoder?: QoderRequestAuth;
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
    /** A legacy frozen snapshot; absent: rotom loads the project's and the member's own layers natively. */
    frozen?: { context: string; skills: string[] };
};

/**
 * Text a member may send to Pi: ordinary words, or `/skill:name …`, which the kernel expands into that skill's
 * instructions. Other slash commands run in the kernel instead of reaching the model, outside the run's journal.
 */
export function isTeamPrompt(text: string): boolean {
    return text.trim() !== "" && (!text.trimStart().startsWith("/") || /^\/skill:\S/.test(text));
}

/** Text-only receipts keep their existing identity; image bytes are part of request identity. */
export function nativePromptIdentity(text: string, images: ImageContent[] = []): string {
    return images.length === 0 ? text : JSON.stringify({ text, images });
}

/** A screenshot-bearing tool result can be large; a single record above this is refused, not truncated. */
const NATIVE_LINE_LIMIT = 64 * 1024 * 1024;

/** Observers of one prompt: none may change its outcome, and a failing observer cannot authorize work. */
export type RunHooks = {
    /** The intent is durably committed: the request can no longer be lost, only end unknown. */
    onReserved?: (receipt: KernelReceipt) => void | Promise<void>;
    /** Every kernel event, for provisional display only. */
    onEvent?: (event: RpcRecord) => void;
    /** New persisted entries were journaled mid-run. */
    onProgress?: () => void;
};

type Running = {
    aborted: boolean;
    kernel?: RotomRpc;
    closureUnknown?: boolean;
    /** Its prompt was dispatched: messages may join it. */
    prompting?: boolean;
};

export class RotomExecutions {
    readonly journal: RotomJournal;
    readonly #data: string;
    readonly #authorize: (
        binding: Readonly<KernelBinding>,
        operation: "admission" | "inference" | "refresh" | "fork",
        sessionId: string,
    ) => Promise<KernelRequestAuth | void>;
    readonly #prepare?: (
        binding: Readonly<KernelBinding>,
        sessionId: string,
    ) => KernelLaunchContext;
    readonly #running = new Map<string, Set<Running>>();
    #active = 0;
    constructor(
        data: string,
        authorize: (
            binding: Readonly<KernelBinding>,
            operation: "admission" | "inference" | "refresh" | "fork",
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
        await Promise.all(
            [...(this.#running.get(sessionId) ?? [])].map(async (run) => {
                run.aborted = true;

                if (run.kernel) {
                    await run.kernel.abort();
                }
            }),
        );
    }

    /** Add a message to the session's running prompt. False when none is running. */
    async queue(
        sessionId: string,
        text: string,
        mode: "steer" | "followUp",
        images: ImageContent[] = [],
    ): Promise<boolean> {
        for (const run of this.#running.get(sessionId) ?? []) {
            if (run.prompting && run.kernel) {
                await run.kernel.queue(text, mode, images);

                return true;
            }
        }

        return false;
    }

    /** Answer an extension dialog of the session's running prompt. False when no run is waiting for it. */
    answer(
        sessionId: string,
        dialogId: string,
        response: Parameters<RotomRpc["answer"]>[1],
    ): boolean {
        return [...(this.#running.get(sessionId) ?? [])].some(
            (run) => run.kernel?.answer(dialogId, response) ?? false,
        );
    }

    async #track(
        sessionId: string,
        action: (running: Running) => Promise<KernelReceipt>,
    ): Promise<KernelReceipt> {
        const running: Running = { aborted: false };
        const runs = this.#running.get(sessionId) ?? new Set<Running>();

        runs.add(running);
        this.#running.set(sessionId, runs);
        this.#active++;

        try {
            return await action(running);
        } finally {
            // Failure to prove child closure must retain the writer lease, even after the caller rejects.
            if (!running.closureUnknown) {
                runs.delete(running);

                if (!runs.size) {
                    this.#running.delete(sessionId);
                }

                this.#active--;
            }
        }
    }

    #notStopped(running: Running): void {
        if (running.aborted) {
            throw new KernelRequestConflict("Stopped before native dispatch or materialization");
        }
    }

    async handoff(
        sessionId: string,
        requestId: string,
        expectedHead: string,
        binding: KernelBinding,
    ): Promise<KernelReceipt> {
        return this.#track(sessionId, async (running) => {
            await this.#authorize(binding, "admission", sessionId);
            this.#notStopped(running);

            if (verifyRotomKernel().version !== binding.kernelVersion) {
                throw new Error("Kernel version differs from the immutable session binding");
            }

            this.#prepare?.(binding, sessionId);
            const native = await nativeSessionManager();

            this.#notStopped(running);

            if (this.journal.request(sessionId, requestId)) {
                return this.journal.handoff(sessionId, requestId, expectedHead, binding);
            }

            if (this.journal.session(sessionId).segmentId !== expectedHead) {
                throw new KernelRequestConflict(
                    "Conversation head changed; refresh before handoff",
                );
            }

            const messages = publicNativeHistory(
                native.buildSessionProjection(this.journal.segmentEntries(expectedHead)).messages,
            );
            // No await between projection and intent/CAS; an existing intent is never replayed.
            const receipt = this.journal.handoff(sessionId, requestId, expectedHead, binding);

            return this.#seed(receipt, messages, native.SessionManager, running);
        });
    }

    async fork(
        sourceId: string,
        sessionId: string,
        requestId: string,
        expectedHead: string,
    ): Promise<KernelReceipt> {
        return this.#track(sessionId, async (running) => {
            if (sourceId === sessionId) {
                throw new KernelRequestConflict("Fork requires an independent target conversation");
            }

            const binding = this.journal.session(sessionId).binding;

            const authorize = async () => {
                await this.#authorize(binding, "fork", sourceId);
                await this.#authorize(binding, "fork", sessionId);
                this.#prepare?.(binding, sessionId);
            };

            await authorize();
            this.#notStopped(running);
            const identity = JSON.stringify({ sourceId, expectedHead });
            const existing = this.journal.existing(sessionId, requestId, identity, "fork");

            if (existing) {
                return existing;
            }

            if (verifyRotomKernel().version !== binding.kernelVersion) {
                throw new Error("Kernel version differs from the immutable session binding");
            }

            const native = await nativeSessionManager();

            this.#notStopped(running);
            const prior = this.journal.existing(sessionId, requestId, identity, "fork");

            if (prior) {
                return prior;
            }

            if (this.journal.session(sourceId).segmentId !== expectedHead) {
                throw new KernelRequestConflict("Source head changed; refresh before fork");
            }

            if (this.journal.pendingConversation(sourceId)) {
                throw new KernelRequestConflict(
                    "Source operation is active or unknown; reconcile before fork",
                );
            }

            const messages = publicNativeHistory(
                native.buildSessionProjection(this.journal.segmentEntries(expectedHead)).messages,
            );
            const receipt = this.journal.reserve(sessionId, requestId, identity, "fork");

            return this.#seed(receipt, messages, native.SessionManager, running, authorize);
        });
    }

    async #seed(
        receipt: KernelReceipt,
        messages: ReturnType<typeof publicNativeHistory>,
        SessionManager: Awaited<ReturnType<typeof nativeSessionManager>>["SessionManager"],
        running: Running,
        authorize = () => this.#authorize(receipt.binding, "admission", receipt.sessionId),
    ): Promise<KernelReceipt> {
        let materializing = false;

        try {
            await authorize();

            if (running.aborted) {
                throw new Error("Seed stopped before materialization");
            }

            let entries: KernelEntry[] = [];

            if (messages.length) {
                materializing = true;
                // Native Pi may create its sessions container as 0755 inside the private HOME.
                // Own a private seed subdirectory rather than changing or trusting that container's mode.
                const folder = join(receipt.binding.home, ".pi/agent/sessions/team-seeds");

                mkdirSync(folder, { recursive: true, mode: 0o700 });

                if (realpathSync(folder) !== folder || lstatSync(folder).mode & 0o077) {
                    throw new Error("Native seed directory must be canonical and private");
                }

                const session = SessionManager.create(receipt.binding.workspace, folder);

                // Attach the intended file before appending; an interrupted partial seed remains inspectable.
                this.journal.attach(receipt.id, session.getSessionFile(), session.getSessionId());

                for (const message of messages) {
                    session.appendMessage(message);
                }

                const path = session.getSessionFile();

                chmodSync(path, 0o600);

                for (const pathToSync of [path, folder]) {
                    const fd = openSync(pathToSync, constants.O_RDONLY | constants.O_NOFOLLOW);

                    try {
                        fsyncSync(fd);
                    } finally {
                        closeSync(fd);
                    }
                }

                entries = readNativeEntries(
                    path,
                    session.getSessionId(),
                    receipt.binding.workspace,
                );
                const persisted = entries
                    .filter((entry) => entry.type === "message")
                    .map((entry) => entry.message);

                if (JSON.stringify(persisted) !== JSON.stringify(messages)) {
                    throw new Error("Native seed readback mismatch");
                }
            }

            await authorize();

            if (running.aborted) {
                throw new Error("Seed stopped before commit");
            }

            return this.journal.finish(receipt.id, "settled", entries);
        } catch {
            return this.journal.fail(receipt.id, materializing ? "unknown" : "rejected");
        }
    }

    run(
        sessionId: string,
        requestId: string,
        prompt: string,
        hooks: RunHooks = {},
        images: ImageContent[] = [],
    ): Promise<KernelReceipt> {
        return this.#track(sessionId, (running) =>
            this.#execute(sessionId, requestId, prompt, "prompt", running, hooks, images),
        );
    }

    compact(sessionId: string, requestId: string, instructions = ""): Promise<KernelReceipt> {
        return this.#track(sessionId, (running) =>
            this.#execute(sessionId, requestId, instructions, "compact", running),
        );
    }

    async #execute(
        sessionId: string,
        requestId: string,
        prompt: string,
        operation: "prompt" | "compact",
        running: Running,
        hooks: RunHooks = {},
        images: ImageContent[] = [],
    ): Promise<KernelReceipt> {
        const identity = nativePromptIdentity(prompt, images);
        const admitted = this.journal.session(sessionId);
        const binding = Object.freeze(admitted.binding);

        // Old receipts are returned, never fed to a new subprocess. Even unknown is a durable result of admission.
        await this.#authorize(binding, "admission", sessionId);
        const previous = this.journal.existing(sessionId, requestId, identity, operation);

        if (previous) {
            return previous;
        }

        this.#notStopped(running);

        if (operation === "prompt" && !isTeamPrompt(prompt)) {
            throw new Error(
                "Kernel execution requires ordinary prompt text; product commands are not team submissions",
            );
        }

        // Authorization awaited user/account state. A concurrent completed handoff must not
        // reserve the new payer while launching this previously admitted binding.
        if (this.journal.session(sessionId).segmentId !== admitted.segmentId) {
            throw new KernelRequestConflict("Conversation head changed during admission");
        }

        if (verifyRotomKernel().version !== binding.kernelVersion) {
            throw new Error("Kernel version differs from the immutable session binding");
        }

        const prepared = this.#prepare?.(binding, sessionId);
        const receipt = this.journal.reserve(sessionId, requestId, identity, operation);

        await hooks.onReserved?.(receipt);
        // Admission is asynchronous: an earlier request may have created the native file while it was pending.
        const session = this.journal.session(sessionId);

        let kernel: RotomRpc | undefined,
            closed = false;
        let failureStatus: "unknown" | "rejected" = "unknown";
        const token = randomBytes(32).toString("base64url");
        let gateFile: string | undefined;
        let contextFile: string | undefined;
        let inferenceAdmitted = false;
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
                    !["inference", "refresh", "usage"].includes(value.operation) ||
                    value.provider !== binding.provider ||
                    (value.operation !== "refresh" && value.model !== binding.model)
                ) {
                    throw new Error("identity denied");
                }

                if (this.journal.receipt(receipt.id).status !== "dispatch-intent") {
                    throw new Error("attempt is not active");
                }

                // A subagent's response: its entries stay in its own session, so the gate records what it spent.
                if (value.operation === "usage") {
                    if (!value.usage || typeof value.usage !== "object") {
                        throw new Error("usage must be an object");
                    }

                    this.journal.childUsage(receipt.id, value.usage);
                    res.writeHead(204).end();

                    return;
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

                    inferenceAdmitted = true;
                    res.writeHead(200, {
                        "Content-Type": "application/json",
                        "Cache-Control": "no-store",
                    }).end(body);
                } else {
                    if (value.operation === "inference") {
                        inferenceAdmitted = true;
                    }

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

            if (prepared?.frozen) {
                contextFile = `${gateFile}.context`;
                writeFileSync(contextFile, prepared.frozen.context, { mode: 0o600, flag: "wx" });
            }

            this.#notStopped(running);
            kernel = await startRotomKernel({
                ...binding,
                gateFile,
                sessionFile: session.sessionFile,
                configuration: prepared?.frozen && {
                    contextFile: contextFile!,
                    skills: prepared.frozen.skills,
                },
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

            this.journal.attach(receipt.id, state.sessionFile, state.sessionId, kernel.pid);
            // Recheck after startup/catalog work, immediately before sending the user request.
            await this.#authorize(binding, "admission", sessionId);

            const tail = new NativeTail(state.sessionFile, state.sessionId, binding.workspace);
            let progressFailure: unknown;

            if (hooks.onEvent) {
                kernel.onEvent(hooks.onEvent);
                // Someone watches this run, so its dialogs (ask_user_question, permissions) can reach a person.
                kernel.forwardDialogs();
            }

            // Message-level durability: each persisted message is journaled as it lands, so a restart loses at most
            // the message in flight. The final snapshot below remains the authority for the outcome.
            kernel.onEvent((event) => {
                if (
                    event.type !== "message_end" ||
                    operation !== "prompt" ||
                    progressFailure !== undefined ||
                    !existsSync(state.sessionFile)
                ) {
                    return;
                }

                try {
                    if (this.journal.progress(receipt.id, tail.read()) > 0) {
                        hooks.onProgress?.();
                    }
                } catch (error) {
                    progressFailure = error;
                }
            });

            if (running.aborted) {
                throw new RpcFailure("rejected", "Stopped before prompt dispatch");
            }

            let disposition: "settled" | "handled";

            if (operation === "compact") {
                await kernel.compact(prompt);
                disposition = "settled";
            } else {
                running.prompting = true;
                disposition = await kernel.prompt(prompt, undefined, images);
            }

            await kernel.close();
            closed = true;

            if (progressFailure !== undefined) {
                throw progressFailure;
            }

            let entries: KernelEntry[];

            if (disposition === "handled") {
                // An extension-handled prompt may never create JSONL; its snapshot decides whether a binding exists.
                entries =
                    !session.sessionFile && !existsSync(state.sessionFile)
                        ? []
                        : readNativeEntries(state.sessionFile, state.sessionId, binding.workspace);
            } else {
                entries = tail.read();

                if (!tail.complete) {
                    throw new Error("Incomplete native session tail");
                }
            }

            const finished = this.journal.finish(receipt.id, disposition, entries);

            hooks.onProgress?.();

            return finished;
        } catch (error) {
            // A rejection is known only if the kernel said so. Timeout, missing disk entries or process loss remain unknown.
            failureStatus =
                ((error instanceof RpcFailure && error.outcome === "rejected") ||
                    error instanceof KernelRequestConflict) &&
                !inferenceAdmitted
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
                    running.closureUnknown = true;
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

/** One complete snapshot of a native session file. */
function readNativeEntries(path: string, sessionId: string, workspace: string): KernelEntry[] {
    const tail = new NativeTail(path, sessionId, workspace);
    const entries = tail.read();

    if (!tail.complete) {
        throw new Error("Incomplete native session tail");
    }

    return entries;
}

/**
 * Reads an append-only native session file incrementally: complete lines only, each checked once against the header
 * and the entry tree. A file that shrinks or a malformed line fails; a partial last line waits for the next read.
 */
export class NativeTail {
    readonly #path: string;
    readonly #sessionId: string;
    readonly #workspace: string;
    readonly #ids = new Set<string>();
    #offset = 0;
    #pending = Buffer.alloc(0);
    #header = false;
    constructor(path: string, sessionId: string, workspace: string) {
        this.#path = path;
        this.#sessionId = sessionId;
        this.#workspace = workspace;
    }

    /** True when the last read ended exactly at a line break. */
    get complete(): boolean {
        return this.#header && this.#pending.length === 0;
    }

    read(): KernelEntry[] {
        if (realpathSync(this.#path) !== this.#path) {
            throw new Error("Native session path changed");
        }

        const fd = openSync(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const chunks: Buffer[] = [this.#pending];

        try {
            const stat = fstatSync(fd);

            if (!stat.isFile() || stat.size < this.#offset) {
                throw new Error("Native session file was replaced or truncated");
            }

            while (this.#offset < stat.size) {
                const chunk = Buffer.alloc(Math.min(stat.size - this.#offset, 1024 * 1024));
                const read = readSync(fd, chunk, 0, chunk.length, this.#offset);

                if (read === 0) {
                    break;
                }

                chunks.push(chunk.subarray(0, read));
                this.#offset += read;
            }
        } finally {
            closeSync(fd);
        }

        const buffer = Buffer.concat(chunks);
        const end = buffer.lastIndexOf(0x0a) + 1;

        this.#pending = buffer.subarray(end);

        if (this.#pending.length > NATIVE_LINE_LIMIT) {
            throw new Error("Native session line exceeds the import bound");
        }

        const entries: KernelEntry[] = [];

        for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) {
            if (line === "") {
                continue;
            }

            const entry = JSON.parse(line) as KernelEntry;

            if (!this.#header) {
                if (
                    entry.type !== "session" ||
                    entry.version !== 3 ||
                    entry.id !== this.#sessionId ||
                    entry.cwd !== this.#workspace
                ) {
                    throw new Error("Native session header mismatch");
                }

                this.#header = true;
                entries.push(entry);
                continue;
            }

            if (
                entry.type === "session" ||
                typeof entry.id !== "string" ||
                this.#ids.has(entry.id) ||
                (entry.parentId !== null &&
                    (typeof entry.parentId !== "string" || !this.#ids.has(entry.parentId)))
            ) {
                throw new Error("Native session tree is incomplete or inconsistent");
            }

            this.#ids.add(entry.id);
            entries.push(entry);
        }

        return entries;
    }
}
