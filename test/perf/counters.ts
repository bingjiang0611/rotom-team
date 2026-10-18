/**
 * Work counters for the controlled benchmarks: how much work the server did, counted where it happens. Import this
 * before anything from src/. It wraps, in this process only:
 *
 * - SQLite: every statement run (`node:sqlite`, which both pocket.sqlite and kernel.sqlite use) and the rows read;
 * - child processes: every start, by program name (git, node, …), sync or not;
 * - JSON: parse and stringify calls, and the characters they handled;
 * - pushes: events written to browser tabs, by event name, from the server's own diagnostics channel;
 * - HTTP: requests this process's servers answered.
 *
 * Counts do not move with machine load the way milliseconds do, which is what lets them guard changes. The benchmark
 * uses `raw` for its own JSON so that its bookkeeping is not counted as the server's work.
 */
import childProcess from "node:child_process";
import { subscribe } from "node:diagnostics_channel";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import {
    currentParseWork,
    nativeStartChannel,
    parseWorkChannel,
    pushChannel,
    roomPartChannel,
    viewProjectionChannel,
    type NativeStartSignal,
    type PushSignal,
    type RoomPartSignal,
    type ViewProjectionSignal,
} from "../../src/server/perf-channels.ts";

export type Counts = Record<string, number>;

const counts: Counts = {};
const nativeTimings: Counts = {};
let kernelRoomActive = false;

const add = (name: string, amount = 1) => {
    counts[name] = (counts[name] ?? 0) + amount;
};

export const raw = { parse: JSON.parse, stringify: JSON.stringify };

// Subscription enables AsyncLocalStorage scopes only in controlled benchmarks, never in the running product.
parseWorkChannel.subscribe(() => undefined);

const parseSource = () => {
    switch (currentParseWork()) {
        case "durable-storage":
            return "durableStorage";
        case "journal":
            return "journal";
        case "journal-history":
            return "journalHistory";
        case "journal-thinking":
            return "journalThinking";
        case "journal-segments":
            return "journalSegments";
        case "native-readback":
            return "nativeReadback";
        case "http":
            return "http";
        default:
            return "other";
    }
};

JSON.parse = function parse(text: string, reviver?: Parameters<typeof JSON.parse>[1]) {
    const chars = typeof text === "string" ? text.length : 0;
    const source = parseSource();

    add("json.parse.calls");
    add("json.parse.chars", chars);
    add(`json.parse.${source}.calls`);
    add(`json.parse.${source}.chars`, chars);

    return raw.parse(text, reviver);
} as typeof JSON.parse;

JSON.stringify = function stringify(...args: Parameters<typeof JSON.stringify>) {
    const result = raw.stringify(...args);

    add("json.stringify.calls");
    add("json.stringify.chars", typeof result === "string" ? result.length : 0);

    return result;
} as typeof JSON.stringify;

type StatementMethod = "run" | "get" | "all" | "iterate";

for (const method of ["run", "get", "all", "iterate"] as StatementMethod[]) {
    const original = StatementSync.prototype[method] as (...args: unknown[]) => unknown;

    (StatementSync.prototype as unknown as Record<string, unknown>)[method] = function (
        this: StatementSync,
        ...args: unknown[]
    ) {
        add("sql.statements");

        if (kernelRoomActive) {
            const table =
                /\bFROM (kernel_heads|kernel_sessions|kernel_attempts|kernel_command_inputs|kernel_resume)\b/i
                    .exec(this.sourceSQL)?.[1]
                    ?.replace("kernel_", "");

            if (table !== undefined) {
                add(`view.kernel.sql.${table}`);
            }
        }

        const result = original.apply(this, args);

        if (method === "all") {
            add("sql.rows", (result as unknown[]).length);
        } else if (method === "get" && result !== undefined) {
            add("sql.rows");
        }

        return result;
    };
}

const exec = DatabaseSync.prototype.exec;

DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
    add("sql.statements");

    return exec.call(this, sql);
};

const program = (file: unknown) => basename(String(file));
// spawn, execFile, exec, and fork all start their child with this method; Node's types leave it out.
const prototype = childProcess.ChildProcess.prototype as unknown as {
    spawn(options: { file?: string }): unknown;
};
const spawnChild = prototype.spawn;

const spawnSync = childProcess.spawnSync;
/**
 * `ROTOM_TEAM_PERF_INJECT=git` runs every Git command twice, the second time synchronously: a deliberate regression
 * that proves the Git counters notice extra work (sensitivity) and that it costs time (correlation). Never set it for
 * a report that goes into the ledger.
 */
const injectGit = process.env.ROTOM_TEAM_PERF_INJECT === "git";

prototype.spawn = function (
    this: unknown,
    options: { file?: string; args?: string[]; cwd?: string },
) {
    add("subprocess.total");
    add(`subprocess.${program(options.file)}`);

    if (injectGit && program(options.file) === "git") {
        add("subprocess.total");
        add("subprocess.git");
        spawnSync(options.file!, options.args?.slice(1) ?? [], {
            cwd: options.cwd,
            stdio: "ignore",
        });
    }

    return spawnChild.call(this, options);
};

for (const name of ["spawnSync", "execFileSync", "execSync"] as const) {
    const original = childProcess[name] as (...args: unknown[]) => unknown;

    (childProcess as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
        add("subprocess.total");
        add(`subprocess.${name === "execSync" ? "sh" : program(args[0])}`);

        return original(...args);
    };
}

const writeFileSync = fs.writeFileSync;
const renameSync = fs.renameSync;

fs.writeFileSync = (...args: Parameters<typeof fs.writeFileSync>) => {
    const data = args[1];

    add("fs.write.calls");
    add(
        "fs.write.bytes",
        typeof data === "string"
            ? Buffer.byteLength(data)
            : ArrayBuffer.isView(data)
              ? data.byteLength
              : 0,
    );

    return writeFileSync(...args);
};

fs.renameSync = (...args: Parameters<typeof fs.renameSync>) => {
    add("fs.rename.calls");

    return renameSync(...args);
};

// Named imports of built-ins see the wrapped functions too.
syncBuiltinESMExports();

pushChannel.subscribe((message) => {
    const { event, bytes } = message as PushSignal;

    add("push.events");
    add(`push.${event}.count`);

    if (bytes !== null) {
        add("push.bytes", bytes);
        add(`push.${event}.bytes`, bytes);
    }
});

viewProjectionChannel.subscribe((message) => {
    const {
        entryVisits,
        clientEntryScans,
        statsEntryScans,
        fieldStringifyCalls,
        fieldStringifyChars,
    } = message as ViewProjectionSignal;

    if (entryVisits !== undefined) {
        add("view.entry.visits", entryVisits);
    }

    if (clientEntryScans !== undefined) {
        add("view.client.entry.scans", clientEntryScans);
    }

    if (statsEntryScans !== undefined) {
        add("view.stats.entry.scans", statsEntryScans);
    }

    if (fieldStringifyCalls !== undefined) {
        add("view.fields.stringify.calls", fieldStringifyCalls);
    }

    if (fieldStringifyChars !== undefined) {
        add("view.fields.stringify.chars", fieldStringifyChars);
    }
});

const roomPartStarts = new Map<RoomPartSignal["part"], Counts>();

roomPartChannel.subscribe((message) => {
    const { part, ms } = message as RoomPartSignal;

    if (ms === undefined) {
        add(`view.${part}.project.calls`);
        roomPartStarts.set(part, snapshot());

        if (part === "kernel") {
            kernelRoomActive = true;
        }

        return;
    }

    if (part === "kernel") {
        kernelRoomActive = false;
    }

    const name = `room${part[0]!.toUpperCase()}${part.slice(1)}ProjectMs`;

    nativeTimings[name] = (nativeTimings[name] ?? 0) + ms;
    const work = since(roomPartStarts.get(part) ?? {});

    for (const metric of ["sql.statements", "sql.rows", "json.parse.calls", "json.parse.chars"]) {
        add(`view.${part}.${metric}`, work[metric] ?? 0);
    }
});

nativeStartChannel.subscribe((message) => {
    for (const [name, ms] of Object.entries(message as unknown as NativeStartSignal)) {
        nativeTimings[`nativeStart${name[0]!.toUpperCase()}${name.slice(1)}`] =
            (nativeTimings[`nativeStart${name[0]!.toUpperCase()}${name.slice(1)}`] ?? 0) + ms;
    }
});

subscribe("http.server.request.start", () => add("http.requests"));

export const nativeTimingSnapshot = (): Counts => ({ ...nativeTimings });

/** Successful cold-start phase milliseconds since a snapshot; empty when no native process started. */
export function nativeTimingSince(before: Counts): Counts {
    return Object.fromEntries(
        Object.entries(nativeTimings)
            .map(([name, value]) => [name, value - (before[name] ?? 0)] as const)
            .filter(([, value]) => value !== 0),
    );
}

/** What the counters say now. */
export function snapshot(): Counts {
    return { ...counts };
}

/** The work done between two snapshots. Names with no work are left out. */
export function since(before: Counts): Counts {
    const done: Counts = {};

    for (const [name, value] of Object.entries(counts)) {
        const delta = value - (before[name] ?? 0);

        if (delta !== 0) {
            done[name] = delta;
        }
    }

    return done;
}
