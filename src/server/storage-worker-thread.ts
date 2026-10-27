/** The only database owner in opt-in worker mode. No Harness, credentials or native processes live here. */
import { parentPort, workerData } from "node:worker_threads";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { RotomJournal, JOURNAL_METHODS, KernelRequestConflict } from "./rotom-journal.ts";
import {
    scopedParseObject,
    roomPartScope,
    storageWorkChannel,
    type StorageWorkSignal,
} from "./perf-channels.ts";
import {
    encodeStorage,
    StoragePages,
    STORAGE_METHODS,
    type StorageCall,
    type StorageReply,
} from "./storage-protocol.ts";

const port = parentPort!;
const data = workerData as { data: string };
const openedAt = performance.now();
// Acquire the journal's exclusive lease before opening either database. It fences both until final exit.
const journal = scopedParseObject("journal", new RotomJournal(data.data));
const storage = scopedParseObject(
    "durable-storage",
    await openNodeSqliteStorage(join(data.data, "pocket.sqlite")),
);
let busy = false;
let journalClosed = false;
let storageClosed = false;
const pages = new StoragePages(port, (id, value) => {
    if (busy) {
        throw new Error("Concurrent storage dispatch");
    }

    busy = true;
    const call = value as StorageCall;

    void (call.part ? roomPartScope.run(call.part, () => execute(id, call)) : execute(id, call));
});

port.on("message", (packet) => pages.receive(packet));
await sendReply(0, { ok: true, value: undefined }, openedAt);

function sendReply(id: number, reply: StorageReply, started: number): Promise<void> {
    const bytes = encodeStorage(reply);
    const work: StorageWorkSignal = {};

    storageWorkChannel.publish(work);

    return pages.send(id, bytes, {
        ...work,
        workerMs: performance.now() - started,
        replyBytes: bytes.length,
    });
}

async function execute(id: number, call: StorageCall): Promise<void> {
    const started = performance.now();
    let reply: StorageReply;
    const shutdown = call.target === "owner" && call.method === "close";

    try {
        let value: unknown;

        if (shutdown) {
            if (!journalClosed) {
                journal.close(false);
                journalClosed = true;
            }

            if (!storageClosed) {
                await storage.close(context);
                storageClosed = true;
            }
        } else if (
            call.target === "journal" &&
            !journalClosed &&
            JOURNAL_METHODS.has(call.method)
        ) {
            value =
                call.method === "close"
                    ? journal.close(false)
                    : Reflect.apply(Reflect.get(journal, call.method), journal, call.args);
            journalClosed = call.method === "close";
        } else if (
            call.target === "storage" &&
            !storageClosed &&
            (STORAGE_METHODS as readonly string[]).includes(call.method)
        ) {
            const args = call.method === "mintId" ? call.args : [...call.args, context];

            value = await Reflect.apply(Reflect.get(storage, call.method), storage, args);
            storageClosed = call.method === "close";
        } else {
            throw new Error("Storage endpoint is closed or method is unavailable");
        }

        reply = { ok: true, value };
    } catch (error) {
        // A failed close cannot be repaired by retrying a half-closed implementation.
        // Other acknowledged errors retain their public Storage identity; Session decides poisoning.
        if (call.method === "close") {
            throw error;
        }

        // The public root export loads runtime modules; only a Storage error needs that class identity.
        const rejected =
            call.target === "storage" &&
            error instanceof (await import("@earendil-works/pi-durable")).StorageRejected;

        reply = {
            ok: false,
            error: {
                kind: rejected
                    ? "rejected"
                    : error instanceof KernelRequestConflict
                      ? "conflict"
                      : "error",
                message: String(error instanceof Error ? error.message : error).slice(0, 4096),
            },
        };
    }

    // Serialization/transfer failure after a commit is uncertain. Exit, keep leases, never claim rejection.
    await sendReply(id, reply, started);
    busy = false;

    if (shutdown) {
        port.close();
    }
}
