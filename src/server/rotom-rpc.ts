/** Strict RPC transport. Responses acknowledge commands; only agent_settled ends a run, never proves business success. */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

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
    readonly #closed: Promise<void>;
    readonly #pending = new Map<
        string,
        {
            command: string;
            resolve: (data: unknown) => void;
            reject: (error: Error) => void;
            timer: NodeJS.Timeout;
        }
    >();
    readonly #listeners = new Set<(record: RpcRecord) => void>();
    #failure?: RpcFailure;
    #buffer = "";
    #busy = false;
    #shutdown = false;

    constructor(
        command: string,
        args: string[],
        options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
    ) {
        this.#timeout = options.timeoutMs ?? 30_000;
        this.#child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
            stdio: ["pipe", "pipe", "pipe"],
        });
        const decoder = new StringDecoder("utf8");

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

    onEvent(listener: (record: RpcRecord) => void): () => void {
        this.#listeners.add(listener);

        return () => this.#listeners.delete(listener);
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

        for (const listener of this.#listeners) {
            listener({ type: "transport_unknown" });
        }

        this.#child.kill("SIGTERM");
    }

    #consume(text: string): void {
        if (this.#failure) {
            return;
        }

        this.#buffer += text;
        let end: number;

        while ((end = this.#buffer.indexOf("\n")) >= 0) {
            const line = this.#buffer.slice(0, end).replace(/\r$/, "");

            this.#buffer = this.#buffer.slice(end + 1);

            if (Buffer.byteLength(line) > 8 * 1024 * 1024) {
                this.#fail("RPC record exceeds 8 MiB");

                return;
            }

            let value: RpcRecord;

            try {
                value = JSON.parse(line);
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
                // Dialogs must not silently authorize work in a headless host. Full UI forwarding is a later integration step.
                if (
                    value.type === "extension_ui_request" &&
                    ["select", "confirm", "input", "editor"].includes(String(value.method))
                ) {
                    this.#write({ type: "extension_ui_response", id: value.id, cancelled: true });
                }

                for (const listener of this.#listeners) {
                    listener(value);
                }
            }
        }

        if (Buffer.byteLength(this.#buffer) > 8 * 1024 * 1024) {
            this.#fail("RPC record exceeds 8 MiB");
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
        const disableAutomatic =
            ["set_auto_retry", "set_auto_compaction"].includes(command.type) &&
            command.enabled === false &&
            !this.#busy;

        if (!readOnly.includes(command.type) && command.type !== "abort" && !disableAutomatic) {
            return Promise.reject(new RpcFailure("rejected", "unsupported kernel command"));
        }

        return this.#send(command);
    }

    #send(command: RpcRecord, timeoutMs = this.#timeout): Promise<unknown> {
        if (this.#failure) {
            return Promise.reject(this.#failure);
        }

        if (this.#shutdown) {
            return Promise.reject(new RpcFailure("rejected", "kernel closing"));
        }

        // Bounded pending writes also bound stdin buffering. There is no unbounded prompt queue.
        if (this.#pending.size >= 16 || Buffer.byteLength(JSON.stringify(command)) > 1024 * 1024) {
            return Promise.reject(new RpcFailure("rejected", "RPC admission limit"));
        }

        const id = randomUUID();

        return new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => this.#fail("RPC acknowledgement deadline exceeded"),
                timeoutMs,
            );

            this.#pending.set(id, { command: command.type, resolve, reject, timer });
            this.#write({ ...command, id });
        });
    }

    /** Coding runs have no natural length: without timeoutMs only Stop or process loss ends a run. */
    async prompt(message: string, timeoutMs?: number): Promise<"settled" | "handled"> {
        if (this.#busy) {
            throw new RpcFailure("rejected", "kernel busy; no implicit queue or payer change");
        }

        this.#busy = true;
        let resolve!: () => void, reject!: (error: Error) => void;
        const settled = new Promise<void>((yes, no) => {
            resolve = yes;
            reject = no;
        });
        // Attach before writing: fast runs may settle before the prompt response arrives.
        const detach = this.onEvent((event) => {
            if (event.type === "agent_settled") {
                resolve();
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
            const data = (await this.#send({ type: "prompt", message })) as {
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
            this.#busy = false;
        }
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
