#!/usr/bin/env node
// Isolate Pi resources before importing it. Never borrow the maintainer's ~/.pi or global model credentials.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

if (Number(process.versions.node.split(".")[0]) < 24) {
    console.error("rotom-team requires Node.js 24 or newer.");
    process.exit(1);
}

process.umask(0o077);
const args = process.argv.slice(2);

const index = args.lastIndexOf("--data");
const data = resolve(
    index >= 0 && args[index + 1]
        ? args[index + 1]
        : (process.env.ROTOM_TEAM_DIR ?? join(homedir(), ".rotom-team")),
);

process.env.PI_POCKET_DIR = data;
process.env.PI_CODING_AGENT_DIR = join(data, "agent");

if (!args.includes("--help") && !args.includes("-h")) {
    mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true, mode: 0o700 });
}

const { prepareRuntime } = await import("../scripts/prepare-runtime.mjs");

prepareRuntime();
await import("../src/server/main.ts");
