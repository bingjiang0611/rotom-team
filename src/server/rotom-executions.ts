/** Non-replayable team-owned execution journal around the real rotom loop. Not a model-provider adapter. */
import { createServer } from "node:http";
import {
    kernelRunChannel,
    parseWithWork,
    scopedParseObject,
    type KernelRunSignal,
} from "./perf-channels.ts";
import { TeamResourcePolicyError, assertTeamResourceSources } from "./rotom-resource-policy.ts";
import {
    memberConfigurationSnapshot,
    memberConfigurationChanges,
    teamResourceRevision,
} from "./rotom-resources.ts";
import type { ImageContent } from "@earendil-works/pi-ai";
import { once } from "node:events";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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
    type KernelFailure,
    type KernelRebind,
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
const NATIVE_TAIL_CACHE_LIMIT = 1024 * 1024;

/** Observers of one prompt: none may change its outcome, and a failing observer cannot authorize work. */
export type RunHooks = {
    /** The intent is durably committed: the request can no longer be lost, only end unknown. */
    onReserved?: (receipt: KernelReceipt) => void | Promise<void>;
    /** A dynamic slash passed live registry validation; the consumer may still refuse before dispatch. */
    onCommandAdmitted?: (command: {
        name: string;
        source?: unknown;
        args?: string;
    }) => void | Promise<void>;
    /** Every kernel event, for provisional display only. */
    onEvent?: (event: RpcRecord) => void;
    /** The registry captured from this authorized kernel process. */
    onCommands?: (commands: Array<Record<string, unknown>>) => void | Promise<void>;
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
    attemptId?: string;
    kernel?: RotomRpc;
    snapshot?: () => Promise<{ entries: KernelEntry[]; leafId: string | null }>;
    thinkingChange?: Promise<string>;
    closureUnknown?: boolean;
    /** Its prompt was dispatched: messages may join it. */
    prompting?: boolean;
    /** Where a prompt run's time goes; kept only while the performance journal listens (`perf-channels.ts`). */
    timing?: PromptTiming;
};

type PromptTiming = {
    process?: "started" | "reused";
    dispatchedAt?: number;
    firstOutputAt?: number;
    /** Tools running now, since when, and the time so far with at least one running. */
    toolsRunning: number;
    toolsSince: number;
    toolMs: number;
    tools: number;
    detach?: () => void;
};

/** Fold one native event into a prompt run's timing. Only events after the prompt's dispatch count. */
function timePromptEvent(timing: PromptTiming, event: RpcRecord): void {
    if (timing.dispatchedAt === undefined) {
        return;
    }

    const now = performance.now();

    if (event.type === "message_update") {
        timing.firstOutputAt ??= now;
    } else if (event.type === "tool_execution_start") {
        timing.tools++;

        if (timing.toolsRunning++ === 0) {
            timing.toolsSince = now;
        }
    } else if (event.type === "tool_execution_end" && timing.toolsRunning > 0) {
        if (--timing.toolsRunning === 0) {
            timing.toolMs += now - timing.toolsSince;
        }
    }
}

function promptPhases(
    timing: PromptTiming | undefined,
    startedAt: number,
    endedAt: number,
): Pick<KernelRunSignal, "prompt"> {
    if (timing?.process === undefined || timing.dispatchedAt === undefined) {
        return {};
    }

    return {
        prompt: {
            process: timing.process,
            dispatchMs: timing.dispatchedAt - startedAt,
            firstOutputMs:
                timing.firstOutputAt === undefined
                    ? null
                    : timing.firstOutputAt - timing.dispatchedAt,
            // A run that ended with a tool still running (an error, a stop) counts it to the end.
            toolMs: timing.toolMs + (timing.toolsRunning > 0 ? endedAt - timing.toolsSince : 0),
            tools: timing.tools,
        },
    };
}

type ActiveAttempt = {
    receipt: KernelReceipt;
    operation: "prompt" | "compact" | "discover" | "command";
    running: Running;
    inferenceAdmitted: boolean;
};

/** What a native launch made so far, for its caller to close should the launch fail. */
type Owned = {
    gate?: ReturnType<typeof createServer>;
    gateFile?: string;
    contextFile?: string;
    kernel?: RotomRpc;
};

type PersistentKernel = {
    revision: string;
    kernel: RotomRpc;
    gate: ReturnType<typeof createServer>;
    gateFile: string;
    contextFile?: string;
    gateState: { active?: ActiveAttempt };
    state: { sessionFile: string; sessionId: string; sessionName?: string; thinkingLevel: string };
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

/** The most warm processes not used yet, over all members; each member has at most one. */
const WARM_TOTAL = 3;
/** A warm process no request used retires after this long. */
const WARM_UNUSED_MS = 5 * 60_000;

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
    readonly #kernels = new Map<string, PersistentKernel>();
    /** Processes started before any request (`warm`) and not used yet, by segment: whose, and their unused timer. */
    readonly #unused = new Map<
        string,
        { sessionId: string; binding: Readonly<KernelBinding>; timer: NodeJS.Timeout }
    >();
    /** Warm starts on their way, by segment. A request for that segment waits for its start instead of a second. */
    readonly #warming = new Map<string, { memberId: string; done: Promise<boolean> }>();
    #closing = false;
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
        this.journal = scopedParseObject("journal", new RotomJournal(data));
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

    thinkingLevel(sessionId: string, readEntries?: (segmentId: string) => KernelEntry[]): string {
        const { segmentId } = this.journal.session(sessionId);

        return (
            this.#kernels.get(segmentId)?.state.thinkingLevel ??
            this.journal.thinkingLevel(sessionId, readEntries)
        );
    }

    /** Change only native reasoning, under the current prompt's durable command fence. */
    async setThinkingLevel(sessionId: string, level: string): Promise<string> {
        const run = [...(this.#running.get(sessionId) ?? [])].find((run) => run.prompting);
        const receipt = run?.attemptId ? this.journal.receipt(run.attemptId) : undefined;

        if (
            !run?.kernel ||
            !run.snapshot ||
            run.aborted ||
            !receipt ||
            receipt.status !== "dispatch-intent" ||
            receipt.phase !== "execution" ||
            receipt.unresolvedCommandInput
        ) {
            throw new RpcFailure(
                "rejected",
                "Thinking can only change during an active, reconciled prompt",
            );
        }

        const kernel = run.kernel;
        const snapshot = run.snapshot;
        const inputId = this.journal.beginCommandInput(receipt.id, `/thinking ${level}`);

        run.thinkingChange = (async () => {
            await kernel.setThinkingLevel(level);
            const state = (await kernel.request({ type: "get_state" })) as {
                thinkingLevel: string;
            };
            const { entries } = await snapshot();

            if (run.aborted) {
                throw new RpcFailure(
                    "unknown",
                    "Thinking change interrupted by Stop; do not replay it",
                );
            }

            this.journal.progress(receipt.id, entries);
            this.journal.completeCommandInput(inputId);

            return state.thinkingLevel;
        })();

        return run.thinkingChange;
    }

    /** Add a message to the session's running prompt. False when none is running. */
    async queue(
        sessionId: string,
        text: string,
        mode: "steer" | "followUp",
        images: ImageContent[] = [],
        admitCommand?: RunHooks["onCommandAdmitted"],
    ): Promise<boolean> {
        for (const run of this.#running.get(sessionId) ?? []) {
            if (run.prompting && run.kernel) {
                if (this.journal.hasUnresolvedCommandInput(run.attemptId!)) {
                    throw new RpcFailure(
                        "rejected",
                        "A queued native command is pending or unknown; do not replay it",
                    );
                }

                const slash = text.trimStart().startsWith("/");
                const name = nativeCommandName(text);

                const queueInput = async () => {
                    const goal = currentBranchGoalState(await run.snapshot!());

                    if (goalIsActive(goal)) {
                        await run.kernel!.wake(normalizeNativePrompt(text), images, mode);
                    } else {
                        await run.kernel!.queue(normalizeNativePrompt(text), mode, images);
                    }
                };

                if (slash) {
                    const { binding } = this.journal.session(sessionId);

                    try {
                        await assertTeamResourceSources(
                            binding.home,
                            join(this.#data, "team-agent"),
                            binding.workspace,
                        );
                    } catch (error) {
                        if (error instanceof TeamResourcePolicyError) {
                            throw new RpcFailure("rejected", error.message);
                        }

                        throw error;
                    }

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

                    await admitCommand?.({ name: name!, source, args: nativeCommandArgs(text) });

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
                        const inputId = this.journal.beginCommandInput(
                            run.attemptId!,
                            normalizeNativePrompt(text),
                        );

                        await run.kernel.command(normalizeNativePrompt(text));
                        await run.kernel.barrier();

                        if (extensionError) {
                            throw new RpcFailure(
                                "unknown",
                                `Native extension command failed: ${String(extensionError.error ?? "unknown error")}`,
                            );
                        }

                        this.journal.completeCommandInput(inputId);
                    } finally {
                        detach();
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
        const running: Running = {
            aborted: false,
            ...(kernelRunChannel.hasSubscribers
                ? { timing: { toolsRunning: 0, toolsSince: 0, toolMs: 0, tools: 0 } }
                : {}),
        };
        const runs = this.#running.get(sessionId) ?? new Set<Running>();

        runs.add(running);
        this.#running.set(sessionId, runs);
        this.#active++;
        const started = performance.now();
        let outcome = "error";

        try {
            const receipt = await action(running);

            outcome = `${receipt.operation}:${receipt.status}`;

            return receipt;
        } finally {
            running.timing?.detach?.();

            if (kernelRunChannel.hasSubscribers) {
                const ended = performance.now();

                kernelRunChannel.publish({
                    ms: ended - started,
                    outcome,
                    ...promptPhases(running.timing, started, ended),
                } satisfies KernelRunSignal);
            }

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
            // Reserve before awaiting closure so no new prompt can reuse the retiring process.
            const receipt = this.journal.handoff(sessionId, requestId, expectedHead, binding);

            try {
                await this.#retire(expectedHead);
            } catch (error) {
                running.closureUnknown = true;
                this.journal.fail(receipt.id, "unknown");

                throw error;
            }

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

    /** The paying member's idle model change: same native session, restarted on the new model. */
    setModel(
        sessionId: string,
        requestId: string,
        rebind: KernelRebind,
        hooks: RunHooks = {},
    ): Promise<KernelReceipt> {
        return this.#track(sessionId, (running) =>
            this.#execute(
                sessionId,
                requestId,
                `/model ${rebind.binding.accountGeneration}/${rebind.binding.model}`,
                "command",
                running,
                hooks,
                [],
                rebind,
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
        rebind?: KernelRebind,
    ): Promise<KernelReceipt> {
        const identity = nativePromptIdentity(prompt, images);
        const admitted = this.journal.session(sessionId);
        const binding = Object.freeze(rebind?.binding ?? admitted.binding);

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
        if (
            this.journal.session(sessionId).segmentId !== admitted.segmentId ||
            (rebind && rebind.expectedHead !== admitted.segmentId)
        ) {
            throw new KernelRequestConflict("Conversation head changed during admission");
        }

        if (verifyRotomKernel().version !== binding.kernelVersion) {
            throw new Error("Kernel version differs from the immutable session binding");
        }

        const prepared = this.#prepare?.(binding, sessionId);

        if (rebind) {
            // The retained process is gated to the previous model; the same session file restarts on the new one.
            await this.#retire(admitted.segmentId);
        }

        const receipt = this.journal.reserve(sessionId, requestId, identity, operation, rebind);

        running.attemptId = receipt.id;

        await hooks.onReserved?.(receipt);
        // Admission is asynchronous: an earlier request may have created the native file while it was pending.
        const session = this.journal.session(sessionId);

        const revision = teamResourceRevision(join(this.#data, "team-agent"), binding.workspace);

        // One process per session: a warm start on its way is waited for, not started twice.
        const warming = this.#warming.get(admitted.segmentId);

        if (warming) {
            await warming.done;
        }

        let persistent = this.#kernels.get(admitted.segmentId);

        if (running.timing) {
            running.timing.process = persistent ? "reused" : "started";
        }

        let kernel: RotomRpc | undefined = persistent?.kernel;
        let gate: ReturnType<typeof createServer> | undefined = persistent?.gate;
        let gateFile: string | undefined = persistent?.gateFile;
        let contextFile: string | undefined = persistent?.contextFile;
        let closed = false;
        let failureStatus: "unknown" | "rejected" = "unknown";
        const activeAttempt: ActiveAttempt = {
            receipt,
            operation,
            running,
            inferenceAdmitted: false,
        };

        const gateState = persistent?.gateState ?? { active: activeAttempt };

        gateState.active = activeAttempt;

        let state: PersistentKernel["state"] | undefined = persistent?.state;

        try {
            if (persistent) {
                // Started before (by an earlier request, or warmed for this member): no longer waiting unused.
                this.#used(admitted.segmentId);
            } else {
                const owned: Owned = {};

                try {
                    persistent = await this.#launch(
                        binding,
                        sessionId,
                        session.sessionFile,
                        prepared,
                        gateState,
                        receipt.id,
                        revision,
                        owned,
                        {
                            beforeStart: () => this.#notStopped(running),
                            started: (started) => (running.kernel = started),
                        },
                    );
                } finally {
                    ({ kernel, gate, gateFile, contextFile } = owned);
                }

                state = persistent.state;
                this.#kernels.set(admitted.segmentId, persistent);
            }

            if (!persistent || !state || !kernel) {
                throw new Error("Native process did not initialize");
            }

            const nativeState = state;

            running.kernel = kernel;
            this.journal.attach(receipt.id, state.sessionFile, state.sessionId, kernel.pid);
            // Recheck after startup/catalog work, immediately before sending the user request.
            await this.#authorize(binding, "admission", sessionId);

            const tail = new NativeTail(state.sessionFile, state.sessionId, binding.workspace);

            running.snapshot = () => readNativeSnapshot(kernel!, state!, binding.workspace, tail);

            let progressFailure: unknown;
            let extensionError: RpcRecord | undefined;
            const detachExtensionErrors = kernel.onEvent((event) => {
                if (event.type === "extension_error") {
                    extensionError = event;
                }
            });

            const timing = running.timing;

            if (timing) {
                // Detached when the run ends (`#track`), even when it throws: the process may serve the next run.
                timing.detach = kernel.onEvent((event) => timePromptEvent(timing, event));
            }

            let detachHook: (() => void) | undefined;

            if (hooks.onEvent) {
                detachHook = kernel.onEvent(hooks.onEvent);
                // Someone watches this run, so its dialogs (ask_user_question, permissions) can reach a person.
                kernel.forwardDialogs();
            }

            // Message-level durability: each persisted message is journaled as it lands, so a restart loses at most
            // the message in flight. The final snapshot below remains the authority for the outcome.
            const detachProgress = kernel.onEvent((event) => {
                if (event.type === "thinking_level_changed") {
                    nativeState.thinkingLevel = String(event.level);
                    hooks.onProgress?.();
                }

                if (
                    event.type !== "message_end" ||
                    !["prompt", "command"].includes(operation) ||
                    progressFailure !== undefined ||
                    !existsSync(nativeState.sessionFile)
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

            if (persistent.revision !== revision && nativeCommandName(prompt) !== "reload") {
                // Shared settings edits used to apply on every startup. Reload the same process
                // under the new receipt instead of silently retaining the old settings.
                await kernel.command("/team-kernel-reload");
                await kernel.barrier();

                if (extensionError) {
                    throw new RpcFailure("unknown", "Native resource reload failed");
                }
            }

            const catalog = (await kernel.request({ type: "get_commands" })) as {
                commands?: Array<Record<string, unknown> & { name?: unknown }>;
            };

            await hooks.onCommands?.(catalog.commands ?? []);

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
                        activeAttempt.operation = operation;
                    }

                    await hooks.onCommandAdmitted?.({
                        name: name!,
                        source,
                        args: nativeCommandArgs(prompt),
                    });
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

            const resourceSnapshot = memberConfigurationSnapshot(
                binding.home,
                join(this.#data, "team-agent"),
            );
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
            } else if (nativeCommandName(prompt) === "context") {
                const requested = nativeCommandArgs(prompt).toLowerCase();
                const view = requested === "" || requested === "usage" ? "usage" : requested;

                if (view !== "usage" && view !== "injections") {
                    throw new RpcFailure("rejected", "Use /context [usage|injections]");
                }

                await hooks.onNativeResult?.({ context: await kernel.context(view) });
                disposition = "handled";
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
            } else if (rebind && nativeCommandName(prompt) === "model") {
                // Records the native model_change; Team's selected level is reapplied after native clamping.
                await kernel.setModel(binding.provider, binding.model);

                if (binding.thinkingLevel) {
                    await kernel.setThinkingLevel(binding.thinkingLevel);
                }

                disposition = "handled";
            } else if (nativeCommandName(prompt) === "thinking") {
                // Idle reasoning changes stay in this native session and process.
                const level = nativeCommandArgs(prompt);

                if (!/^[a-z]+$/.test(level)) {
                    throw new RpcFailure("rejected", "Use /thinking <level>");
                }

                await kernel.setThinkingLevel(level);
                disposition = "handled";
            } else if (builtins.some((command) => command.name === nativeCommandName(prompt))) {
                throw new RpcFailure(
                    "rejected",
                    "Native builtin requires the Team command adapter",
                );
            } else {
                running.prompting = true;

                if (running.timing) {
                    running.timing.dispatchedAt = performance.now();
                }

                disposition = await kernel.prompt(prompt, undefined, images);
            }

            if (!running.aborted) {
                this.journal.setPhase(receipt.id, "finalization");
            }

            if (["prompt", "command"].includes(operation)) {
                // A handled native command may own an active Goal even though it did not start an agent turn.
                running.prompting = true;
                let revision = kernel.activityRevision;

                await kernel.barrier();
                let goalState = currentBranchGoalState(await running.snapshot());

                hooks.onNativeGoalState?.(goalState);

                if (extensionError) {
                    throw new Error(
                        `Native extension command failed: ${String(extensionError.error ?? "unknown error")}`,
                    );
                }

                // Goal owns the same native process and gate while active. Waiting/recovery has
                // no agent turn to settle, so wake on native activity instead of polling/relaunching.
                while (goalIsActive(goalState)) {
                    this.journal.setPhase(receipt.id, "execution");

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

                    if (!running.aborted) {
                        this.journal.setPhase(receipt.id, "finalization");
                    }

                    await kernel.barrier();

                    if (extensionError) {
                        throw new RpcFailure(
                            "unknown",
                            "Native extension failed during the Goal workflow",
                        );
                    }

                    goalState = currentBranchGoalState(await running.snapshot());
                    hooks.onNativeGoalState?.(goalState);
                }
            }

            if (operation === "command" && nativeCommandName(prompt) !== "reload") {
                const changed = memberConfigurationChanges(
                    binding.home,
                    join(this.#data, "team-agent"),
                    resourceSnapshot,
                );

                if (changed.length) {
                    const message =
                        "Team did not accept a change to member configuration. Edit the owner-managed shared profile instead. This attempt is unknown; do not replay it.";

                    hooks.onEvent?.({
                        type: "extension_ui_request",
                        id: randomUUID(),
                        method: "notify",
                        message,
                        notifyType: "warning",
                    });
                    await hooks.onNativeResult?.({
                        configurationError: message,
                        changedDerivedFiles: changed,
                    });

                    throw new Error(message);
                }
            }

            // Finalization must not outrun a live thinking write or hide its unknown outcome.
            await running.thinkingChange;

            const finalState = (await kernel.request({ type: "get_state" })) as {
                sessionId?: unknown;
                sessionFile?: unknown;
                sessionName?: unknown;
                thinkingLevel: string;
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

            state.sessionName =
                typeof finalState.sessionName === "string" ? finalState.sessionName : undefined;
            state.thinkingLevel = finalState.thinkingLevel;

            // Native delays JSONL creation until the first conversation. Preserve confirmed /name readback now,
            // then restore it through set_session_name when the next native process starts.
            if (
                nativeCommandName(prompt) === "name" &&
                typeof finalState.sessionName === "string"
            ) {
                await hooks.onSessionName?.(finalState.sessionName);
            }

            if (running.aborted) {
                // Stop is sticky in the native transport. Never reuse a stopped process.
                await this.#retire(admitted.segmentId);
            }

            detachExtensionErrors();
            detachProgress();
            detachHook?.();

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

            persistent.revision = revision;
            gateState.active = undefined;
            closed = true;

            hooks.onProgress?.();

            return finished;
        } catch (error) {
            // Team policy may reject before native startup. After startup only an explicit native rejection is known.
            if (
                error instanceof TeamResourcePolicyError &&
                !kernel &&
                !activeAttempt.inferenceAdmitted
            ) {
                hooks.onEvent?.({
                    type: "extension_ui_request",
                    id: randomUUID(),
                    method: "notify",
                    notifyType: "error",
                    message:
                        "Team blocked member agent customization. Use the shared profile or trusted project configuration.",
                });
                await hooks.onNativeResult?.({ resourcePolicyError: error.message });
            }

            failureStatus =
                ((error instanceof TeamResourcePolicyError && !kernel) ||
                    (error instanceof RpcFailure && error.outcome === "rejected") ||
                    error instanceof KernelRequestConflict) &&
                !activeAttempt.inferenceAdmitted
                    ? "rejected"
                    : "unknown";

            if (failureStatus === "unknown") {
                const message = error instanceof RpcFailure ? error.message : "";
                let failure: KernelFailure = "native-error";

                if (/^RPC record exceeds \d+ MiB$/.test(message)) {
                    failure = "rpc-record-limit";
                } else if (message === "RPC acknowledgement deadline exceeded") {
                    failure = "rpc-timeout";
                } else if (message === "kernel disconnected") {
                    failure = "rpc-disconnected";
                }

                this.journal.recordFailure(receipt.id, failure);
            }
        } finally {
            if (!closed) {
                gateState.active = undefined;
                this.#kernels.delete(admitted.segmentId);
                gate?.closeAllConnections();
                await new Promise<void>((resolve) => gate?.close(() => resolve()) ?? resolve());

                // Keep the active lease and account reservation until child close is observed. A close failure must not release the writer lock.
                if (kernel) {
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
        }

        const attached = this.journal.session(sessionId).sessionFile;
        const unmaterialized =
            failureStatus === "rejected" &&
            !session.sessionFile &&
            attached !== undefined &&
            !existsSync(attached);

        return this.journal.fail(
            receipt.id,
            failureStatus,
            unmaterialized,
            rebind ? admitted.binding : undefined,
        );
    }

    /**
     * Start a native process for `binding` on its session, with its own spending gate: the gate admits a request only
     * for `gateState.active`, so a process started with nothing active can spend nothing. `owned` holds each resource
     * as it is made, for the caller to close should this fail. Not entered in `#kernels`: the caller does that.
     */
    async #launch(
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

                if (this.journal.receipt(active.receipt.id).status !== "dispatch-intent") {
                    throw new Error("attempt is not active");
                }

                // A subagent's response: its entries stay in its own session, so the gate records what it spent.
                if (value.operation === "usage") {
                    if (!value.usage || typeof value.usage !== "object") {
                        throw new Error("usage must be an object");
                    }

                    this.journal.childUsage(active.receipt.id, value.usage);
                    res.writeHead(204).end();

                    return;
                }

                if (active.running.aborted) {
                    throw new Error("execution stopped");
                }

                const auth = await this.#authorize(binding, value.operation, sessionId);

                if (
                    active.running.aborted ||
                    this.journal.receipt(active.receipt.id).status !== "dispatch-intent" ||
                    gateState.active !== active
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
        const folder = join(this.#data, "kernel-gates");

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
            thinkingLevel: this.journal.thinkingLevel(sessionId),
            teamAgentDir: join(this.#data, "team-agent"),
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
            const admitted = this.journal.session(sessionId);
            const segmentId = admitted.segmentId;
            const memberId = admitted.binding.memberId;
            const pending = this.#warming.get(segmentId);

            if (pending) {
                return await pending.done;
            }

            if (this.#kernels.has(segmentId)) {
                return true;
            }

            if (
                this.#closing ||
                (this.#running.get(sessionId)?.size ?? 0) > 0 ||
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
                this.#warming.has(segmentId) ||
                this.#kernels.has(segmentId) ||
                (this.#running.get(sessionId)?.size ?? 0) > 0 ||
                [...this.#warming.values()].some((each) => each.memberId === memberId) ||
                this.#unused.size + this.#warming.size >= WARM_TOTAL
            ) {
                return false;
            }

            const done = this.#warmStart(sessionId, admitted).finally(() =>
                this.#warming.delete(segmentId),
            );

            this.#warming.set(segmentId, { memberId, done });

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
            await this.#authorize(binding, "admission", sessionId);
            const prepared = this.#prepare?.(binding, sessionId);
            const revision = teamResourceRevision(
                join(this.#data, "team-agent"),
                binding.workspace,
            );
            const persistent = await this.#launch(
                binding,
                sessionId,
                this.journal.session(sessionId).sessionFile,
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
                this.journal.session(sessionId).segmentId !== admitted.segmentId ||
                this.#kernels.has(admitted.segmentId)
            ) {
                throw new Error("The session moved on while its process started");
            }

            this.#kernels.set(admitted.segmentId, persistent);
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
    #used(segmentId: string): void {
        clearTimeout(this.#unused.get(segmentId)?.timer);
        this.#unused.delete(segmentId);
    }

    /** Retire this segment's warm process if no request has used it; it leaves `#kernels` before it closes. */
    async #retireUnused(segmentId: string): Promise<void> {
        if (!this.#unused.has(segmentId)) {
            return;
        }

        // Out of `#kernels` at once, before any wait: no request may take a process that is closing.
        const persistent = this.#kernels.get(segmentId);

        this.#used(segmentId);
        this.#kernels.delete(segmentId);

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

    async #retire(segmentId: string): Promise<void> {
        // A warm start on its way finishes first, so what it started is retired too.
        await this.#warming.get(segmentId)?.done;
        this.#used(segmentId);
        const persistent = this.#kernels.get(segmentId);

        if (!persistent) {
            return;
        }

        persistent.gateState.active = undefined;
        persistent.gate.closeAllConnections();
        await new Promise<void>((resolve) => persistent.gate.close(() => resolve()));

        await persistent.kernel.close();
        this.#kernels.delete(segmentId);
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
        if (this.#active) {
            throw new Error("Kernel executions are still active; do not release the writer lock");
        }

        this.#closing = true;

        return (async () => {
            await Promise.all([...this.#warming.values()].map((each) => each.done));

            for (const segmentId of [...this.#kernels.keys()]) {
                await this.#retire(segmentId);
            }

            this.journal.close();
        })();
    }
}

/**
 * Native JSONL is an append-only prefix of get_entries. Read that prefix locally, then ask native
 * for its in-memory suffix and current leaf. This preserves unflushed custom entries and branches
 * without sending the whole image-heavy history through one bounded RPC record.
 * The native RPC limit still applies to a single event or an unflushed suffix.
 */
export async function readNativeSnapshot(
    kernel: Pick<RotomRpc, "request">,
    state: { sessionFile: string; sessionId: string },
    workspace: string,
    tail?: NativeTail,
): Promise<{ entries: KernelEntry[]; leafId: string | null }> {
    const persisted = existsSync(state.sessionFile)
        ? (tail
              ? tail.snapshot(state.sessionFile, state.sessionId, workspace)
              : new NativeTail(
                    state.sessionFile,
                    state.sessionId,
                    workspace,
                    "native-jsonl-snapshot",
                ).read()
          ).filter((entry) => entry.type !== "session")
        : [];
    const since = persisted.at(-1)?.id;
    const delta = (await kernel.request({ type: "get_entries", ...(since ? { since } : {}) })) as {
        entries: KernelEntry[];
        leafId: string | null;
    };

    return { entries: [...persisted, ...delta.entries], leafId: delta.leafId };
}

/** One complete snapshot of a native session file. */
function readNativeEntries(path: string, sessionId: string, workspace: string): KernelEntry[] {
    const tail = new NativeTail(path, sessionId, workspace, "native-jsonl-snapshot");
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
    readonly #source: "native-jsonl-ingest" | "native-jsonl-snapshot";
    readonly #ids = new Set<string>();
    #cachedEntries: KernelEntry[] | undefined = [];
    readonly #prefixHash = createHash("sha256");
    #undelivered: KernelEntry[] = [];
    #offset = 0;
    #pending = Buffer.alloc(0);
    #header = false;
    constructor(
        path: string,
        sessionId: string,
        workspace: string,
        source: "native-jsonl-ingest" | "native-jsonl-snapshot" = "native-jsonl-ingest",
    ) {
        this.#path = path;
        this.#sessionId = sessionId;
        this.#workspace = workspace;
        this.#source = source;
    }

    /** True when the last read ended exactly at a line break. */
    get complete(): boolean {
        return this.#header && this.#pending.length === 0;
    }

    /** Newly validated entries for journal ingestion. Snapshot reads do not consume this delivery cursor. */
    read(): KernelEntry[] {
        this.#refresh();
        const entries = this.#undelivered;

        this.#undelivered = [];

        return entries;
    }

    /** Every validated complete entry, refreshing only the unread file suffix. */
    snapshot(
        path = this.#path,
        sessionId = this.#sessionId,
        workspace = this.#workspace,
    ): KernelEntry[] {
        if (path !== this.#path || sessionId !== this.#sessionId || workspace !== this.#workspace) {
            throw new Error("Native tail snapshot identity mismatch");
        }

        const fresh = () =>
            new NativeTail(
                this.#path,
                this.#sessionId,
                this.#workspace,
                "native-jsonl-snapshot",
            ).read();

        try {
            this.#refresh();
        } catch {
            // A fresh snapshot is authoritative even after a rewrite or malformed append. Preserve its exact
            // JSON/header/tree errors rather than replacing them with a cache-integrity error.
            return fresh();
        }

        if (this.#cachedEntries === undefined) {
            return fresh();
        }

        // Compare every byte, not size/mtime. If the append-only assumption fails, parse the entire file afresh,
        // just as the old snapshot did, including valid rewrites and malformed non-current branches.
        const fd = openSync(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const hash = createHash("sha256");
        let offset = 0;

        try {
            const stat = fstatSync(fd);

            if (stat.size < this.#offset) {
                return fresh();
            }

            while (offset < this.#offset) {
                const chunk = Buffer.alloc(Math.min(this.#offset - offset, 1024 * 1024));
                const bytes = readSync(fd, chunk, 0, chunk.length, offset);

                if (bytes === 0) {
                    return fresh();
                }

                hash.update(chunk.subarray(0, bytes));
                offset += bytes;
            }
        } finally {
            closeSync(fd);
        }

        if (hash.digest("hex") !== this.#prefixHash.copy().digest("hex")) {
            return fresh();
        }

        return [...this.#cachedEntries];
    }

    #refresh(): void {
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

                this.#prefixHash.update(chunk.subarray(0, read));
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

        for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) {
            if (line === "") {
                continue;
            }

            if (Buffer.byteLength(line) > NATIVE_LINE_LIMIT) {
                throw new Error("Native session line exceeds the import bound");
            }

            const entry = parseWithWork(this.#source, line) as KernelEntry;

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
                this.#undelivered.push(entry);
                this.#cachedEntries?.push(entry);
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
            this.#undelivered.push(entry);
            this.#cachedEntries?.push(entry);
        }

        if (this.#offset > NATIVE_TAIL_CACHE_LIMIT) {
            this.#cachedEntries = undefined;
        }
    }
}
