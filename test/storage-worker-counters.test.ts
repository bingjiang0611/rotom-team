import { snapshot, since, nativeTimingSnapshot, nativeTimingSince } from "./perf/counters.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { mkdtempSync, realpathSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageWorker } from "../src/server/storage-worker.ts";
import { RotomJournal, type KernelBinding } from "../src/server/rotom-journal.ts";
import { roomPartChannel, scopedParseObject } from "../src/server/perf-channels.ts";

function fixture() {
    const data = realpathSync(mkdtempSync(join(tmpdir(), "worker-counters-")));
    const home = join(data, "kernel-homes", "alice");
    const workspace = join(data, "workspace");

    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(workspace);
    const binding: KernelBinding = {
        home,
        workspace,
        memberId: "alice",
        kernelVersion: "fixture",
        provider: "fixture",
        model: "fixture",
        accountGeneration: "fixture",
        configurationDigest: "fixture",
    };

    return { data, binding };
}

test("real worker counters match local journal work and preserve room/table attribution", async () => {
    const remote = fixture();
    const local = fixture();
    const inheritedPreloads = process.execArgv.flatMap((arg, index) =>
        arg === "--import" ? [arg, process.execArgv[index + 1]!] : [],
    );
    const worker = new Worker(new URL("../src/server/storage-worker-thread.ts", import.meta.url), {
        workerData: { data: remote.data, storageWorker: true },
        env: {},
        execArgv: [
            ...inheritedPreloads,
            ...(process.env.ROTOM_TEST_NO_WORKER_COUNTERS
                ? []
                : ["--import", new URL("./perf/storage-worker-preload.ts", import.meta.url).href]),
        ],
    });
    const owner = new StorageWorker(remote.data, worker);
    const journal = scopedParseObject("journal", new RotomJournal(local.data));

    try {
        await owner.ready();
        await owner.journal.bind("source", remote.binding);
        journal.bind("source", local.binding);
        const beforeRemote = snapshot();
        const timingBefore = nativeTimingSnapshot();

        await roomPartChannel.runStores({ part: "kernel" }, () =>
            owner.journal.roomSnapshot("source"),
        );
        const remoteWork = since(beforeRemote);
        const beforeLocal = snapshot();

        roomPartChannel.runStores({ part: "kernel" }, () => journal.roomSnapshot("source"));
        const localWork = since(beforeLocal);

        assert.equal(
            remoteWork["storage.worker.unavailable"] ?? 0,
            0,
            "unmeasured worker work must not become zero",
        );

        for (const metric of [
            "sql.statements",
            "sql.rows",
            "json.parse.calls",
            "json.parse.chars",
            "view.kernel.project.calls",
            "view.kernel.sql.statements",
            "view.kernel.sql.heads",
            "view.kernel.sql.attempts",
            "view.kernel.json.parse.calls",
        ]) {
            assert.ok(localWork[metric]! > 0, `local ${metric} is actually exercised`);
            assert.equal(remoteWork[metric], localWork[metric], metric);
        }

        assert.ok(remoteWork["storage.worker.replyBytes"]! > 0);
        assert.ok(remoteWork["storage.worker.requestBytes"]! > 0);
        assert.equal(remoteWork["v8.serialize.calls"], 2);
        assert.equal(remoteWork["v8.deserialize.calls"], 2);
        assert.ok(nativeTimingSince(timingBefore).storageWorkerV8SerializeMs! > 0);
        const beforeHistory = snapshot();

        await owner.journal.segmentEntries("missing");
        assert.equal(
            since(beforeHistory)["journal.segmentEntries.calls"],
            1,
            "the history observer cannot disappear into the worker",
        );
    } finally {
        journal.close();
        await owner.close();
        rmSync(local.data, { recursive: true, force: true });
        rmSync(remote.data, { recursive: true, force: true });
    }
});
