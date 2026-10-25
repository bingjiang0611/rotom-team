/** Faults run against the real public stores, before the production thread entrypoint opens them. */
import { workerData } from "node:worker_threads";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { StorageRejected } from "@earendil-works/pi-durable";
import { RotomJournal } from "../../src/server/rotom-journal.ts";

const fault = workerData.fault as string | undefined;
const commit = SqliteStorage.prototype.commit;
let calls = 0;

function hold() {
    const control = new Int32Array(workerData.control);

    Atomics.store(control, 0, 1);
    Atomics.notify(control, 0);
    Atomics.wait(control, 1, 0);
}

SqliteStorage.prototype.commit = async function (...args) {
    if (fault === "reject-once" && calls++ === 0) {
        throw new StorageRejected("fixture rejection before commit");
    }

    if (fault === "hold-commit") {
        hold();
    }

    const result = await commit.apply(this, args);

    if (fault === "crash-after-commit") {
        process.exit(41);
    }

    if (fault === "error-after-commit") {
        throw new Error("fixture uncertain commit error");
    }

    return result;
};

if (fault === "close-error") {
    SqliteStorage.prototype.close = async () => {
        throw new Error("fixture storage close failure");
    };
}

if (workerData.control) {
    const read = RotomJournal.prototype.hasConversation;

    RotomJournal.prototype.hasConversation = function (id) {
        if (id === "hold-worker") {
            hold();
        }

        return read.call(this, id);
    };
}

await import("../../src/server/storage-worker-thread.ts");
