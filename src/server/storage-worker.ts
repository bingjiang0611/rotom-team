/** Parent-side FIFO/ACK boundary. Database ownership never falls back to the parent after failure. */
import { Worker } from "node:worker_threads";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { StorageRejected, type Storage } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { roomPartScope, storageWorkerChannel, type StorageWorkerMetrics } from "./perf-channels.ts";
import { JOURNAL_METHODS, KernelRequestConflict, type AsyncRotomJournal } from "./rotom-journal.ts";
import {
    encodeStorage,
    StoragePages,
    STORAGE_METHODS,
    STORAGE_QUEUE_LENGTH,
    STORAGE_VALUE_BYTES,
    STORAGE_TIMEOUT_MS,
    type StorageCall,
    type StorageReply,
} from "./storage-protocol.ts";

type Pending = {
    id: number;
    bytes: Buffer;
    encodeMs: number;
    queuedAt: number;
    dispatchedAt?: number;
    finish: (reply: StorageReply) => void;
    reject: (error: unknown) => void;
    detach?: () => void;
};

export class StorageWorker {
    readonly storage: Storage;
    readonly journal: AsyncRotomJournal;
    readonly #worker: Worker;
    readonly #data: string;
    readonly #timeoutMs: number;
    readonly #pages: StoragePages;
    readonly #startedAt = performance.now();
    readonly #ready = Promise.withResolvers<void>();
    readonly #exit = Promise.withResolvers<number>();
    readonly #queue: Pending[] = [];
    #queuedBytes = 0;
    #id = 0;
    #active?: Pending;
    #failure?: Error;
    #timer?: NodeJS.Timeout;
    #readyDone = false;
    #closing?: Promise<void>;
    #shutdownAck = false;
    #closed = false;
    #sealed = new Map<string, Promise<unknown>>();

    // Ownership is established synchronously, before ready() can fail during partial startup.
    // An injected owned Worker lets fault fixtures exercise this same transport and real databases.
    constructor(
        data: string,
        worker = new Worker(new URL("./storage-worker-thread.ts", import.meta.url), {
            workerData: { data, storageWorker: true },
            env: {}, // No inherited provider credentials; this owner only needs explicit database paths.
        }),
        timeoutMs = STORAGE_TIMEOUT_MS,
    ) {
        this.#worker = worker;
        this.#data = data;
        this.#timeoutMs = timeoutMs;
        this.#pages = new StoragePages(worker, (id, value, metrics) =>
            this.#received(id, value as StorageReply, metrics),
        );
        this.storage = Object.fromEntries(
            STORAGE_METHODS.map((method) => [
                method,
                (...args: unknown[]) => {
                    const context = method === "mintId" ? undefined : (args.pop() as Context);

                    return this.#endpoint("storage", method, args, context);
                },
            ]),
        ) as unknown as Storage;

        this.journal = Object.fromEntries(
            [...JOURNAL_METHODS].map((method) => [
                method,
                (...args: unknown[]) => this.#endpoint("journal", method, args),
            ]),
        ) as AsyncRotomJournal;

        worker.on("message", (packet) => {
            if (this.#failure) {
                return;
            }

            try {
                this.#pages.receive(packet);
            } catch (error) {
                this.#fail(error);
            }
        });
        worker.on("error", (error) => this.#fail(error));
        worker.on("exit", (code) => {
            this.#exit.resolve(code);

            if (!this.#shutdownAck || code !== 0) {
                this.#fail(
                    new Error(
                        `Storage worker exited (${code}); outcomes may be unknown; do not replay`,
                    ),
                );
            }
        });
        void this.#ready.promise.catch(() => {});
        this.#armDeadline();
    }

    get closed(): boolean {
        return this.#closed;
    }

    ready(): Promise<void> {
        return this.#ready.promise;
    }

    #armDeadline(): void {
        clearTimeout(this.#timer);
        this.#timer = setTimeout(
            () =>
                this.#fail(
                    new Error(
                        "Storage worker ACK deadline exceeded; outcome unknown; do not replay",
                    ),
                ),
            this.#timeoutMs,
        );
    }

    #fail(cause: unknown): void {
        if (this.#failure) {
            return;
        }

        this.#failure = cause instanceof Error ? cause : new Error(String(cause));
        clearTimeout(this.#timer);
        this.#ready.reject(this.#failure);
        this.#active?.reject(this.#failure);
        this.#active = undefined;

        for (const pending of this.#queue.splice(0)) {
            pending.detach?.();
            pending.reject(this.#failure);
        }

        this.#queuedBytes = 0;
        this.#pages.discard();
        // This thread owns only databases, not native tools. Termination is not evidence of rollback or safe lease release.
        void this.#worker.terminate();
    }

    #received(id: number, reply: StorageReply, metrics?: StorageWorkerMetrics): void {
        clearTimeout(this.#timer);
        const pendingMetrics = this.#active;

        if (metrics) {
            storageWorkerChannel.publish({
                ...metrics,
                requestBytes: pendingMetrics?.bytes.length ?? 0,
                encodeMs: pendingMetrics?.encodeMs ?? 0,
                queueMs: pendingMetrics
                    ? pendingMetrics.dispatchedAt! - pendingMetrics.queuedAt
                    : 0,
                roundTripMs: performance.now() - (pendingMetrics?.dispatchedAt ?? this.#startedAt),
            });
        }

        if (id === 0 && !this.#readyDone) {
            if (!reply.ok) {
                this.#fail(new Error("Storage worker startup failed"));

                return;
            }

            this.#readyDone = true;
            this.#ready.resolve();
            this.#pump();

            return;
        }

        const pending = this.#active;

        if (!pending || pending.id !== id) {
            throw new Error("Unexpected storage ACK");
        }

        this.#active = undefined;
        this.#queuedBytes -= pending.bytes.length;
        pending.finish(reply);
        this.#pump();
    }

    #endpoint(
        target: "storage" | "journal",
        method: string,
        args: unknown[],
        context?: Context,
    ): Promise<unknown> {
        if (method === "close") {
            let closing = this.#sealed.get(target);

            if (!closing) {
                closing = this.#request({ target, method, args: [] });
                this.#sealed.set(target, closing);
            }

            return closing;
        }

        if (this.#sealed.has(target)) {
            return Promise.reject(new Error("Storage endpoint is closed"));
        }

        return this.#request({ target, method, args }, context);
    }

    async #request(call: StorageCall, context?: Context): Promise<unknown> {
        if (this.#failure) {
            throw this.#failure;
        }

        if (this.#closing && call.target !== "owner") {
            throw new Error("Storage worker is closing");
        }

        context?.abortSignal?.throwIfAborted();
        let bytes: Buffer;
        const encodingAt = performance.now();

        try {
            bytes = encodeStorage({ ...call, part: roomPartScope.getStore() });

            // At most three deduplicated, argument-free closes may follow a full ordinary queue.
            // Lifecycle requests must drain that queue, not strand it behind a cached capacity rejection.
            if (
                call.method !== "close" &&
                (this.#queue.length + Number(!!this.#active) >= STORAGE_QUEUE_LENGTH ||
                    this.#queuedBytes + bytes.length > STORAGE_VALUE_BYTES)
            ) {
                throw new Error("Storage queue capacity exceeded before dispatch");
            }
        } catch (error) {
            if (call.target === "storage") {
                throw new StorageRejected(String(error instanceof Error ? error.message : error));
            }

            throw error;
        }

        const result = Promise.withResolvers<unknown>();
        const pending: Pending = {
            id: ++this.#id,
            bytes,
            reject: result.reject,
            encodeMs: performance.now() - encodingAt,
            queuedAt: performance.now(),
            finish: (reply) => {
                if (reply.ok) {
                    if (call.target === "owner") {
                        this.#shutdownAck = true;
                    }

                    result.resolve(reply.value);
                } else {
                    const ErrorClass =
                        reply.error.kind === "rejected"
                            ? StorageRejected
                            : reply.error.kind === "conflict"
                              ? KernelRequestConflict
                              : Error;

                    result.reject(new ErrorClass(reply.error.message));
                }
            },
        };
        const signal = context?.abortSignal;

        if (signal) {
            const abort = () => {
                const index = this.#queue.indexOf(pending);

                if (index !== -1) {
                    this.#queue.splice(index, 1);
                    this.#queuedBytes -= bytes.length;
                    pending.detach?.();
                    result.reject(signal.reason);
                }
            };

            signal.addEventListener("abort", abort, { once: true });
            pending.detach = () => signal.removeEventListener("abort", abort);
        }

        this.#queuedBytes += bytes.length;
        this.#queue.push(pending);
        this.#pump();

        return result.promise;
    }

    #pump(): void {
        if (!this.#readyDone || this.#active || this.#failure) {
            return;
        }

        const pending = this.#queue.shift();

        if (!pending) {
            return;
        }

        this.#active = pending;
        pending.dispatchedAt = performance.now();
        // Once dispatched, cancellation cannot establish rollback. The durable operation keeps its ACK obligation.
        pending.detach?.();
        this.#armDeadline();

        try {
            void this.#pages.send(pending.id, pending.bytes);
        } catch (error) {
            this.#fail(error);
        }
    }

    close(): Promise<void> {
        this.#closing ??= (async () => {
            await this.#request({ target: "owner", method: "close", args: [] });
            this.#armDeadline();
            const code = await this.#exit.promise;

            clearTimeout(this.#timer);

            if (this.#failure || code !== 0) {
                throw this.#failure ?? new Error("Storage worker did not close cleanly");
            }

            // Both databases closed, final ACK received, thread exit observed; caller has already drained native work.
            rmSync(join(this.#data, "kernel.lock"));
            this.#closed = true;
        })();

        return this.#closing;
    }
}
