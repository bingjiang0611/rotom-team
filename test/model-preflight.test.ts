import assert from "node:assert/strict";
import { test } from "node:test";
import type { KernelBinding } from "../src/server/rotom-journal.ts";
import { RpcFailure, type RotomRpc, type RpcRecord } from "../src/server/rotom-rpc.ts";
import type { PersistentKernel } from "../src/server/rotom-executions/contracts.ts";
import { prepareRetainedModel } from "../src/server/rotom-executions/model-preflight.ts";

function fixture() {
    const calls: string[] = [];
    const persistent = {
        revision: "same",
        needsReload: false,
        rebind: () => calls.push("rotate"),
        kernel: {
            command: async (command: string) => {
                calls.push(command);
            },
            barrier: async () => {
                calls.push("barrier");
            },
        } as unknown as RotomRpc,
    } as unknown as PersistentKernel;
    const args = {
        persistent,
        binding: {} as KernelBinding,
        prepared: undefined,
        revision: "same",
        prompt: "ordinary next prompt",
        rebind: false,
        reusing: true,
        extensionError: (): RpcRecord | undefined => undefined,
    };

    return { calls, persistent, args };
}

test("retained switch rotates before native rebind, defers one full reload, then clears it", async () => {
    const { calls, persistent, args } = fixture();

    await prepareRetainedModel({ ...args, rebind: true });
    assert.deepEqual(calls, ["rotate", "/team-kernel-rebind", "barrier"]);
    assert.equal(persistent.needsReload, true);
    await prepareRetainedModel(args);
    assert.deepEqual(calls.slice(3), ["/team-kernel-reload", "barrier"]);
    assert.equal(persistent.needsReload, false);
    await prepareRetainedModel(args);
    assert.equal(calls.length, 5);
});

test("explicit reload remains owned by its operation adapter, not a duplicate preflight", async () => {
    const { calls, persistent, args } = fixture();

    persistent.needsReload = true;
    await prepareRetainedModel({ ...args, prompt: "/reload", revision: "edited" });
    assert.deepEqual(calls, []);
    assert.equal(persistent.needsReload, true, "only successful explicit dispatch may clear it");
});

test("a resource edit still reloads without any model switch", async () => {
    const { calls, args } = fixture();

    await prepareRetainedModel({ ...args, revision: "edited" });
    assert.deepEqual(calls, ["/team-kernel-reload", "barrier"]);
});

test("extension failures stay unknown and never clear pending resources or retry", async () => {
    for (const rebind of [true, false]) {
        const { calls, persistent, args } = fixture();

        persistent.needsReload = true;
        await assert.rejects(
            prepareRetainedModel({
                ...args,
                rebind,
                extensionError: () => ({ type: "extension_error", error: "injected" }),
            }),
            (error: unknown) => error instanceof RpcFailure && error.outcome === "unknown",
        );
        assert.equal(persistent.needsReload, true);
        assert.equal(calls.filter((call) => call.startsWith("/team-kernel-")).length, 1);
    }
});
