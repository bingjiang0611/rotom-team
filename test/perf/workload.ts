/**
 * What the controlled benchmarks do and which numbers they report. The ledger (`ledger.json`) keys each number by
 * `scenario/metric` and records the workload text below: a number measured under another workload is another number,
 * so changing a workload means registering new keys, never reusing old ones.
 */

/** The fixed work of every run. */
export const WORKLOAD = {
    seededTurns: 12,
    answerChars: 6000,
    streamChunks: 30,
    extraSessions: 12,
    changedFiles: 20,
    /** The pause between chunks of a paced answer, as a real model streams. */
    pacedChunkMs: 25,
} as const;

const seeded = `kernel mode; a session of ${WORKLOAD.seededTurns} turns, ${WORKLOAD.answerChars}-char answers streamed in ${WORKLOAD.streamChunks} chunks`;

/** What each scenario does, as the ledger records it. */
export const SCENARIOS: Record<string, string> = {
    "startup.restart": `${seeded}, ${WORKLOAD.extraSessions} more empty sessions; close the app and open it again`,
    "sessions.list": `${seeded}, ${WORKLOAD.extraSessions} more empty sessions; GET /api/sessions`,
    "session.open": `${seeded}; a new event-stream tab on it, until its first full view`,
    "turn.cold": `${seeded}; first prompt of a new session with one tab watching, until settled and quiet`,
    "turn.warm": `${seeded}; second prompt of that session with one tab watching, until settled and quiet`,
    "turn.paced": `${seeded}; third prompt of that session, its answer paced ${WORKLOAD.pacedChunkMs} ms per chunk, one tab watching, until settled and quiet`,
    "git.changes": `${seeded}; Git workspace with ${WORKLOAD.changedFiles} changed files; GET changes`,
    "git.diff": `${seeded}; Git workspace with ${WORKLOAD.changedFiles} changed files; GET changes/diff for tracked src/file-0.txt`,
    "git.branches": `${seeded}; Git workspace with 2 branches; GET branches`,
    "commands.list": `${seeded}; GET the native slash-command list`,
    "web.open": `${seeded}; headless Chromium signed in, opens /s/<session> until the last answer is in the page`,
    "commands.discover.cold": `${seeded}; after all existing scenarios, an additional new native session with one tab; first explicit POST prompts, with no model request`,
    "commands.discover.warm": `${seeded}; same additional session/tab after cold discovery; a second explicit POST prompts with a new request ID, with no model request`,
    "turn.prepared": `${seeded}; same additional session/tab after both discoveries; first ordinary prompt, until settled and quiet`,
};

export type Layer = "storage" | "process" | "cpu" | "push" | "http" | "web";
export type Unit = "count" | "bytes" | "chars";

export type MetricSpec = { layer: Layer; unit: Unit; source: string };

/** Every counter a scenario reports, and where it is counted. */
const COUNTERS: Record<string, MetricSpec> = {
    "sql.statements": {
        layer: "storage",
        unit: "count",
        source: "node:sqlite StatementSync run/get/all/iterate + DatabaseSync.exec (test/perf/counters.ts)",
    },
    "sql.rows": {
        layer: "storage",
        unit: "count",
        source: "rows returned by StatementSync all/get (test/perf/counters.ts)",
    },
    "subprocess.total": {
        layer: "process",
        unit: "count",
        source: "ChildProcess.prototype.spawn + spawnSync/execFileSync/execSync (test/perf/counters.ts)",
    },
    "subprocess.git": {
        layer: "process",
        unit: "count",
        source: "child processes whose program is git (test/perf/counters.ts)",
    },
    "subprocess.rotom": {
        layer: "process",
        unit: "count",
        source: "child processes whose program is rotom (test/perf/counters.ts)",
    },
    "json.parse.calls": {
        layer: "cpu",
        unit: "count",
        source: "global JSON.parse calls in the server process (test/perf/counters.ts)",
    },
    "json.parse.chars": {
        layer: "cpu",
        unit: "chars",
        source: "characters given to JSON.parse (test/perf/counters.ts)",
    },
    "fs.write.calls": {
        layer: "storage",
        unit: "count",
        source: "node:fs writeFileSync calls in the server process (test/perf/counters.ts)",
    },
    "fs.write.bytes": {
        layer: "storage",
        unit: "bytes",
        source: "bytes passed to node:fs writeFileSync in the server process (test/perf/counters.ts)",
    },
    "fs.rename.calls": {
        layer: "storage",
        unit: "count",
        source: "node:fs renameSync calls in the server process (test/perf/counters.ts)",
    },
    "json.stringify.chars": {
        layer: "cpu",
        unit: "chars",
        source: "characters JSON.stringify produced (test/perf/counters.ts)",
    },
    "push.events": {
        layer: "push",
        unit: "count",
        source: "events written to tabs, rotom-team:push channel (src/server/perf-channels.ts)",
    },
    "push.bytes": {
        layer: "push",
        unit: "bytes",
        source: "event-stream bytes written to tabs, rotom-team:push channel",
    },
    "push.view.count": {
        layer: "push",
        unit: "count",
        source: "view events written to tabs, rotom-team:push channel",
    },
    "push.view.bytes": {
        layer: "push",
        unit: "bytes",
        source: "view event bytes written to tabs, rotom-team:push channel",
    },
    "http.requests": {
        layer: "http",
        unit: "count",
        source: "http.server.request.start diagnostics channel (test/perf/counters.ts)",
    },
    "http.body.bytes": {
        layer: "http",
        unit: "bytes",
        source: "answer body bytes the benchmark received (test/perf/scenarios.ts)",
    },
    "cdp.LayoutCount": {
        layer: "web",
        unit: "count",
        source: "Chromium Performance.getMetrics LayoutCount delta (test/perf/browser.ts)",
    },
    "cdp.RecalcStyleCount": {
        layer: "web",
        unit: "count",
        source: "Chromium Performance.getMetrics RecalcStyleCount delta (test/perf/browser.ts)",
    },
    "cdp.Nodes": {
        layer: "web",
        unit: "count",
        source: "Chromium Performance.getMetrics Nodes once the answer shows (test/perf/browser.ts)",
    },
};

const common = [
    "sql.statements",
    "sql.rows",
    "subprocess.total",
    "json.parse.calls",
    "json.parse.chars",
    "json.stringify.chars",
];
const pushes = ["push.events", "push.bytes", "push.view.count", "push.view.bytes"];

/** The counters each scenario reports. */
export const REPORTED: Record<string, string[]> = {
    "startup.restart": [...common],
    "sessions.list": [...common, "http.body.bytes"],
    "session.open": [...common, ...pushes],
    "turn.cold": [...common, "subprocess.git", ...pushes],
    "turn.warm": [...common, "subprocess.git", ...pushes],
    // Paced chunks race the 90 ms push coalescing, so its push counts depend on timing: candidates until proven stable.
    "turn.paced": [...common, "subprocess.git", ...pushes],
    "git.changes": [...common, "subprocess.git", "http.body.bytes"],
    "git.diff": [...common, "subprocess.git", "http.body.bytes"],
    "git.branches": [...common, "subprocess.git", "http.body.bytes"],
    "commands.list": [...common, "http.body.bytes"],
    "commands.discover.cold": [
        ...common,
        "subprocess.rotom",
        "fs.write.calls",
        "fs.write.bytes",
        "fs.rename.calls",
        ...pushes,
        "http.body.bytes",
    ],
    "commands.discover.warm": [...common, "subprocess.rotom", ...pushes, "http.body.bytes"],
    "turn.prepared": [...common, "subprocess.rotom", ...pushes],
    // JSON counts leave web.open out: the DevTools connection that drives Chromium parses and writes JSON too.
    "web.open": [
        "sql.statements",
        "sql.rows",
        "subprocess.total",
        ...pushes,
        "http.requests",
        "cdp.LayoutCount",
        "cdp.RecalcStyleCount",
        "cdp.Nodes",
    ],
};

export function metricSpec(metric: string): MetricSpec {
    const spec = COUNTERS[metric];

    if (spec === undefined) {
        throw new Error(`No metric spec for ${metric}`);
    }

    return spec;
}
