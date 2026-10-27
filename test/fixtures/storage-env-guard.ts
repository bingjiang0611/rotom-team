/** Assert the production storage worker receives neither ambient credentials nor extra startup data. */
import assert from "node:assert/strict";
import { isMainThread, workerData } from "node:worker_threads";

if (!isMainThread && workerData?.storageWorker === true) {
    assert.deepEqual(Object.keys(process.env), []);
    assert.deepEqual(Object.keys(workerData).sort(), ["data", "storageWorker"]);
}
