// The daily performance journal: what it keeps out (anything a user typed), how it rotates and caps its files, and that
// the server's own event streams and native runs reach it through their diagnostics channels.
import { cleanUp, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { gunzipSync } from "node:zlib";
import { appendFileSync } from "node:fs";
import { createHandler } from "../src/server/http.ts";
import { kernelRunChannel, pushChannel, type PushSignal } from "../src/server/perf-channels.ts";
import {
    PerformanceJournal,
    type PerformanceRecord,
    performanceEnvironment,
    routeShape,
    startPerformanceJournal,
} from "../src/server/perf-journal.ts";
import { analyse, readJournal, snapshot } from "./perf/report.ts";

after(cleanUp);

const records = (directory: string): PerformanceRecord[] =>
    readFileSync(join(directory, "performance-0.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as PerformanceRecord);

test("a route shape keeps route words and drops ids, names, paths, and queries", () => {
    assert.equal(routeShape("/api/c/12/changes/diff?path=secret.txt"), "/api/c/:n/changes/diff");
    assert.equal(routeShape("/api/c/12/entry/987"), "/api/c/:n/entry/:x");
    assert.equal(routeShape("/api/c/12/mcp/My-Server"), "/api/c/:n/mcp/:x");
    assert.equal(routeShape("/api/c/12/image/photo.png"), "/api/c/:n/image/:x");
    assert.equal(routeShape("/api/sessions"), "/api/sessions");
    assert.equal(routeShape("/api/agent-resources/folders"), "/api/agent-resources/folders");
    assert.equal(routeShape("/api/fs?path=/Users/me/notes"), "/api/fs");
    assert.equal(routeShape("/login?token=AbC123"), "/login");
    assert.equal(routeShape("/join/Zx9-token"), "/join");
    assert.equal(routeShape("/s/42"), "/app");
    assert.equal(routeShape("/"), "/app");
    assert.equal(routeShape("/transcript.js"), "/asset");
    assert.equal(routeShape("/a/7/My%20Report/index.html"), "/a");
});

test("a full journal file becomes a compressed archive, and archives past the cap go oldest first", async () => {
    const directory = mkdtempSync(join(root, "journal-"));
    const journal = new PerformanceJournal({
        directory,
        environment: performanceEnvironment(),
        maxFileBytes: 2_000,
        maxArchiveBytes: 1_500,
        onError: () => assert.fail("the journal failed"),
    });

    await journal.open();

    for (let round = 0; round < 6; round++) {
        for (let index = 0; index < 8; index++) {
            journal.record({ kind: "kernel-run", ms: index, outcome: "prompt:settled" });
        }

        await journal.flush();
    }

    await journal.close();
    const names = readdirSync(directory);
    const archives = names.filter((name) => name.endsWith(".jsonl.gz"));

    assert.ok(archives.length > 0, `archives: ${names.join(", ")}`);
    assert.ok(
        names.every((name) => name === "performance-0.jsonl" || name.endsWith(".jsonl.gz")),
        `nothing left uncompressed: ${names.join(", ")}`,
    );
    assert.ok(
        archives.reduce((sum, name) => sum + statSync(join(directory, name)).size, 0) <= 1_500,
        "archives stay under their cap",
    );
    const archived = gunzipSync(readFileSync(join(directory, archives[0]!))).toString("utf8");

    assert.match(archived, /"kind":"kernel-run"/);
    assert.equal(records(directory).at(-1)!.observation.kind, "health");
});

test("a crash-truncated last line is kept for the report, and new records start a new file", async () => {
    const directory = mkdtempSync(join(root, "journal-"));

    writeFileSync(join(directory, "performance-0.jsonl"), '{"schema":1,"observation":{"kind":"ht');
    const journal = new PerformanceJournal({
        directory,
        environment: performanceEnvironment(),
        onError: () => assert.fail("the journal failed"),
    });

    await journal.open();
    journal.record({ kind: "kernel-run", ms: 1, outcome: "prompt:settled" });
    await journal.close();
    assert.equal(records(directory)[0]!.observation.kind, "kernel-run");
    assert.equal(readdirSync(directory).filter((name) => name.endsWith(".jsonl.gz")).length, 1);
});

test("the server's requests, pushed events, and native runs reach the journal, without what anyone typed", async () => {
    const app = await openApp(scriptedModel());
    const id = await newSession(app);
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const directory = mkdtempSync(join(root, "journal-"));
    const journal = await startPerformanceJournal({
        directory,
        server,
        openMs: 12.34,
        kernel: false,
        log: () => assert.fail("the journal failed"),
        sampleMs: 60_000,
    });
    const token = app.config.addDevice(owner(app).id).token;
    const headers = { authorization: `Bearer ${token}` };
    // The real event stream: its frames are what the push channel sizes.
    const pushed: PushSignal[] = [];
    const listen = (message: unknown) => pushed.push(message as PushSignal);

    pushChannel.subscribe(listen);
    const controller = new AbortController();
    const stream = await fetch(`${base}/api/events?c=${id}`, {
        headers,
        signal: controller.signal,
    });
    const reader = stream.body!.getReader();
    let received = "";

    while (!received.includes("event: view\n")) {
        received += new TextDecoder().decode((await reader.read()).value);
    }

    assert.equal((await fetch(`${base}/api/sessions?q=private-words`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/api/c/${id}/entry/12345`, { headers })).status, 404);
    kernelRunChannel.publish({ ms: 1234.56, outcome: "prompt:settled" });
    controller.abort();
    pushChannel.unsubscribe(listen);
    await journal.stop();
    server.closeAllConnections();
    server.close();
    await app.close();

    const hello = pushed.find((each) => each.event === "hello")!;
    const frame = received.slice(0, received.indexOf("\n\n", received.indexOf("event: hello")) + 2);

    assert.equal(hello.transport, "stream");
    assert.equal(hello.bytes, Buffer.byteLength(frame.slice(frame.indexOf("event: hello"))));

    const written = records(directory);
    const kinds = written.map((record) => record.observation);
    const raw = readFileSync(join(directory, "performance-0.jsonl"), "utf8");

    assert.deepEqual(kinds[0], { kind: "startup", openMs: 12.3, kernel: false });
    assert.ok(
        kinds.some(
            (each) =>
                each.kind === "http" &&
                each.route === "/api/sessions" &&
                each.status === 200 &&
                each.wireBytes !== null &&
                each.wireBytes > 0,
        ),
    );
    assert.ok(
        kinds.some(
            (each) =>
                each.kind === "http" && each.route === "/api/c/:n/entry/:x" && each.status === 404,
        ),
    );
    assert.ok(
        kinds.every((each) => each.kind !== "http" || each.route !== "/api/events"),
        "held streams are not requests",
    );
    assert.ok(kinds.some((each) => each.kind === "kernel-run" && each.ms === 1234.6));
    assert.ok(kinds.some((each) => each.kind === "push" && (each.events.view?.count ?? 0) >= 1));
    assert.ok(kinds.some((each) => each.kind === "process" && each.rssBytes > 0));
    assert.equal(kinds.at(-1)!.kind, "health");
    assert.doesNotMatch(raw, /private-words|12345|token|Bearer/);
    assert.ok(!raw.includes(token));
});

test("the report reads archives and the active file, counts cut-off lines, and ranks routes by total time", async () => {
    const data = mkdtempSync(join(root, "journal-data-"));
    const journal = new PerformanceJournal({
        directory: join(data, "performance"),
        environment: performanceEnvironment(),
        maxFileBytes: 4_000,
        onError: () => assert.fail("the journal failed"),
    });
    const http = (route: string, ms: number) =>
        journal.record({ kind: "http", method: "GET", route, status: 200, ms, wireBytes: 100 });

    await journal.open();

    // Ten slow answers outweigh a hundred quick ones: 1000 ms against 500 ms of waiting.
    for (let index = 0; index < 10; index++) {
        http("/api/c/:n/changes", 100);
    }

    for (let index = 0; index < 100; index++) {
        http("/api/sessions", 5);
        await journal.flush();
    }

    await journal.close();
    appendFileSync(join(data, "performance", "performance-0.jsonl"), '{"schema":1,"obs');

    const copy = mkdtempSync(join(root, "journal-copy-"));

    assert.ok(
        snapshot(data, copy).some((name) => name.endsWith(".jsonl.gz")),
        "archives are copied",
    );
    const { records, truncated } = readJournal(copy);
    const result = analyse(records);

    assert.equal(truncated, 1);
    assert.deepEqual(
        result.routes.map((each) => [each.route, each.count, each.totalMs, each.few]),
        [
            ["GET /api/c/:n/changes", 10, 1000, true],
            ["GET /api/sessions", 100, 500, false],
        ],
    );
});
