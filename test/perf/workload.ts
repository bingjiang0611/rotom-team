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
    /** A long native history (seeded directly, no model), for opening it and reading all of it. */
    longTurns: 300,
    longAnswerChars: 1200,
    /** A separate synthetic RotomJournal fixture for the A1 query measurement. */
    journalConversations: 60,
    journalAttempts: 50,
    journalEntriesPerAttempt: 12,
    journalEntryChars: 2000,
    /** The newest entries a tab asks for first, as the web app does (`TRANSCRIPT_TAIL` in web/store.js). */
    longTail: 240,
} as const;

/**
 * The model's pause before the first chunk of a send timed in phases (`web.send.*`), so the sender's own message is
 * pushed before the reply. Outside `WORKLOAD`, whose equality `perf:compare` checks: older reports stay comparable.
 */
export const SPLIT_FIRST_OUTPUT_MS = 1000;

const seeded = `kernel mode; a session of ${WORKLOAD.seededTurns} turns, ${WORKLOAD.answerChars}-char answers streamed in ${WORKLOAD.streamChunks} chunks`;
const imageHistory = `kernel mode; separate Durable mirror of ${WORKLOAD.imageEntries} native user messages, each with ${WORKLOAD.answerChars} text chars and one distinct ${WORKLOAD.imageWidth}x${WORKLOAD.imageHeight} RGB PNG (level-zero deflate); appended after all established scenarios; authenticated loopback GETs, exact binary readback, no browser cache, no native inference`;

/** What each scenario does, as the ledger records it. */
export const SCENARIOS: Record<string, string> = {
    "startup.restart": `${seeded}, ${WORKLOAD.extraSessions} more empty sessions; close the app and open it again`,
    "sessions.list": `${seeded}, ${WORKLOAD.extraSessions} more empty sessions; GET /api/sessions`,
    "sessions.rename.tabs": `after all established scenarios, ${WORKLOAD.projectionTabs} authenticated SSE tabs without a selected conversation opt into session deltas and load the full catalogue unmeasured; rename the History session twice through HTTP, waiting for each title in every tab; all reconstructed lists must equal the server list; count through quiet`,
    "session.open": `${seeded}; a new event-stream tab on it, until its first full view`,
    "turn.cold": `${seeded}; first prompt of a new session with one tab watching, until settled and quiet`,
    "turn.warm": `${seeded}; second prompt of that session with one tab watching, until settled and quiet`,
    "turn.paced": `${seeded}; third prompt of that session, its answer paced ${WORKLOAD.pacedChunkMs} ms per chunk, one tab watching, until settled and quiet`,
    "git.changes": `${seeded}; Git workspace with ${WORKLOAD.changedFiles} changed files; GET changes`,
    "git.diff": `${seeded}; Git workspace with ${WORKLOAD.changedFiles} changed files; GET changes/diff for tracked src/file-0.txt`,
    "git.branches": `${seeded}; Git workspace with 2 branches; GET branches`,
    "commands.list": `${seeded}; GET the native slash-command list`,
    "web.open": `${seeded}; headless Chromium signed in, opens /s/<session> until the last answer is in the page`,
    "session.reclaim": `${seeded}; after all established scenarios, an unmeasured tab loads its full view; a new event-stream tab then claims every entry it held (server run, first id, count, digest) until its first full view; the rebuilt transcript must equal the held one`,
    "session.open.long": `after all other scenarios, a separate native history of ${WORKLOAD.longTurns} user/assistant turns (${WORKLOAD.longAnswerChars}-char answers) seeded directly; a new event-stream tab asking for the newest ${WORKLOAD.longTail} entries (as the web app does) until its full view; every entry it got must equal an unpaged reference view`,
    "session.history.earlier": `after session.open.long, that tab reads every entry it lacks, page by page, until it holds the whole history; servers that sent everything need no request`,
    "web.open.long": `after session.history.earlier, headless Chromium signed in opens /s/<long session> until its last answer is in the page`,
    "native.warm": `after all other scenarios, a new native session with one tab watching; its member asks to warm it (as focusing the message box does) until the answer; servers without warming refuse at once`,
    "turn.prewarmed": `after native.warm, the first prompt of that session, until settled and quiet`,
    "native.validate": `after turn.prewarmed, the team validator a subagent start runs (rotom-child.ts, its own Node process) in that member's HOME and workspace, until it exits`,
    "web.reopen": `${seeded}; after session.reclaim, headless Chromium opens /s/<session> in one tab until shown (and saved where the page keeps copies), closes it, then a fresh tab of the same profile opens it until the last answer shows without a saved-copy check marker`,
    "web.paced": `${seeded}; after all established scenarios, a new headless Chromium tab opens that history unmeasured, then submits one ${WORKLOAD.answerChars}-char answer paced ${WORKLOAD.pacedChunkMs} ms per chunk until it appears`,
    "web.send.poll": `${seeded}; after all other scenarios, headless Chromium on a non-loopback name with long polling opens that history (now ${WORKLOAD.seededTurns + 1} turns) unmeasured, focuses the message box, warms the native process and types; from Enter until the first chunk of the ${WORKLOAD.answerChars}-char answer (sent ${SPLIT_FIRST_OUTPUT_MS} ms after the request, then paced ${WORKLOAD.pacedChunkMs} ms per chunk) is painted, its milliseconds split into phases; one more Node event-stream tab watches; counted until settled and quiet`,
    "web.send.stream": `${seeded}; after web.send.poll, the same send to that history (now ${WORKLOAD.seededTurns + 2} turns) from a new headless Chromium on the same name using the event stream; one more Node event-stream tab watches; counted until settled and quiet`,
    "commands.discover.cold": `${seeded}; after all existing scenarios, an additional new native session with one tab; first explicit POST prompts, with no model request`,
    "commands.discover.warm": `${seeded}; same additional session/tab after cold discovery; a second explicit POST prompts with a new request ID, with no model request`,
    "turn.prepared": `${seeded}; same additional session/tab after both discoveries; first ordinary prompt, until settled and quiet`,
    "projection.large.open": `a separate ${WORKLOAD.projectionTurns}-turn session with ${WORKLOAD.projectionAnswerChars}-char answers; open ${WORKLOAD.projectionTabs} event-stream tabs in sequence until each full view`,
    "projection.large.paced": `the same ${WORKLOAD.projectionTurns}-turn session and ${WORKLOAD.projectionTabs} attached tabs; one ${WORKLOAD.answerChars}-char answer paced ${WORKLOAD.pacedChunkMs} ms per chunk, until settled and quiet`,
    "image.single": `${imageHistory}; retrieve image 0 once, until full client body and quiet; recently written SQLite data, not an OS cold-cache test`,
    "image.original.again": `${imageHistory}; after browser network scenarios, request original images 1 through ${WORKLOAD.imageParallel} again concurrently (first retrieved by image.concurrent), exact binary readback, until bodies and quiet`,
    "image.original.validated": `${imageHistory}; after image.original.again, repeat those originals with If-None-Match containing each known content SHA256 tag; identical full body if unimplemented, otherwise validated 304 with matching ETag and zero body; until all responses and quiet`,
    "image.concurrent": `${imageHistory}; after image.single, retrieve images 1 through ${WORKLOAD.imageParallel} concurrently, until all client bodies and quiet; phase timings sum per-request intervals, not batch wall time`,
    "image.thumbs.first": `${imageHistory}; after image.concurrent, request images ${WORKLOAD.imageParallel + 1} through ${2 * WORKLOAD.imageParallel} concurrently as transcript thumbnails (?size=thumb), the first time this server sees them, until all client bodies and quiet`,
    "image.thumbs.again": `${imageHistory}; after image.thumbs.first, the same ${WORKLOAD.imageParallel} thumbnail requests again on the same server, without a browser cache, until all client bodies and quiet`,
    "image.thumbs.network": `${imageHistory}; after all loopback scenarios, Chromium downloads and decodes ${WORKLOAD.imageParallel} previously unrequested images (indices ${2 * WORKLOAD.imageParallel + 1} through ${3 * WORKLOAD.imageParallel}) as thumbnails, cache disabled, CDP-emulated 4 Mbit/s throughput and 40 ms latency; includes first server resize cost; synthetic link, not production network`,
    "changes.poll.images": `${imageHistory}; after all image scenarios, ${WORKLOAD.projectionTabs} concurrent GET changes for that image session (same Git workspace with ${WORKLOAD.changedFiles} changed files), then the same ${WORKLOAD.projectionTabs} again with nothing changed; every answer identical, until quiet`,
    "image.paste.network":
        "after all other scenarios, real Chromium prepares and uploads one deterministic xorshift-noise 3000x1500 opaque PNG from its clipboard path to the same synthetic session, on a CDP-emulated 4 Mbit/s uplink and 40 ms latency; includes browser resize, HTTP upload, metadata response and decode, excludes fixture construction/module loading; older revisions without the helper upload the original, matching their unchanged paste behavior; no inference, synthetic link",
    "journal.large": `after all other scenarios, a separate RotomJournal with ${WORKLOAD.journalConversations} conversations × ${WORKLOAD.journalAttempts} attempts × ${WORKLOAD.journalEntriesPerAttempt} entries of about ${WORKLOAD.journalEntryChars} characters; measure an entries suffix, segmentEntries and credits`,
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
    "web.send.poll": [
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
    ],
    "web.send.stream": [
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
    ],
    "journal.large": ["sql.statements", "sql.rows"],
};

export function metricSpec(metric: string): MetricSpec {
    const spec = COUNTERS[metric];

    if (spec === undefined) {
        throw new Error(`No metric spec for ${metric}`);
    }

    return spec;
}
