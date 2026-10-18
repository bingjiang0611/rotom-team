/** Strict RPC transport. Responses acknowledge commands; only agent_settled ends a run, never proves business success. */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { ImageContent } from "@earendil-works/pi-ai";
import { parseWithWork } from "./perf-channels.ts";

export type RpcRecord = { type: string; [key: string]: unknown };
export class RpcFailure extends Error {
    readonly outcome: "rejected" | "unknown";
    constructor(outcome: "rejected" | "unknown", message: string) {
        super(message);
        this.outcome = outcome;
    }
}

/** No environment merging, stdout/stderr logging, retries, or request-id-based replay. */
export class RotomRpc {
    readonly #child: ChildProcessWithoutNullStreams;
    readonly #timeout: number;
    readonly #recordLimit: number;
    readonly #startedAt: number;
    #spawnedAt?: number;
    readonly #closed: Promise<void>;
    readonly #pending = new Map<
        string,
        {
            command: string;
            resolve: (data: unknown) => void;
            reject: (error: Error) => void;
            timer: NodeJS.Timeout | undefined;
        }
    >();
    readonly #listeners = new Set<(record: RpcRecord) => void>();
    /** Dialogs a person may still answer; null while dialogs are cancelled at once. */
    #dialogs: Set<string> | null = null;
    #failure?: RpcFailure;
    /** The unfinished last line, and its size in bytes. */
    #buffer = "";
    #bufferBytes = 0;
    #busy = false;
    /** A prompt is running: it may take more of its member's messages. */
    #prompting = false;
    #shutdown = false;
    /** Background subagents this kernel started whose results are not back yet, as the team policy reports them. */
    #children = 0;
    /** Stop was asked: the running prompt no longer waits for its children. */
    #stopping = false;
    /** Ends the running prompt if it is only waiting for children. */
    #stopWaiting?: () => void;
    readonly #activityWaiters = new Set<() => void>();
    #activityRevision = 0;

    constructor(
        command: string,
        args: string[],
        options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number; recordLimit?: number },
    ) {
        this.#timeout = options.timeoutMs ?? 30_000;
        this.#recordLimit = options.recordLimit ?? 8 * 1024 * 1024;
        this.#startedAt = performance.now();
        this.#child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
            stdio: ["pipe", "pipe", "pipe"],
        });
        const decoder = new StringDecoder("utf8");

        this.#child.once("spawn", () => (this.#spawnedAt = performance.now()));
        this.#child.stdout.on("data", (data: Buffer) => this.#consume(decoder.write(data)));
        // Diagnostics may contain tokens or prompt bodies. Drain without retaining or forwarding them.
        this.#child.stderr.resume();
        this.#child.once("error", () => this.#fail("kernel process unavailable"));
        this.#child.stdin.on("error", () => this.#fail("kernel input unavailable"));
        this.#closed = new Promise((resolve) =>
            this.#child.once("close", () => {
                if (!this.#shutdown || this.#pending.size || this.#busy) {
                    this.#fail("kernel disconnected");
                }

                resolve();
            }),
        );
    }

    /** Time from spawn() call until the OS reports the child started; available after its first RPC response. */
    get spawnMs(): number | undefined {
        return this.#spawnedAt === undefined ? undefined : this.#spawnedAt - this.#startedAt;
    }

    /** The kernel's process id, recorded so a later startup can tell a dead run from a live one. */
    get pid(): number | undefined {
        return this.#child.pid;
    }

    get activityRevision(): number {
        return this.#activityRevision;
    }

    onEvent(listener: (record: RpcRecord) => void): () => void {
        this.#listeners.add(listener);

        return () => this.#listeners.delete(listener);
    }

    /** From now on, pass extension dialogs to the listeners for a person to answer, instead of cancelling them. */
    forwardDialogs(): void {
        this.#dialogs ??= new Set();
    }

    /** Answer a forwarded dialog once. False when it is not waiting (answered, or never forwarded). */
    answer(
        id: string,
        response: { value: string } | { confirmed: boolean } | { cancelled: true },
    ): boolean {
        if (!this.#dialogs?.delete(id)) {
            return false;
        }

        this.#write({ type: "extension_ui_response", id, ...response });

        return true;
    }

    #fail(reason: string): void {
        if (this.#failure) {
            return;
        }

        this.#failure = new RpcFailure("unknown", reason);

        for (const pending of this.#pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(this.#failure);
        }

        this.#pending.clear();
        this.#activityRevision++;

        for (const wake of this.#activityWaiters) {
            wake();
        }

        for (const listener of this.#listeners) {
            listener({ type: "transport_unknown" });
        }

        this.#child.kill("SIGTERM");
    }

    #consume(text: string): void {
        if (this.#failure) {
            return;
        }

        // Search and measure only the new text: rescanning the whole buffer per chunk is quadratic, and a large
        // record (a get_entries of an image-heavy session) then outlasts the acknowledgement deadline.
        let start = 0,
            end: number;

        while ((end = text.indexOf("\n", start)) >= 0) {
            const line = (this.#buffer + text.slice(start, end)).replace(/\r$/, "");

            this.#buffer = "";
            this.#bufferBytes = 0;
            start = end + 1;

            if (Buffer.byteLength(line) > this.#recordLimit) {
                this.#fail(`RPC record exceeds ${this.#recordLimit / 1024 / 1024} MiB`);

                return;
            }

            let value: RpcRecord;

            try {
                value = parseWithWork("native-rpc", line);
            } catch {
                this.#fail("invalid RPC JSONL");

                return;
            }

            if (!value || typeof value !== "object" || typeof value.type !== "string") {
                this.#fail("invalid RPC record");

                return;
            }

            if (value.type === "response") {
                const pending = this.#pending.get(String(value.id));

                if (
                    !pending ||
                    value.command !== pending.command ||
                    typeof value.success !== "boolean"
                ) {
                    this.#fail("uncorrelated RPC response");

                    return;
                }

                this.#pending.delete(String(value.id));
                clearTimeout(pending.timer);

                if (value.success) {
                    pending.resolve(value.data);
                } else {
                    pending.reject(
                        new RpcFailure("rejected", `kernel rejected ${pending.command}`),
                    );
                }
            } else {
                const children = childrenReport(value);

                if (children !== undefined) {
                    this.#children = children;
                }

                // Dialogs must not silently authorize work in a headless host: one nobody can answer is cancelled.
                if (
                    value.type === "extension_ui_request" &&
                    ["select", "confirm", "input", "editor"].includes(String(value.method))
                ) {
                    if (this.#dialogs) {
                        this.#dialogs.add(String(value.id));
                    } else {
                        this.#write({
                            type: "extension_ui_response",
                            id: value.id,
                            cancelled: true,
                        });
                    }
                }

                if (
                    [
                        "agent_start",
                        "agent_end",
                        "agent_settled",
                        "message_end",
                        "entry_appended",
                        "extension_error",
                        "transport_unknown",
                    ].includes(value.type)
                ) {
                    this.#activityRevision++;

                    for (const wake of this.#activityWaiters) {
                        wake();
                    }
                }

                for (const listener of this.#listeners) {
                    listener(value);
                }
            }
        }

        const rest = text.slice(start);

        this.#buffer += rest;
        this.#bufferBytes += Buffer.byteLength(rest);

        if (this.#bufferBytes > this.#recordLimit) {
            this.#fail(`RPC record exceeds ${this.#recordLimit / 1024 / 1024} MiB`);
        }
    }

    #write(record: RpcRecord): void {
        if (this.#failure) {
            throw this.#failure;
        }

        this.#child.stdin.write(`${JSON.stringify(record)}\n`, (error) => {
            if (error) {
                this.#fail("kernel input failed");
            }
        });
    }

    request(command: RpcRecord): Promise<unknown> {
        const readOnly = [
            "get_state",
            "get_entries",
            "get_commands",
            "get_messages",
            "get_last_assistant_text",
            "get_session_stats",
            "get_available_models",
        ];

        if (!readOnly.includes(command.type) && command.type !== "abort") {
            return Promise.reject(new RpcFailure("rejected", "unsupported kernel command"));
        }

        return this.#send(command);
    }

    setSessionName(name: string): Promise<unknown> {
        return this.#send({ type: "set_session_name", name });
    }

    setThinkingLevel(level: string): Promise<unknown> {
        return this.#send({ type: "set_thinking_level", level });
    }

    setModel(provider: string, modelId: string): Promise<unknown> {
        return this.#send({ type: "set_model", provider, modelId });
    }

    #send(command: RpcRecord, timeoutMs: number | null = this.#timeout): Promise<unknown> {
        if (this.#failure) {
            return Promise.reject(this.#failure);
        }

        if (this.#shutdown) {
            return Promise.reject(new RpcFailure("rejected", "kernel closing"));
        }

        // Bounded pending writes also bound stdin buffering. There is no unbounded prompt queue.
        if (
            this.#pending.size >= 16 ||
            Buffer.byteLength(JSON.stringify(command)) > this.#recordLimit
        ) {
            return Promise.reject(new RpcFailure("rejected", "RPC admission limit"));
        }

        const id = randomUUID();

        return new Promise((resolve, reject) => {
            const timer =
                timeoutMs === null
                    ? undefined
                    : setTimeout(
                          () => this.#fail("RPC acknowledgement deadline exceeded"),
                          timeoutMs,
                      );

            this.#pending.set(id, { command: command.type, resolve, reject, timer });
            this.#write({ ...command, id });
        });
    }

    /** Coding runs have no natural length: without timeoutMs only Stop or process loss ends a run. */
    async prompt(
        message: string,
        timeoutMs?: number,
        images: import("@earendil-works/pi-ai").ImageContent[] = [],
    ): Promise<"settled" | "handled"> {
        if (this.#busy) {
            throw new RpcFailure("rejected", "kernel busy; no implicit queue or payer change");
        }

        this.#busy = true;
        this.#prompting = true;
        let resolve!: () => void, reject!: (error: Error) => void;
        const settled = new Promise<void>((yes, no) => {
            resolve = yes;
            reject = no;
        });
        // The turn has settled, but subagents it started still run. Their results come back as new turns of this
        // prompt, paid by the same member through the same gate; the prompt ends when none is left.
        let waiting = false;

        this.#stopWaiting = () => {
            if (waiting) {
                resolve();
            }
        };

        // Attach before writing: fast runs may settle before the prompt response arrives.
        const detach = this.onEvent((event) => {
            if (event.type === "agent_start") {
                waiting = false;
            }

            if (event.type === "agent_settled") {
                if (this.#children === 0 || this.#stopping) {
                    resolve();
                } else {
                    waiting = true;
                }
            }

            // The last result is back. Pi starts the turn it triggers before reporting it, so an idle kernel is done.
            if (waiting && this.#children === 0 && childrenReport(event) === 0) {
                void this.#send({ type: "get_state" })
                    .then((state) => {
                        if (waiting && (state as { isStreaming?: unknown }).isStreaming === false) {
                            resolve();
                        }
                    })
                    .catch(() => {});
            }

            if (event.type === "transport_unknown") {
                reject(this.#failure!);
            }
        });

        // A response rejection can arrive before we await this promise.
        void settled.catch(() => {});
        const timer =
            timeoutMs === undefined
                ? undefined
                : setTimeout(() => this.#fail("kernel run deadline exceeded"), timeoutMs);

        try {
            const data = (await this.#send(
                {
                    type: "prompt",
                    message,
                    ...(images.length ? { images } : {}),
                },
                message.startsWith("/") ? null : undefined,
            )) as {
                disposition?: string;
            };

            if (this.#failure) {
                throw this.#failure;
            }

            if (data?.disposition === "handled") {
                return "handled";
            }

            if (data?.disposition !== "started") {
                this.#fail("unexpected queued prompt disposition");

                throw this.#failure;
            }

            await settled;

            if (this.#failure) {
                throw this.#failure;
            }

            return "settled";
        } finally {
            clearTimeout(timer);
            detach();
            this.#stopWaiting = undefined;
            this.#busy = false;
            this.#prompting = false;
        }
    }

    /** Wait for a native turn or transport event without polling the kernel. */
    waitForActivity(since = this.#activityRevision): Promise<void> {
        if (this.#failure) {
            return Promise.reject(this.#failure);
        }

        if (this.#activityRevision !== since) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            const finish = () => {
                this.#activityWaiters.delete(finish);

                if (this.#failure) {
                    reject(this.#failure);
                } else {
                    resolve();
                }
            };

            this.#activityWaiters.add(finish);
        });
    }

    /** Submit an authorized workflow wake through native prompt handling, not steer/followUp. */
    async wake(
        message: string,
        images: ImageContent[] = [],
        mode: "steer" | "followUp" = "followUp",
    ): Promise<"handled" | "started" | "queued"> {
        const result = (await this.#send({
            type: "prompt",
            message,
            ...(images.length ? { images } : {}),
            streamingBehavior: mode,
        })) as { disposition?: unknown };

        if (!["handled", "started", "queued"].includes(String(result.disposition))) {
            throw new RpcFailure("unknown", "native workflow wake disposition is unknown");
        }

        return result.disposition as "handled" | "started" | "queued";
    }

    /** Dispatch one native extension command while another agent turn is streaming. */
    async command(message: string): Promise<void> {
        const result = (await this.#send({ type: "prompt", message }, null)) as {
            disposition?: unknown;
        };

        if (result.disposition !== "handled") {
            throw new RpcFailure(
                "unknown",
                "native command was not handled; work may have started",
            );
        }
    }

    /** Read the native context-view measurements through Team's Web-safe adapter, without model inference. */
    async context(view: "usage" | "injections"): Promise<Record<string, unknown>> {
        const nonce = randomUUID();
        let result: Record<string, unknown> | undefined;
        const detach = this.onEvent((event) => {
            if (
                event.type !== "extension_ui_request" ||
                event.method !== "notify" ||
                typeof event.message !== "string"
            ) {
                return;
            }

            try {
                const value = parseWithWork("native-rpc", event.message) as {
                    kind?: unknown;
                    nonce?: unknown;
                    result?: unknown;
                };

                if (
                    value.kind === "team-kernel-context-v1" &&
                    value.nonce === nonce &&
                    value.result &&
                    typeof value.result === "object" &&
                    !Array.isArray(value.result)
                ) {
                    result = value.result as Record<string, unknown>;
                }
            } catch {}
        });

        try {
            await this.command(`/team-kernel-context ${JSON.stringify({ nonce, view })}`);
        } finally {
            detach();
        }

        if (!result) {
            throw new RpcFailure("unknown", "Native context view did not return its outcome");
        }

        return result;
    }

    /** Forward native cancellation, canonical draft text and persisted summary evidence through the Team bridge. */
    async navigateTree(
        entryId: string,
        summarize: boolean,
    ): Promise<{
        cancelled: boolean;
        editorText?: string;
        summaryEntry?: RpcRecord;
    }> {
        const nonce = randomUUID();
        let result:
            | {
                  cancelled: boolean;
                  editorText?: string;
                  summaryEntry?: RpcRecord;
              }
            | undefined;
        const detach = this.onEvent((event) => {
            if (
                event.type !== "extension_ui_request" ||
                event.method !== "notify" ||
                typeof event.message !== "string"
            ) {
                return;
            }

            let value;

            try {
                value = parseWithWork("native-rpc", event.message);
            } catch {
                return;
            }

            if (
                value?.kind === "team-kernel-tree-v1" &&
                value.nonce === nonce &&
                typeof value.result?.cancelled === "boolean"
            ) {
                result = value.result;
            }
        });

        try {
            await this.command(
                `/team-kernel-tree ${JSON.stringify({ nonce, entryId, summarize })}`,
            );
        } finally {
            detach();
        }

        if (!result) {
            throw new RpcFailure("unknown", "Native tree navigation did not return its outcome");
        }

        return result;
    }

    /** Wait for native extension follow-up work to become idle through the Team-owned barrier command. */
    async barrier(): Promise<void> {
        const nonce = randomUUID();
        let acknowledged = false;
        let extensionError: RpcRecord | undefined;
        const detach = this.onEvent((event) => {
            if (event.type === "extension_error") {
                extensionError = event;
            }

            if (
                event.type === "extension_ui_request" &&
                event.method === "notify" &&
                typeof event.message === "string"
            ) {
                try {
                    const marker = parseWithWork("native-rpc", event.message) as {
                        kind?: unknown;
                        nonce?: unknown;
                        ok?: unknown;
                    };

                    if (
                        marker.kind === "team-kernel-barrier-v1" &&
                        marker.nonce === nonce &&
                        marker.ok === true
                    ) {
                        acknowledged = true;
                    }
                } catch {}
            }
        });

        try {
            const message = `/team-kernel-barrier ${nonce}`;

            if (this.#busy) {
                await this.command(message);
            } else {
                await this.prompt(message);
            }
        } finally {
            detach();
        }

        if (extensionError) {
            throw new RpcFailure(
                "unknown",
                `Native barrier failed: ${String(extensionError.error ?? "unknown error")}`,
            );
        }

        if (!acknowledged) {
            throw new RpcFailure("unknown", "Native barrier acknowledgement was not observed");
        }
    }

    /** Stop the running prompt and the background subagents it started. It does not wait for their results. */
    async abort(): Promise<void> {
        this.#stopping = true;

        for (const id of this.#dialogs ?? []) {
            this.#write({ type: "extension_ui_response", id, cancelled: true });
        }

        this.#dialogs = null;
        await this.#send({ type: "abort" });

        for (const wake of this.#activityWaiters) {
            wake();
        }

        if (this.#children > 0) {
            // An extension command runs at once, even while a turn streams.
            await this.#send({ type: "prompt", message: "/team-kernel-stop-children" });
            this.#stopWaiting?.();
        }
    }

    /**
     * Add a message to the running prompt: `steer` joins the current turn, `followUp` waits for it. The same run, the
     * same payer; nothing is queued when no prompt runs.
     */
    async queue(
        message: string,
        mode: "steer" | "followUp",
        images: import("@earendil-works/pi-ai").ImageContent[] = [],
    ): Promise<void> {
        if (!this.#prompting) {
            throw new RpcFailure("rejected", "no running prompt to add a message to");
        }

        await this.#send({
            type: mode === "steer" ? "steer" : "follow_up",
            message,
            ...(images.length ? { images } : {}),
        });
    }

    /** Unlike prompt admission, compact's RPC response arrives after the model operation finishes. */
    async compact(customInstructions: string, timeoutMs = 180_000): Promise<void> {
        if (this.#busy) {
            throw new RpcFailure("rejected", "kernel busy; no implicit queue or payer change");
        }

        this.#busy = true;

        try {
            await this.#send({ type: "compact", customInstructions }, timeoutMs);

            if (this.#failure) {
                throw this.#failure;
            }
        } finally {
            this.#busy = false;
        }
    }

    async close(): Promise<void> {
        this.#shutdown = true;
        this.#child.stdin.end();
        const kill = setTimeout(() => this.#child.kill("SIGKILL"), 3_000);

        try {
            await this.#closed;
        } finally {
            clearTimeout(kill);
        }
        // This proves only this child closed, not that external effects or detached descendants were undone.
    }
}

/** The pending-children count in a team policy report, or undefined for any other record. */
export function childrenReport(record: RpcRecord): number | undefined {
    if (
        record.type !== "extension_ui_request" ||
        record.method !== "notify" ||
        typeof record.message !== "string" ||
        !record.message.startsWith('{"kind":"team-kernel-children-v1"')
    ) {
        return undefined;
    }

    const pending = (parseWithWork("native-rpc", record.message) as { pending?: unknown }).pending;

    return typeof pending === "number" ? pending : undefined;
}
