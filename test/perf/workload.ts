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
    projectionTurns: 64,
    projectionTabs: 4,
    projectionAnswerChars: 120,
    imageEntries: 24,
    imageWidth: 1024,
    imageHeight: 640,
    imageParallel: 4,
    /** The pause between chunks of a paced answer, as a real model streams. */
    pacedChunkMs: 25,
} as const;

const seeded = `kernel mode; a session of ${WORKLOAD.seededTurns} turns, ${WORKLOAD.answerChars}-char answers streamed in ${WORKLOAD.streamChunks} chunks`;
const imageHistory = `kernel mode; separate Durable mirror of ${WORKLOAD.imageEntries} native user messages, each with ${WORKLOAD.answerChars} text chars and one distinct ${WORKLOAD.imageWidth}x${WORKLOAD.imageHeight} RGB PNG (level-zero deflate); appended after all established scenarios; authenticated loopback GETs, exact binary readback, no browser cache, no native inference`;

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
    "web.paced": `${seeded}; after all established scenarios, a new headless Chromium tab opens that history unmeasured, then submits one ${WORKLOAD.answerChars}-char answer paced ${WORKLOAD.pacedChunkMs} ms per chunk until it appears`,
    "commands.discover.cold": `${seeded}; after all existing scenarios, an additional new native session with one tab; first explicit POST prompts, with no model request`,
    "commands.discover.warm": `${seeded}; same additional session/tab after cold discovery; a second explicit POST prompts with a new request ID, with no model request`,
    "turn.prepared": `${seeded}; same additional session/tab after both discoveries; first ordinary prompt, until settled and quiet`,
    "projection.large.open": `a separate ${WORKLOAD.projectionTurns}-turn session with ${WORKLOAD.projectionAnswerChars}-char answers; open ${WORKLOAD.projectionTabs} event-stream tabs in sequence until each full view`,
    "projection.large.paced": `the same ${WORKLOAD.projectionTurns}-turn session and ${WORKLOAD.projectionTabs} attached tabs; one ${WORKLOAD.answerChars}-char answer paced ${WORKLOAD.pacedChunkMs} ms per chunk, until settled and quiet`,
    "image.single": `${imageHistory}; retrieve image 0 once, until full client body and quiet; recently written SQLite data, not an OS cold-cache test`,
    "image.concurrent": `${imageHistory}; after image.single, retrieve images 1 through ${WORKLOAD.imageParallel} concurrently, until all client bodies and quiet; phase timings sum per-request intervals, not batch wall time`,
    "image.thumbs.first": `${imageHistory}; after image.concurrent, request images ${WORKLOAD.imageParallel + 1} through ${2 * WORKLOAD.imageParallel} concurrently as transcript thumbnails (?size=thumb), the first time this server sees them, until all client bodies and quiet`,
    "image.thumbs.again": `${imageHistory}; after image.thumbs.first, the same ${WORKLOAD.imageParallel} thumbnail requests again on the same server, without a browser cache, until all client bodies and quiet`,
};

export type Layer = "storage" | "process" | "cpu" | "push" | "http" | "web";
export type Unit = "count" | "bytes" | "chars";

export type MetricSpec = { layer: Layer; unit: Unit; source: string };

const parseSources = [
    "durableStorage",
    "journal",
    "journalHistory",
    "journalThinking",
    "journalSegments",
    "nativeReadback",
    "nativePin",
    "nativeResolver",
    "nativeSettings",
    "http",
    "other",
];
const nativeReadbackSources = [
    "nativeRpc",
    "nativeRpcRecord",
    "nativeRpcNotify",
    "nativeJsonl",
    "nativeJsonlIngest",
    "nativeJsonlSnapshot",
    "nativeGate",
];
const parseAttribution = [...parseSources, ...nativeReadbackSources].flatMap((source) => [
    `json.parse.${source}.calls`,
    `json.parse.${source}.chars`,
]);

/** Every counter a scenario reports, and where it is counted. */
const COUNTERS: Record<string, MetricSpec> = {
    "image.lookup.calls": {
        layer: "storage",
        unit: "count",
        source: "real Transcripts.visibleEntry invocations in request-local image scope (test/perf/images.ts)",
    },
    "image.decode.calls": {
        layer: "cpu",
        unit: "count",
        source: "Buffer.from base64 calls in entryImage outside visibleEntry, request-local scope (test/perf/images.ts)",
    },
    "image.decode.chars": {
        layer: "cpu",
        unit: "chars",
        source: "base64 characters decoded in scoped Buffer.from calls (test/perf/images.ts)",
    },
    "image.decode.bytes": {
        layer: "cpu",
        unit: "bytes",
        source: "decoded bytes returned by scoped Buffer.from calls (test/perf/images.ts)",
    },
    ...Object.fromEntries(
        [...parseSources, ...nativeReadbackSources].flatMap((source) =>
            ["calls", "chars"].map((unit) => [
                `json.parse.${source}.${unit}`,
                {
                    layer: "cpu",
                    unit: unit === "calls" ? "count" : "chars",
                    source: `JSON.parse in exclusive ${source} scope; AsyncLocalStorage source attribution (test/perf/counters.ts, src/server/perf-channels.ts)`,
                },
            ]),
        ),
    ),
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
    "subprocess.sips": {
        layer: "process",
        unit: "count",
        source: "child processes whose program is sips, macOS image resizing (test/perf/counters.ts)",
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
    "native.rpc.notify.records": {
        layer: "cpu",
        unit: "count",
        source: "transport RPC records that carry a notify string payload (test/perf/counters.ts)",
    },
    "fs.read.calls": {
        layer: "storage",
        unit: "count",
        source: "synchronous readSync calls in the parent process (test/perf/counters.ts)",
    },
    "fs.read.bytes": {
        layer: "storage",
        unit: "bytes",
        source: "bytes returned by synchronous readSync in the parent process (test/perf/counters.ts)",
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
    "view.entry.visits": {
        layer: "cpu",
        unit: "count",
        source: "durable entries traversed to project room views (src/server/room.ts)",
    },
    "view.client.entry.scans": {
        layer: "cpu",
        unit: "count",
        source: "cached projected entries scanned for a client's missing IDs (src/server/room.ts)",
    },
    "view.stats.entry.scans": {
        layer: "cpu",
        unit: "count",
        source: "entries visited in the stats reverse scan (src/server/projection.ts)",
    },
    "view.fields.stringify.calls": {
        layer: "cpu",
        unit: "count",
        source: "slow view fields serialized for per-client change detection (src/server/room.ts)",
    },
    "view.fields.stringify.chars": {
        layer: "cpu",
        unit: "chars",
        source: "characters of slow view fields serialized before unchanged fields are omitted (src/server/room.ts)",
    },
    "view.live.project.calls": {
        layer: "cpu",
        unit: "count",
        source: "live projections constructed per client push (src/server/room.ts)",
    },
    "view.inbox.project.calls": {
        layer: "cpu",
        unit: "count",
        source: "inbox projections constructed per client push (src/server/room.ts)",
    },
    "view.kernel.project.calls": {
        layer: "cpu",
        unit: "count",
        source: "native kernel projections constructed per client push (src/server/room.ts)",
    },
    "view.kernel.sql.heads": {
        layer: "storage",
        unit: "count",
        source: "SQL FROM kernel_heads during synchronous roomState projection (test/perf/counters.ts)",
    },
    "view.kernel.sql.sessions": {
        layer: "storage",
        unit: "count",
        source: "SQL FROM kernel_sessions during synchronous roomState projection (test/perf/counters.ts)",
    },
    "view.kernel.sql.attempts": {
        layer: "storage",
        unit: "count",
        source: "SQL FROM kernel_attempts during synchronous roomState projection (test/perf/counters.ts)",
    },
    "view.kernel.sql.command_inputs": {
        layer: "storage",
        unit: "count",
        source: "SQL FROM kernel_command_inputs during synchronous roomState projection (test/perf/counters.ts)",
    },
    "view.kernel.sql.resume": {
        layer: "storage",
        unit: "count",
        source: "SQL FROM kernel_resume during synchronous roomState projection (test/perf/counters.ts)",
    },
    "view.kernel.sql.statements": {
        layer: "storage",
        unit: "count",
        source: "SQL statements inside synchronous native kernel roomState projection (test/perf/counters.ts)",
    },
    "view.kernel.sql.rows": {
        layer: "storage",
        unit: "count",
        source: "SQL rows returned inside synchronous native kernel roomState projection (test/perf/counters.ts)",
    },
    "view.kernel.json.parse.calls": {
        layer: "cpu",
        unit: "count",
        source: "JSON decodes inside synchronous native kernel roomState projection (test/perf/counters.ts)",
    },
    "view.kernel.json.parse.chars": {
        layer: "cpu",
        unit: "chars",
        source: "characters decoded inside synchronous native kernel roomState projection (test/perf/counters.ts)",
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
    "web.event.parse.calls": {
        layer: "web",
        unit: "count",
        source: "browser event-stream JSON.parse calls (web/store.js)",
    },
    "web.event.parse.chars": {
        layer: "web",
        unit: "chars",
        source: "browser event-stream characters parsed as JSON (web/store.js)",
    },
    "web.view.apply.calls": {
        layer: "web",
        unit: "count",
        source: "browser view events applied to the store (web/store.js)",
    },
    "web.view.base.entry.copies": {
        layer: "web",
        unit: "count",
        source: "existing Map entries copied while applying view events (web/store.js)",
    },
    "web.view.delta.entries": {
        layer: "web",
        unit: "count",
        source: "new or replacement entries merged while applying view events (web/store.js)",
    },
    "web.view.prune.checks": {
        layer: "web",
        unit: "count",
        source: "browser entry IDs tested against a changed server order (web/store.js)",
    },
    "web.view.order.ids": {
        layer: "web",
        unit: "count",
        source: "server order IDs copied into browser keep sets (web/store.js)",
    },
};

const common = [
    "native.rpc.notify.records",
    "fs.read.calls",
    "fs.read.bytes",
    "sql.statements",
    "sql.rows",
    "subprocess.total",
    "json.parse.calls",
    "json.parse.chars",
    ...parseAttribution,
    "json.stringify.chars",
];
const pushes = ["push.events", "push.bytes", "push.view.count", "push.view.bytes"];
const projection = [
    "view.entry.visits",
    "view.client.entry.scans",
    "view.stats.entry.scans",
    "view.fields.stringify.calls",
    "view.fields.stringify.chars",
    "view.live.project.calls",
    "view.inbox.project.calls",
    "view.kernel.project.calls",
    "view.kernel.sql.statements",
    "view.kernel.sql.heads",
    "view.kernel.sql.sessions",
    "view.kernel.sql.attempts",
    "view.kernel.sql.command_inputs",
    "view.kernel.sql.resume",
    "view.kernel.sql.rows",
    "view.kernel.json.parse.calls",
    "view.kernel.json.parse.chars",
];

const imageCounters = [
    ...common,
    "http.requests",
    "http.body.bytes",
    "image.lookup.calls",
    "image.decode.calls",
    "image.decode.chars",
    "image.decode.bytes",
];

/** The counters each scenario reports. */
export const REPORTED: Record<string, string[]> = {
    "startup.restart": [...common],
    "sessions.list": [...common, "http.body.bytes"],
    "session.open": [...common, ...projection, ...pushes],
    "turn.cold": [...common, "subprocess.git", ...pushes],
    "turn.warm": [...common, "subprocess.git", ...projection, ...pushes],
    // Paced chunks race the 90 ms push coalescing, so its push counts depend on timing: candidates until proven stable.
    "turn.paced": [...common, "subprocess.git", ...projection, ...pushes],
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
    "projection.large.open": [...common, ...projection, ...pushes],
    "projection.large.paced": [...common, "subprocess.git", ...projection, ...pushes],
    "image.single": [...imageCounters],
    "image.concurrent": [...imageCounters],
    "image.thumbs.first": [...common, "subprocess.sips", "http.requests", "http.body.bytes"],
    "image.thumbs.again": [...common, "subprocess.sips", "http.requests", "http.body.bytes"],
    // JSON counts leave web.open out: the DevTools connection that drives Chromium parses and writes JSON too.
    "web.open": [
        "sql.statements",
        "sql.rows",
        "subprocess.total",
        ...projection,
        ...pushes,
        "http.requests",
        "cdp.LayoutCount",
        "cdp.RecalcStyleCount",
        "cdp.Nodes",
        "web.event.parse.calls",
        "web.event.parse.chars",
        "web.view.apply.calls",
        "web.view.base.entry.copies",
        "web.view.delta.entries",
        "web.view.prune.checks",
        "web.view.order.ids",
    ],
    "web.paced": [
        "sql.statements",
        "sql.rows",
        "subprocess.total",
        ...projection,
        ...pushes,
        "http.requests",
        "cdp.LayoutCount",
        "cdp.RecalcStyleCount",
        "cdp.Nodes",
        "web.event.parse.calls",
        "web.event.parse.chars",
        "web.view.apply.calls",
        "web.view.base.entry.copies",
        "web.view.delta.entries",
        "web.view.prune.checks",
        "web.view.order.ids",
    ],
};

export function metricSpec(metric: string): MetricSpec {
    const spec = COUNTERS[metric];

    if (spec === undefined) {
        throw new Error(`No metric spec for ${metric}`);
    }

    return spec;
}
