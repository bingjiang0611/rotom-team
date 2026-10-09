import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RotomRpc, RpcFailure } from "../src/server/rotom-rpc.ts";
const fixture = fileURLToPath(new URL("./fixtures/rotom-rpc.mjs", import.meta.url));

const client = async (mode: string) => {
    const rpc = new RotomRpc(process.execPath, [fixture, mode], {
        cwd: process.cwd(),
        env: {},
        timeoutMs: 1000,
    });
    const ready = Promise.withResolvers<void>();
    const detach = rpc.onEvent((event) => {
        if (event.type === "fixture_ready") {
            ready.resolve();
        }
    });
    const timer = setTimeout(() => ready.reject(new Error("RPC fixture startup timeout")), 10_000);

    try {
        await ready.promise;

        return rpc;
    } catch (error) {
        await rpc.close();

        throw error;
    } finally {
        clearTimeout(timer);
        detach();
    }
};

for (const mode of ["normal", "fast", "unicode"]) {
    test(`RPC ${mode}: wait for settled, not acknowledgement/agent_end`, async () => {
        const rpc = await client(mode),
            events: string[] = [];

        rpc.onEvent((e) => {
            events.push(e.type);

            if (mode === "unicode" && e.type === "message_update") {
                assert.equal(e.text, "中\u2028间\u2029🙂");
            }
        });

        try {
            assert.equal(await rpc.prompt("test"), "settled");
            assert.ok(events.includes("agent_settled"));
            assert.deepEqual(await rpc.request({ type: "get_state" }), {
                cleanEnvironment: true,
                cwd: process.cwd(),
            });
        } finally {
            await rpc.close();
        }
    });
}

test("handled commands do not wait for a nonexistent run; explicit rejection stays rejected", async () => {
    const handled = await client("handled");

    try {
        assert.equal(await handled.prompt("/command"), "handled");
        const rejected = await client("reject");

        try {
            await assert.rejects(
                rejected.prompt("rejected"),
                (e) => e instanceof RpcFailure && e.outcome === "rejected",
            );
        } finally {
            await rejected.close();
        }
    } finally {
        await handled.close();
    }
});

for (const [mode, reason] of [
    ["exit", "kernel disconnected"],
    ["malformed", "invalid RPC JSONL"],
    ["wrong-id", "uncorrelated RPC response"],
    ["oversized", "RPC record exceeds 8 MiB"],
    ["hang", "kernel run deadline exceeded"],
    ["settled-corrupt", "invalid RPC JSONL"],
] as const) {
    test(`RPC ${mode}: ambiguity fences future writes, never redispatches`, async () => {
        const rpc = await client(mode);

        try {
            await assert.rejects(
                rpc.prompt("once", 500),
                (e) => e instanceof RpcFailure && e.outcome === "unknown" && e.message === reason,
            );
            await assert.rejects(
                rpc.prompt("do not retry"),
                (e) => e instanceof RpcFailure && e.outcome === "unknown",
            );
        } finally {
            await rpc.close();
        }
    });
}

test("raw prompt/queue/model/session mutations cannot bypass the runner", async () => {
    const rpc = await client("normal");

    try {
        for (const type of [
            "prompt",
            "steer",
            "follow_up",
            "set_model",
            "switch_session",
            "compact",
            "bash",
        ]) {
            await assert.rejects(rpc.request({ type }), /unsupported kernel command/);
        }

        await assert.rejects(
            rpc.request({ type: "set_auto_retry", enabled: true }),
            /unsupported kernel command/,
        );
    } finally {
        await rpc.close();
    }
});

test("busy RPC process cannot silently queue another payer", async () => {
    const rpc = await client("hang");

    try {
        const first = rpc.prompt("first", 500);
        const failed = assert.rejects(
            first,
            (e) => e instanceof RpcFailure && e.outcome === "unknown",
        );

        await assert.rejects(rpc.prompt("second"), /busy/);
        await failed;
    } finally {
        await rpc.close();
    }
});
