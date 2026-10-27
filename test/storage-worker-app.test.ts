import { root, work, cleanUp, context } from "./helpers.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import { mkdirSync, realpathSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { PocketApp } from "../src/server/app.ts";
import { StorageWorker } from "../src/server/storage-worker.ts";
import { Browsers } from "../src/server/browser.ts";

const options = (name: string) => {
    const dataDir = join(realpathSync(root), name);

    mkdirSync(dataDir, { mode: 0o700 });

    return {
        dataDir,
        defaultCwd: realpathSync(work),
        kernel: true,
        supervised: false,
        browser: null,
        log: () => {},
    };
};

function observeWorkers(t: TestContext) {
    const workers: StorageWorker[] = [];
    const ready = StorageWorker.prototype.ready;

    t.mock.method(StorageWorker.prototype, "ready", function (this: StorageWorker) {
        workers.push(this);

        return ready.call(this);
    });

    return workers;
}

test.after(cleanUp);

for (const storageWorker of [undefined, false, true]) {
    test(`storage worker switch is explicit (value=${storageWorker})`, async (t) => {
        const workers = observeWorkers(t);
        const config = options(`worker-switch-${storageWorker}`);
        const app = await PocketApp.open({ ...config, storageWorker });

        try {
            assert.equal(workers.length, storageWorker === true ? 1 : 0);
            assert.equal(await app.kernel!.executions.journal.hasConversation("missing"), false);
            assert.ok(existsSync(join(config.dataDir, "kernel.lock")));
        } finally {
            await app.close();
        }

        assert.equal(existsSync(join(config.dataDir, "kernel.lock")), false);
        assert.equal(existsSync(join(config.dataDir, "harness.lock")), false);
    });
}

test("storage worker cannot silently enable in a kernel-disabled server", async () => {
    const config = options("worker-invalid-mode");

    await assert.rejects(
        PocketApp.open({ ...config, kernel: false, storageWorker: true }),
        /requires native kernel/,
    );
    assert.equal(existsSync(join(config.dataDir, "harness.lock")), false);
});

test("worker shutdown joins the startup continuation coordinator before journal closure", async (t) => {
    const config = options("worker-resume-drain");
    const workers = observeWorkers(t);
    const app = await PocketApp.open({ ...config, storageWorker: true });
    const kernel = app.kernel!;

    await kernel.resumeInterrupted();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let resumed = false;
    let closedBeforeResume = false;
    const close = kernel.executions.close.bind(kernel.executions);

    t.mock.method(kernel.executions.journal, "resumes", async () => {
        entered.resolve();
        await release.promise;
        resumed = true;

        return [];
    });
    t.mock.method(kernel.executions, "close", () => {
        closedBeforeResume = !resumed;

        return close();
    });
    const resume = kernel.resumeInterrupted();

    await entered.promise;
    const closing = app.close();

    void closing.catch(() => {});

    try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        release.resolve();
        await resume;
        await closing;
        assert.equal(
            closedBeforeResume,
            false,
            "journal cannot close before the coordinator drains",
        );
    } finally {
        release.resolve();
        await resume.catch(() => {});
        await closing.catch(() => {});
        await close();
        await workers[0]!.close();
        rmSync(join(config.dataDir, "harness.lock"), { force: true });
    }
});

test("failed worker initialization still closes parent resources and retains both leases", async (t) => {
    const config = options("worker-ready-failure");
    const workers = observeWorkers(t);
    const browsers = t.mock.method(Browsers.prototype, "closeAll");
    const terminate = Worker.prototype.terminate;
    let exited: Promise<number> | undefined;

    t.mock.method(Worker.prototype, "terminate", function (this: Worker) {
        exited = terminate.call(this);

        return exited;
    });
    mkdirSync(join(config.dataDir, "pocket.sqlite"));
    await assert.rejects(
        PocketApp.open({ ...config, storageWorker: true }),
        /Startup failed and cleanup remains fenced/,
    );
    await exited;
    assert.equal(workers.length, 1);
    assert.equal(workers[0]!.closed, false);
    assert.equal(browsers.mock.callCount(), 1);
    assert.deepEqual(browsers.mock.calls[0]!.arguments, [{ final: true }]);
    assert.ok(existsSync(join(config.dataDir, "kernel.lock")));
    assert.ok(existsSync(join(config.dataDir, "harness.lock")));
});

test("a Harness.open failure closes the already-open worker before releasing app ownership", async (t) => {
    const config = options("worker-startup-failure");

    t.mock.method(Harness, "open", async () => {
        throw new Error("fixture early Harness.open failure");
    });
    await assert.rejects(PocketApp.open({ ...config, storageWorker: true }), /early Harness.open/);
    assert.equal(existsSync(join(config.dataDir, "kernel.lock")), false);
    assert.equal(existsSync(join(config.dataDir, "harness.lock")), false);
});

for (const failCleanup of [false, true]) {
    test(`parent environment cleanup precedes final lease release (failure=${failCleanup})`, async (t) => {
        const config = options(`worker-env-close-${failCleanup}`);
        const workers = observeWorkers(t);
        const app = await PocketApp.open({ ...config, storageWorker: true });
        const env = app.envFor(ROOT_CONVERSATION_ID);
        const cleanup = env.cleanup.bind(env);
        let leasesHeldDuringCleanup = false;
        const mocked = t.mock.method(env, "cleanup", async () => {
            leasesHeldDuringCleanup =
                !workers[0]!.closed &&
                existsSync(join(config.dataDir, "kernel.lock")) &&
                existsSync(join(config.dataDir, "harness.lock"));

            if (failCleanup) {
                throw new Error("fixture environment closure unconfirmed");
            }

            await cleanup(context);
        });

        try {
            if (failCleanup) {
                await assert.rejects(app.close(), /Shutdown incomplete/);
            } else {
                await app.close();
            }

            assert.equal(
                leasesHeldDuringCleanup,
                true,
                "leases must survive until parent environment cleanup is confirmed",
            );
            assert.equal(existsSync(join(config.dataDir, "kernel.lock")), failCleanup);
            assert.equal(existsSync(join(config.dataDir, "harness.lock")), failCleanup);
        } finally {
            mocked.mock.restore();
            await cleanup(context);
            await workers[0]!.close();
            // This fixture owns no native/legacy processes, and the real environment cleanup just completed.
            rmSync(join(config.dataDir, "harness.lock"), { force: true });
        }
    });
}

test("an unconfirmed owner shutdown cannot release the app lock", async (t) => {
    const config = options("worker-close-failure");
    const workers = observeWorkers(t);
    const app = await PocketApp.open({ ...config, storageWorker: true });
    const owner = workers[0]!;
    const close = owner.close.bind(owner);
    const mocked = t.mock.method(owner, "close", async () => {
        throw new Error("fixture missing final close ACK");
    });

    try {
        await assert.rejects(app.close(), /missing final close ACK/);
        assert.ok(existsSync(join(config.dataDir, "kernel.lock")));
        assert.ok(existsSync(join(config.dataDir, "harness.lock")));
    } finally {
        mocked.mock.restore();
        await close();
        // The fixture knows native shutdown completed; the product never clears this failed-close fence.
        rmSync(join(config.dataDir, "harness.lock"));
    }
});
