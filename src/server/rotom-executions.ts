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
import {
    nativeBuiltinCommands,
    startRotomKernel,
    verifyRotomKernel,
    nativeSessionManager,
} from "./rotom-kernel.ts";
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
export function nativeCommandName(text: string): string | undefined {
    return /^\/([^\s]+)(?:\s|$)/.exec(text.trimStart())?.[1];
}

/** Native extension dispatch requires `/` at byte zero and a literal space before arguments. */
export function normalizeNativePrompt(text: string): string {
    return text.trimStart().startsWith("/") ? text.trimStart().replace(/^(\/\S+)\s+/, "$1 ") : text;
}

export function nativeCommandArgs(text: string): string {
    const normalized = normalizeNativePrompt(text);
    const name = nativeCommandName(normalized);

    return name === undefined ? "" : normalized.slice(name.length + 1).trim();
}

export function isKnownNativeCommand(
    text: string,
    commands: ReadonlyArray<{ name?: unknown }>,
): boolean {
    if (!text.trimStart().startsWith("/")) {
        return true;
    }

    const name = nativeCommandName(text);

    return (
        name !== undefined &&
        commands.some((command) => command.name === name && !name.startsWith("team-kernel-"))
    );
}

export function isTeamPrompt(text: string): boolean {
    const trimmed = text.trim();

    // Native commands are admitted here and validated against the runtime registry after the
    // team journal has reserved the attempt. This keeps an unknown slash from becoming model text.
    return trimmed !== "" && (!trimmed.startsWith("/") || nativeCommandName(trimmed) !== undefined);
}

/** Slash handlers are not restartable prompts until native discovery proves a prompt/skill expansion. */
export function nativePromptOperation(text: string): "prompt" | "command" {
    return text.trimStart().startsWith("/") ? "command" : "prompt";
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
    /** A native dynamic slash name has passed runtime registry validation. */
    onCommandAdmitted?: () => void | Promise<void>;
    /** Every kernel event, for provisional display only. */
    onEvent?: (event: RpcRecord) => void;
    /** The registry captured from this authorized kernel process. */
    onCommands?: (commands: Array<Record<string, unknown>>) => void;
    /** Canonical Goal state read from the current native branch after a handled barrier. */
    onNativeGoalState?: (state: unknown) => void;
    /** Team title after reservation; native handoff seeds do not carry session metadata. */
    sessionName?: () => string | undefined;
    onSessionName?: (name: string) => Promise<void>;
    /** Result from a structured native command adapter. */
    onNativeResult?: (result: unknown) => void | Promise<void>;
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

function goalIsActive(value: unknown): boolean {
    if (!value || typeof value !== "object") {
        return false;
    }

    const goal = (value as { goal?: unknown }).goal;

    return (
        goal !== null &&
        typeof goal === "object" &&
        ["active", "queued"].includes(String((goal as { status?: unknown }).status))
    );
}

export function currentBranchGoalState(value: unknown): unknown {
    if (!value || typeof value !== "object") {
        return undefined;
    }

    const data = value as { entries?: unknown; leafId?: unknown };

    if (!Array.isArray(data.entries) || typeof data.leafId !== "string") {
        return undefined;
    }

    const byId = new Map<
        string,
        { id?: unknown; parentId?: unknown; customType?: unknown; data?: unknown }
    >();

    for (const entry of data.entries) {
        if (entry && typeof entry === "object") {
            const item = entry as {
                id?: unknown;
                parentId?: unknown;
                customType?: unknown;
                data?: unknown;
            };

            if (typeof item.id === "string") {
                byId.set(item.id, item);
            }
        }
    }

    const branch: Array<{
        id?: unknown;
        parentId?: unknown;
        customType?: unknown;
        data?: unknown;
    }> = [];
    let id: string | undefined = data.leafId;

    while (id !== undefined) {
        const entry = byId.get(id);

        if (!entry) {
            break;
        }

        branch.push(entry);
        id = typeof entry.parentId === "string" ? entry.parentId : undefined;
    }

    return branch.find((entry) => entry.customType === "goal-state")?.data;
}

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
                const slash = text.trimStart().startsWith("/");
                const name = nativeCommandName(text);

                const queueInput = async () => {
                    const goal = currentBranchGoalState(
                        await run.kernel!.request({ type: "get_entries" }),
                    );

                    if (goalIsActive(goal)) {
                        await run.kernel!.wake(normalizeNativePrompt(text), images, mode);
                    } else {
                        await run.kernel!.queue(normalizeNativePrompt(text), mode, images);
                    }
                };

                if (slash) {
                    const catalog = (await run.kernel.request({ type: "get_commands" })) as {
                        commands?: Array<{ name?: unknown; source?: unknown }>;
                    };
                    const builtins = await nativeBuiltinCommands();
                    const dynamic = catalog.commands ?? [];

                    if (!isKnownNativeCommand(text, [...dynamic, ...builtins])) {
                        throw new RpcFailure("rejected", `Unknown native command: /${name ?? ""}`);
                    }

                    if (builtins.some((command) => command.name === name)) {
                        throw new RpcFailure(
                            "rejected",
                            "Native builtin commands require the Team command adapter; they cannot mutate an active run",
                        );
                    }

                    const source = dynamic.find((command) => command.name === name)?.source;

                    if (source === "prompt" || source === "skill") {
                        await queueInput();

                        return true;
                    }

                    let extensionError: RpcRecord | undefined;
                    const detach = run.kernel.onEvent((event) => {
                        if (event.type === "extension_error") {
                            extensionError = event;
                        }
                    });

                    try {
                        await run.kernel.command(normalizeNativePrompt(text));
                        await run.kernel.barrier();
                    } finally {
                        detach();
                    }

                    if (extensionError) {
                        throw new RpcFailure(
                            "unknown",
                            `Native extension command failed: ${String(extensionError.error ?? "unknown error")}`,
                        );
                    }

                    return true;
                }

                await queueInput();

                return true;
            }
        }

        return false;
    }

    /** Wake the current workflow through native prompt admission, retaining its receipt and payer. */
    async wake(sessionId: string, text: string, images: ImageContent[] = []): Promise<boolean> {
        for (const run of this.#running.get(sessionId) ?? []) {
            if (run.prompting && run.kernel) {
                await run.kernel.wake(normalizeNativePrompt(text), images);

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
        entryId?: string,
        clone = false,
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
            const identity = JSON.stringify({
                sourceId,
                expectedHead,
                ...(entryId ? { entryId } : {}),
                ...(clone ? { clone: true } : {}),
            });
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

            const entries = this.journal.segmentEntries(expectedHead);
            const selected = entryId ? entries.find((entry) => entry.id === entryId) : undefined;

            if (
                entryId &&
                (!selected ||
                    selected.type !== "message" ||
                    (selected.message as { role?: unknown } | undefined)?.role !== "user")
            ) {
                throw new KernelRequestConflict(
                    "Fork requires a selected user message in this segment",
                );
            }

            const messages = publicNativeHistory(
                native.buildSessionProjection(entries, selected ? selected.parentId : undefined)
                    .messages,
            );
            const receipt = this.journal.reserve(sessionId, requestId, identity, "fork");

            const source = this.journal.segment(expectedHead);

            if (clone && source.binding.memberId === binding.memberId && source.sessionFile) {
                let materializing = false;

                try {
                    const folder = join(binding.home, ".pi/agent/sessions/team-seeds");

                    mkdirSync(folder, { recursive: true, mode: 0o700 });

                    if (realpathSync(folder) !== folder || lstatSync(folder).mode & 0o077) {
                        throw new Error("Native clone directory must be canonical and private");
                    }

                    const manager = native.SessionManager.open(source.sessionFile, folder);
                    const leafId = manager.getLeafId();

                    if (!leafId) {
                        throw new Error("Native clone requires a current entry");
                    }

                    materializing = true;
                    const path = manager.createBranchedSession(leafId);

                    this.journal.attach(receipt.id, path, manager.getSessionId());
                    chmodSync(path, 0o600);
                    const entries = readNativeEntries(
                        path,
                        manager.getSessionId(),
                        binding.workspace,
                    );

                    await authorize();
                    this.#notStopped(running);

                    return this.journal.finish(receipt.id, "settled", entries);
                } catch {
                    return this.journal.fail(receipt.id, materializing ? "unknown" : "rejected");
                }
            }

            return this.#seed(receipt, messages, native.SessionManager, running, authorize);
        });
    }

    /** Import foreign history through the existing public-history seed boundary. */
    async importHistory(
        sessionId: string,
        requestId: string,
        identity: string,
        entries: KernelEntry[],
    ): Promise<KernelReceipt> {
        return this.#track(sessionId, async (running) => {
            const binding = this.journal.session(sessionId).binding;

            const authorize = () => this.#authorize(binding, "fork", sessionId);

            await authorize();
            this.#notStopped(running);
            const previous = this.journal.existing(sessionId, requestId, identity, "fork");

            if (previous) {
                return previous;
            }

            this.#prepare?.(binding, sessionId);
            const native = await nativeSessionManager();
            const messages = publicNativeHistory(native.buildSessionProjection(entries).messages);
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
            this.#execute(
                sessionId,
                requestId,
                normalizeNativePrompt(prompt),
                nativePromptOperation(prompt),
                running,
                hooks,
                images,
            ),
        );
    }

    /** Authorized startup discovery uses a normal owned lease, but its gate denies all inference. */
    discover(sessionId: string, requestId: string, hooks: RunHooks): Promise<KernelReceipt> {
        return this.#track(sessionId, (running) =>
            this.#execute(
                sessionId,
                requestId,
                "native-command-discovery",
                "discover",
                running,
                hooks,
            ),
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
        operation: "prompt" | "compact" | "discover" | "command",
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

        if (["prompt", "command"].includes(operation) && !isTeamPrompt(prompt)) {
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

                if (operation === "discover") {
                    throw new Error(
                        "Command discovery does not authorize inference or credential refresh",
                    );
                }

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
                sessionName?: string;
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
            let extensionError: RpcRecord | undefined;
            const detachExtensionErrors = kernel.onEvent((event) => {
                if (event.type === "extension_error") {
                    extensionError = event;
                }
            });

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
                    !["prompt", "command"].includes(operation) ||
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

            const catalog = (await kernel.request({ type: "get_commands" })) as {
                commands?: Array<Record<string, unknown> & { name?: unknown }>;
            };

            hooks.onCommands?.(catalog.commands ?? []);

            const builtins = await nativeBuiltinCommands();

            if (operation === "command") {
                const name = nativeCommandName(prompt);
                const dynamic = catalog.commands ?? [];

                if (!isKnownNativeCommand(prompt, [...dynamic, ...builtins])) {
                    throw new RpcFailure("rejected", `Unknown native command: /${name ?? ""}`);
                }

                if (!builtins.some((command) => command.name === name)) {
                    const source = dynamic.find((command) => command.name === name)?.source;

                    if (source === "prompt" || source === "skill") {
                        this.journal.classifyPromptExpansion(receipt.id);
                        operation = "prompt";
                    }

                    await hooks.onCommandAdmitted?.();
                }
            }

            const sessionName = hooks.sessionName?.();

            if (
                operation !== "discover" &&
                sessionName &&
                state.sessionName !== sessionName &&
                nativeCommandName(prompt) !== "name"
            ) {
                await kernel.setSessionName(sessionName);
            }

            let disposition: "settled" | "handled";

            if (operation === "discover") {
                await kernel.barrier();

                if (extensionError) {
                    throw new RpcFailure(
                        "unknown",
                        "Native startup discovery failed after extension execution",
                    );
                }

                disposition = "handled";
            } else if (operation === "compact") {
                await kernel.compact(prompt);
                disposition = "settled";
            } else if (nativeCommandName(prompt) === "tree") {
                const [entryId, option, ...extra] = nativeCommandArgs(prompt).split(/\s+/);

                if (extra.length || (option !== undefined && option !== "--summarize")) {
                    throw new RpcFailure("rejected", "Use /tree <entryId> [--summarize]");
                }

                if (
                    !this.journal
                        .segmentEntries(receipt.segmentId)
                        .some((entry) => entry.id === entryId)
                ) {
                    throw new RpcFailure(
                        "rejected",
                        "Select an entry from the current native segment.",
                    );
                }

                const navigation = await kernel.navigateTree(entryId!, option === "--summarize");

                await hooks.onNativeResult?.({ navigation });
                disposition = "handled";
            } else if (nativeCommandName(prompt) === "reload") {
                await kernel.command("/team-kernel-reload");
                disposition = "handled";
            } else if (nativeCommandName(prompt) === "name") {
                const name = nativeCommandArgs(prompt);

                if (!name) {
                    throw new RpcFailure("rejected", "Native /name requires a session name");
                }

                await kernel.setSessionName(name);
                disposition = "handled";
            } else if (nativeCommandName(prompt) === "copy") {
                const result = (await kernel.request({ type: "get_last_assistant_text" })) as {
                    text?: string;
                };

                await hooks.onNativeResult?.({ clipboard: result.text ?? "" });
                disposition = "handled";
            } else if (nativeCommandName(prompt) === "session") {
                const [state, stats] = await Promise.all([
                    kernel.request({ type: "get_state" }),
                    kernel.request({ type: "get_session_stats" }),
                ]);

                await hooks.onNativeResult?.({ state, stats });
                disposition = "handled";
            } else if (builtins.some((command) => command.name === nativeCommandName(prompt))) {
                throw new RpcFailure(
                    "rejected",
                    "Native builtin requires the Team command adapter",
                );
            } else {
                running.prompting = true;
                disposition = await kernel.prompt(prompt, undefined, images);
            }

            if (["prompt", "command"].includes(operation)) {
                // A handled native command may own an active Goal even though it did not start an agent turn.
                running.prompting = true;
                let revision = kernel.activityRevision;

                await kernel.barrier();
                let goalState = currentBranchGoalState(
                    await kernel.request({ type: "get_entries" }),
                );

                hooks.onNativeGoalState?.(goalState);

                if (extensionError) {
                    throw new Error(
                        `Native extension command failed: ${String(extensionError.error ?? "unknown error")}`,
                    );
                }

                // Goal owns the same native process and gate while active. Waiting/recovery has
                // no agent turn to settle, so wake on native activity instead of polling/relaunching.
                while (goalIsActive(goalState)) {
                    if (kernel.activityRevision === revision) {
                        await kernel.waitForActivity(revision);
                    }

                    revision = kernel.activityRevision;

                    if (running.aborted) {
                        throw new RpcFailure(
                            "unknown",
                            "Goal workflow stopped before terminal state",
                        );
                    }

                    await kernel.barrier();

                    if (extensionError) {
                        throw new RpcFailure(
                            "unknown",
                            "Native extension failed during the Goal workflow",
                        );
                    }

                    goalState = currentBranchGoalState(
                        await kernel.request({ type: "get_entries" }),
                    );
                    hooks.onNativeGoalState?.(goalState);
                }
            }

            const finalState = (await kernel.request({ type: "get_state" })) as {
                sessionId?: unknown;
                sessionFile?: unknown;
                sessionName?: unknown;
            };

            if (
                finalState.sessionId !== state.sessionId ||
                finalState.sessionFile !== state.sessionFile
            ) {
                throw new RpcFailure(
                    "unknown",
                    "An extension changed native session identity outside the Team session adapter",
                );
            }

            // Native delays JSONL creation until the first conversation. Preserve confirmed /name readback now,
            // then restore it through set_session_name when the next native process starts.
            if (
                nativeCommandName(prompt) === "name" &&
                typeof finalState.sessionName === "string"
            ) {
                await hooks.onSessionName?.(finalState.sessionName);
            }

            detachExtensionErrors();
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
