/** Bounded byte pages for a single outstanding storage operation, never a replay protocol. */
import { serialize, deserialize } from "node:v8";
import type { Transferable } from "node:worker_threads";
import type { StorageWorkerMetrics, RoomPartSignal } from "./perf-channels.ts";

type StoragePort = { postMessage(message: unknown, transfer?: readonly Transferable[]): void };

export const STORAGE_PAGE_BYTES = 1024 * 1024;
export const STORAGE_VALUE_BYTES = 256 * 1024 * 1024;
export const STORAGE_QUEUE_LENGTH = 128;
export const STORAGE_TIMEOUT_MS = 120_000;
export const STORAGE_METHODS = [
    "commit",
    "mintId",
    "conversation",
    "scanConversations",
    "entry",
    "findLatestHeadMarker",
    "scanEntries",
    "task",
    "scanTasks",
    "submission",
    "scanSubmissions",
    "submissionByRequest",
    "findDocument",
    "document",
    "scanDocuments",
    "close",
] as const;

export function encodeStorage(value: unknown): Buffer {
    const bytes = serialize(value);

    if (bytes.length > STORAGE_VALUE_BYTES) {
        throw new Error("Storage operation exceeds the 256 MiB serialized value limit");
    }

    return bytes;
}

type Packet =
    | { type: "value"; id: number; size: number; metrics?: StorageWorkerMetrics }
    | { type: "next"; id: number; offset: number }
    | { type: "page"; id: number; offset: number; bytes: Uint8Array }
    | { type: "received"; id: number };

/** One page is in transit at a time. A whole captured result is bounded and retained only until its ACK. */
export class StoragePages {
    readonly #port: StoragePort;
    readonly #value: (id: number, value: unknown, metrics?: StorageWorkerMetrics) => void;
    #sending?: { id: number; bytes: Buffer; offset: number; done: () => void };
    #receiving?: { id: number; bytes: Buffer; offset: number; metrics?: StorageWorkerMetrics };

    constructor(
        port: StoragePort,
        value: (id: number, value: unknown, metrics?: StorageWorkerMetrics) => void,
    ) {
        this.#port = port;
        this.#value = value;
    }

    send(id: number, bytes: Buffer, metrics?: StorageWorkerMetrics): Promise<void> {
        if (this.#sending) {
            throw new Error("Storage page sender is occupied");
        }

        const sent = Promise.withResolvers<void>();

        this.#sending = { id, bytes, offset: 0, done: sent.resolve };
        this.#port.postMessage({ type: "value", id, size: bytes.length, metrics } satisfies Packet);

        return sent.promise;
    }

    receive(packet: Packet): void {
        if (packet.type === "value") {
            if (
                this.#receiving ||
                !Number.isInteger(packet.size) ||
                packet.size < 1 ||
                packet.size > STORAGE_VALUE_BYTES
            ) {
                throw new Error("Invalid storage value boundary");
            }

            this.#receiving = {
                id: packet.id,
                bytes: Buffer.allocUnsafe(packet.size),
                offset: 0,
                metrics: packet.metrics,
            };
            this.#port.postMessage({ type: "next", id: packet.id, offset: 0 } satisfies Packet);
        } else if (packet.type === "next") {
            const send = this.#sending;

            if (
                !send ||
                send.id !== packet.id ||
                send.offset !== packet.offset ||
                send.offset >= send.bytes.length
            ) {
                throw new Error("Invalid storage page request");
            }

            const offset = send.offset;
            const bytes = Uint8Array.from(send.bytes.subarray(offset, offset + STORAGE_PAGE_BYTES));

            // postMessage detaches the page buffer, including its length.
            send.offset += bytes.length;
            this.#port.postMessage({ type: "page", id: send.id, offset, bytes } satisfies Packet, [
                bytes.buffer,
            ]);
        } else if (packet.type === "page") {
            const receive = this.#receiving;

            if (
                !receive ||
                receive.id !== packet.id ||
                receive.offset !== packet.offset ||
                packet.bytes.length !==
                    Math.min(STORAGE_PAGE_BYTES, receive.bytes.length - receive.offset)
            ) {
                throw new Error("Invalid storage page");
            }

            receive.bytes.set(packet.bytes, receive.offset);
            receive.offset += packet.bytes.length;

            if (receive.offset === receive.bytes.length) {
                this.#receiving = undefined;
                this.#port.postMessage({ type: "received", id: receive.id } satisfies Packet);
                this.#value(receive.id, deserialize(receive.bytes), receive.metrics);
            } else {
                this.#port.postMessage({
                    type: "next",
                    id: receive.id,
                    offset: receive.offset,
                } satisfies Packet);
            }
        } else if (packet.type === "received") {
            const send = this.#sending;

            if (!send || send.id !== packet.id || send.offset !== send.bytes.length) {
                throw new Error("Invalid storage receive ACK");
            }

            this.#sending = undefined;
            send.done();
        } else {
            throw new Error("Unknown storage packet");
        }
    }

    discard(): void {
        this.#sending = undefined;
        this.#receiving = undefined;
    }
}

export type StorageCall = {
    target: "storage" | "journal" | "owner";
    method: string;
    args: unknown[];
    part?: RoomPartSignal["part"];
};
export type StorageReply =
    | { ok: true; value: unknown }
    | { ok: false; error: { kind: "rejected" | "conflict" | "error"; message: string } };
