/** Keep the restart-prefix negative guard effective inside the storage owner too. */
import { isMainThread, workerData } from "node:worker_threads";

if (!isMainThread && workerData?.storageWorker === true) {
    const { RotomJournal } = await import("../../src/server/rotom-journal.ts");

    RotomJournal.prototype.entries = () => {
        throw new Error("Startup mirror must not parse the historical prefix");
    };
}
