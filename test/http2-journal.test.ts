// HTTP/2 has different Node diagnostics from HTTP/1.1. Keep collection isolated, private and per-stream.
import { cleanUp, root } from "./helpers.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { createSecureServer, connect } from "node:http2";
import { get } from "node:https";
import { join } from "node:path";
import { after, test } from "node:test";
import { startPerformanceJournal, type PerformanceRecord } from "../src/server/perf-journal.ts";

after(cleanUp);

// Public, self-signed test-only key. Never use it as a server deployment identity.
const tls = {
    cert: readFileSync(new URL("./fixtures/tls/cert.pem", import.meta.url)),
    key: readFileSync(new URL("./fixtures/tls/key.pem", import.meta.url)),
};

test("HTTP/2 requests reach only their own journal, without paths, queries or made-up wire bytes", async () => {
    const server = createSecureServer({ ...tls, allowHTTP1: true }, (request, response) => {
        response.writeHead(request.url?.startsWith("/api/c/") ? 404 : 200);
        response.end("a synthetic body");
    });
    const other = createSecureServer(tls, (_, response) => response.end("not this service"));

    server.listen(0, "127.0.0.1");
    other.listen(0, "127.0.0.1");
    await Promise.all([once(server, "listening"), once(other, "listening")]);
    const port = (server.address() as { port: number }).port;
    const directory = mkdtempSync(join(root, "h2-journal-"));
    const journal = await startPerformanceJournal({
        server,
        directory,
        openMs: 0,
        kernel: false,
        log: assert.fail,
    });
    const client = connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false });
    const outsider = connect(`https://127.0.0.1:${(other.address() as { port: number }).port}`, {
        rejectUnauthorized: false,
    });
    const fetch = (session: typeof client, path: string) =>
        new Promise<void>((resolve, reject) => {
            const stream = session.request({ ":path": path });

            stream.on("error", reject);
            stream.on("end", resolve);
            stream.resume();
            stream.end();
        });

    try {
        await Promise.all([
            fetch(client, "/api/sessions?token=private-token"),
            fetch(client, "/api/c/42/entry/123?path=private-path"),
            fetch(client, "/api/events?c=42"),
            fetch(outsider, "/api/foreign-private"),
        ]);
        await new Promise<void>((resolve, reject) => {
            get(
                {
                    host: "127.0.0.1",
                    port,
                    path: "/api/fs?path=private-home",
                    rejectUnauthorized: false,
                },
                (response) => {
                    response.resume();
                    response.once("end", resolve);
                },
            ).on("error", reject);
        });
        await journal.stop();
        const contents = readFileSync(join(directory, "performance-0.jsonl"), "utf8");
        const rows = contents
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as PerformanceRecord)
            .map((record) => record.observation)
            .filter((o) => o.kind === "http");

        assert.equal(
            rows.length,
            3,
            "two multiplexed requests and the HTTP/1.1 fallback, not HELD or another server",
        );
        const h2 = rows.filter((o) => o.route !== "/api/fs");

        assert.deepEqual(h2.map((o) => [o.route, o.status]).sort(), [
            ["/api/c/:n/entry/:x", 404],
            ["/api/sessions", 200],
        ]);
        assert.ok(h2.every((o) => o.wireBytes === null && o.ms >= 0 && o.method === "GET"));
        assert.ok(rows.find((o) => o.route === "/api/fs")!.wireBytes! > 0);
        assert.doesNotMatch(contents, /private-|foreign-private/);
    } finally {
        client.destroy();
        outsider.destroy();
        await Promise.all([
            new Promise<void>((r) => server.close(() => r())),
            new Promise<void>((r) => other.close(() => r())),
        ]);
    }
});
