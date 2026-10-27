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
    "http.upload.bytes": {
        layer: "http",
        unit: "bytes",
        source: "browser File.size of the actual uploaded body, checked against server attachment readback (test/perf/paste-network.ts)",
    },
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
        source: "synchronous readSync calls in instrumented parent/storage-worker processes (test/perf/counters.ts)",
    },
    "fs.read.bytes": {
        layer: "storage",
        unit: "bytes",
        source: "bytes returned by synchronous readSync in instrumented parent/storage-worker processes (test/perf/counters.ts)",
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
    "roomInfo.segmentEntries.calls": {
        layer: "storage",
        unit: "count",
        source: "benchmark-local StatementSync.all wrapper counts the segmentEntries history query during synchronous roomInfo projections (test/perf/scenarios.ts)",
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
        source: "http.server.request.start diagnostics channel; static bundle completed node:http responses (test/perf/counters.ts and test/perf/static-assets.ts)",
    },
    "http.body.bytes": {
        layer: "http",
        unit: "bytes",
        source: "raw response body bytes received by transport probes (test/perf/scenarios.ts and test/perf/static-assets.ts)",
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

const sendCounters = [
    "sql.statements",
    "sql.rows",
    "subprocess.total",
    "subprocess.rotom",
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
];

/** The counters each scenario reports. */
export const REPORTED: Record<string, string[]> = {
    "startup.restart": [...common],
    "sessions.list": [...common, "http.body.bytes"],
    "sessions.rename.tabs": [...common, ...pushes, "http.requests"],
    "session.open": [...common, ...projection, ...pushes],
    "session.reclaim": [...common, ...projection, ...pushes],
    "session.open.long": [...common, ...projection, ...pushes],
    "session.history.earlier": [...common, "http.requests", "http.body.bytes"],
    "turn.cold": [...common, "subprocess.git", ...pushes],
    "native.warm": [...common, "subprocess.rotom"],
    "turn.prewarmed": [...common, "subprocess.git", "subprocess.rotom", ...pushes],
    "native.validate": [...common],
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
    // DevTools itself parses JSON in the server process: leave JSON counters out, as with web.open.
    "image.thumbs.network": [
        "sql.statements",
        "sql.rows",
        "subprocess.total",
        "subprocess.sips",
        "http.requests",
        "http.body.bytes",
    ],
    "image.paste.network": ["http.upload.bytes", "http.requests", "sql.statements", "sql.rows"],
    "image.original.again": [...common, "http.requests", "http.body.bytes"],
    "changes.poll.images": [...common, "subprocess.git", "http.requests", "http.body.bytes"],
    "image.original.validated": [...common, "http.requests", "http.body.bytes"],
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
    "web.open.long": [
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
    "web.reopen": [
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
    // As web.paced, and no native start: the send goes to the process the focused message box warmed.
    "web.send.poll": sendCounters,
    "web.send.stream": sendCounters,
    "web.send.poll.network": sendCounters,
    "web.send.stream.network": sendCounters,
    "journal.large": ["sql.statements", "sql.rows"],
    "session.open.native-long": [
        "roomInfo.segmentEntries.calls",
        "json.parse.journalSegments.calls",
        "json.parse.journalSegments.chars",
    ],
    "assets.first": ["http.requests", "http.body.bytes"],
    "assets.validated": ["http.requests", "http.body.bytes"],
};

export function metricSpec(metric: string): MetricSpec {
    const spec = COUNTERS[metric];

    if (spec === undefined) {
        throw new Error(`No metric spec for ${metric}`);
    }

    return spec;
}
