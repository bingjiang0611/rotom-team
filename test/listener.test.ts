// Opt-in TLS, HTTP/1.1 fallback, real app auth/streams/multiplexing and shutdown. No real accounts.
import { cleanUp, seedHistoricalSession, openApp, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { connect, type ClientHttp2Stream } from "node:http2";
import { get } from "node:https";
import { join } from "node:path";
import { after, test } from "node:test";
import { createGunzip } from "node:zlib";
import { origin } from "../src/server/auth.ts";
import { createHandler } from "../src/server/http.ts";
import { createListener, readTls } from "../src/server/listener.ts";

after(cleanUp);
const cert = new URL("./fixtures/tls/cert.pem", import.meta.url);
const key = new URL("./fixtures/tls/key.pem", import.meta.url);
const tls = { cert: readFileSync(cert), key: readFileSync(key) };

test("TLS is explicit, paired, readable and valid before taking the listening port", async () => {
    assert.equal(readTls(undefined, undefined), undefined);
    assert.throws(() => readTls(cert.pathname, undefined), /go together/);
    assert.throws(() => readTls(undefined, key.pathname), /go together/);
    assert.throws(
        () => readTls(join(root, "missing-cert"), key.pathname),
        /Could not read the TLS certificate/,
    );
    assert.throws(() => createListener(() => {}, { cert: Buffer.from("not PEM"), key: tls.key }));
    const { server, closeAll } = createListener((q, r) => r.end(String(q.httpVersionMajor)));

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
        assert.equal(
            await (
                await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
            ).text(),
            "1",
        );
    } finally {
        closeAll();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test("TLS serves HTTP/2 auth, gzip views and multiplexed app requests, with an HTTP/1.1 fallback and bounded shutdown", async () => {
    const app = await openApp(scriptedModel());
    const id = await seedHistoricalSession(app);
    const handle = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });
    const origins: string[] = [];
    let connections = 0;
    const { server, closeAll } = createListener((q, r) => {
        origins.push(origin(q));
        void handle(q, r);
    }, tls);

    server.on("connection", () => connections++);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const base = `https://127.0.0.1:${port}`;
    const client = connect(base, { rejectUnauthorized: false });
    const streams: ClientHttp2Stream[] = [];
    const request = (path: string, auth = true) =>
        new Promise<{ status: number; body: string; headers: Record<string, unknown> }>(
            (resolve, reject) => {
                const stream = client.request({
                    ":path": path,
                    ...(auth ? { authorization: `Bearer ${app.config.ownerToken}` } : {}),
                });
                let body = "";
                let headers: Record<string, unknown> = {};

                stream.once("response", (h) => (headers = h));
                stream.on("data", (chunk) => (body += String(chunk)));
                stream.on("error", reject);
                stream.on("end", () =>
                    resolve({ status: Number(headers[":status"]), body, headers }),
                );
                stream.end();
            },
        );

    try {
        assert.equal((await request("/api/sessions", false)).status, 401);
        const login = await request(
            `/login?token=${encodeURIComponent(app.config.ownerToken)}`,
            false,
        );

        assert.equal(login.status, 303);
        assert.match(String(login.headers["set-cookie"]), /Secure/);
        assert.match(String(login.headers["set-cookie"]), /HttpOnly/);
        await Promise.all(
            Array.from({ length: 5 }, async () => {
                const stream = client.request({
                    ":path": `/api/events?c=${id}`,
                    authorization: `Bearer ${app.config.ownerToken}`,
                    "accept-encoding": "gzip",
                });
                const gunzip = createGunzip();
                let body = "";

                streams.push(stream);
                stream.on("error", () => {});
                stream.pipe(gunzip);
                await new Promise<void>((resolve, reject) => {
                    stream.once("response", (h) => {
                        assert.equal(h["content-encoding"], "gzip");
                        assert.equal(h.connection, undefined);
                    });
                    gunzip.on("error", reject);
                    gunzip.on("data", (chunk) => {
                        body += String(chunk);

                        if (body.includes("event: view\n")) {
                            resolve();
                        }
                    });
                    stream.once("error", reject);
                });
            }),
        );
        const results = await Promise.all(
            Array.from({ length: 22 }, () => request("/api/sessions")),
        );

        assert.ok(results.every((r) => r.status === 200 && JSON.parse(r.body)));
        assert.equal(
            connections,
            1,
            "five open views and 22 app requests share one TLS connection",
        );
        assert.ok(
            origins.every((o) => o === base),
            "HTTP/2 :authority is used for links, not localhost",
        );
        const fallback = await new Promise<{ version: string; status: number }>(
            (resolve, reject) => {
                get(
                    {
                        host: "127.0.0.1",
                        port,
                        path: "/api/sessions",
                        rejectUnauthorized: false,
                        headers: { authorization: `Bearer ${app.config.ownerToken}` },
                    },
                    (r) => {
                        r.resume();
                        r.once("end", () =>
                            resolve({ version: r.httpVersion, status: r.statusCode! }),
                        );
                    },
                ).on("error", reject);
            },
        );

        assert.deepEqual(fallback, { version: "1.1", status: 200 });
        // Keep those event streams open: stopping must close both HTTP/2 and HTTP/1.1 connections.
        const disconnected = once(client, "close");

        closeAll();
        await disconnected;
    } finally {
        for (const stream of streams) {
            stream.destroy();
        }

        client.destroy();
        closeAll();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await app.close();
    }
});
