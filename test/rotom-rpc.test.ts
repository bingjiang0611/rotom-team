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
        ...(mode === "images-large" ? { recordLimit: 64 * 1024 * 1024 } : {}),
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

test("RPC forwards prompt images without putting their bytes in the text", async () => {
    const rpc = await client("images");
    const image = { type: "image" as const, data: "cGl4ZWw=", mimeType: "image/png" };

    try {
        assert.equal(await rpc.prompt("describe", undefined, [image]), "settled");
        assert.deepEqual(await rpc.request({ type: "get_state" }), {
            cleanEnvironment: true,
            cwd: process.cwd(),
            promptImages: [image],
        });
    } finally {
        await rpc.close();
    }
});

test("native-sized RPC accepts image commands and readback above the old 1/8 MiB bounds", async () => {
    const rpc = await client("images-large");
    const image = {
        type: "image" as const,
        data: "A".repeat(9 * 1024 * 1024),
        mimeType: "image/png",
    };

    try {
        assert.equal(await rpc.prompt("describe", undefined, [image]), "settled");
        const state = (await rpc.request({ type: "get_state" })) as {
            promptImages: (typeof image)[];
        };

        assert.equal(state.promptImages[0]?.data.length, image.data.length);
    } finally {
        await rpc.close();
    }
});

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

test("compact waits for its completion response past the admission deadline and excludes other work", async () => {
    const rpc = await client("compact-slow");

    try {
        const compact = rpc.compact("preserve decisions", 5000);

        await assert.rejects(rpc.prompt("race"), /busy/);
        await assert.rejects(rpc.compact("race"), /busy/);
        await compact;
    } finally {
        await rpc.close();
    }
});

for (const mode of ["compact-hang", "compact-corrupt"]) {
    test(`RPC ${mode}: completion ambiguity is unknown and not replayable`, async () => {
        const rpc = await client(mode);

        try {
            await assert.rejects(
                rpc.compact("once", 500),
                (error) => error instanceof RpcFailure && error.outcome === "unknown",
            );
            await assert.rejects(
                rpc.compact("again"),
                (error) => error instanceof RpcFailure && error.outcome === "unknown",
            );
        } finally {
            await rpc.close();
        }
    });
}

test("compact permits explicit abort, but its RPC rejection alone says nothing about prior model effects", async () => {
    const rpc = await client("compact-hang");

    try {
        const result = assert.rejects(
            rpc.compact("once"),
            (error) => error instanceof RpcFailure && error.outcome === "rejected",
        );

        await rpc.request({ type: "abort" });
        await result;
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
