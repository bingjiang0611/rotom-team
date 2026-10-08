import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { cleanUp, root, until, work } from "./helpers.ts";

after(cleanUp);

test("rotom-team boots with isolated resources and honors the final --data argument", async () => {
    const probe = createServer();

    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as { port: number }).port;

    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const unused = join(root, "unused-data");
    const inherited = join(root, "must-not-use-private-pi");
    const data = join(root, "deployment");
    const proc = spawn(
        process.execPath,
        [
            "bin/rotom-team.js",
            "--port",
            String(port),
            "--cwd",
            work,
            "--data",
            unused,
            "--data",
            data,
        ],
        {
            env: {
                ...process.env,
                PI_CODING_AGENT_DIR: inherited,
                PI_POCKET_LAUNCHER: "",
                PI_POCKET_SUPERVISED: "",
                PI_POCKET_GUARD: "off",
            },
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
    const stopped = once(proc, "exit");
    let output = "";

    proc.stdout!.on("data", (chunk) => (output += chunk));
    proc.stderr!.on("data", (chunk) => (output += chunk));

    try {
        await until(() => output.includes("is running."), "isolated server startup");
        assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
        assert.equal(existsSync(join(data, "agent")), true);
        assert.equal(existsSync(unused), false);
        assert.equal(existsSync(inherited), false);
    } finally {
        proc.kill("SIGTERM");
        await stopped;
    }

    assert.equal(proc.exitCode, 0);
    assert.equal(existsSync(join(data, "harness.lock")), false);
});
