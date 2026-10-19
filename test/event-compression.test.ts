// Real HTTP streams: gzip negotiation, immediate event delivery, polling and bounded slow-reader backlog.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, get, type IncomingMessage, type Server } from "node:http";
import { test } from "node:test";
import { createGunzip } from "node:zlib";
import type { PocketApp } from "../src/server/app.ts";
import type { User } from "../src/server/config.ts";
import { acceptsGzip, createEventStreams } from "../src/server/http/events.ts";
import type { Client } from "../src/server/room.ts";

const data = { text: "The same words in a long history. ".repeat(1000) };
const frame = `event: view\ndata: ${JSON.stringify(data)}\n\n`;

test("gzip negotiation respects q=0, exact tokens and explicit refusal before wildcard", () => {
    for (const [header, expected] of [
        [undefined, false],
        ["", false],
        ["br", false],
        ["gzip", true],
        ["br, GZIP; q=0.5", true],
        ["gzip;q=0", false],
        ["x-gzip", false],
        ["*", true],
        ["gzip;q=0, *;q=1", false],
        ["gzip;q=1.1", false],
        ["gzip;q=oops", false],
        ["*;q=0", false],
    ] as const) {
        assert.equal(acceptsGzip(header), expected, header ?? "absent");
    }
});

async function fixture(attach?: (client: Client) => void, maxBytes?: number) {
    let detach!: () => void;
    const detached = new Promise<void>((resolve) => {
        detach = resolve;
    });
    const app = {
        attach: async (client: Client) => {
            if (attach) {
                attach(client);
            } else {
                client.send("view", data);
                client.send("ready", { ok: true });
            }
        },
        detach: () => detach(),
    } as unknown as PocketApp;
    const streams = createEventStreams(app, maxBytes);
    const server = createServer((request, response) => {
        const url = new URL(request.url!, "http://localhost");
        const route = url.pathname === "/events" ? streams.events : streams.poll;

        void route(request, response, url, { id: "fixture" } as User).catch((error) =>
            response.destroy(error),
        );
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    return { server, base, detached };
}

async function close(server: Server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

test(
    "each compressed SSE event is readable immediately; identity and gzip bodies agree",
    { timeout: 10_000 },
    async () => {
        for (const encoding of ["gzip", "identity", "gzip;q=0, *;q=1"]) {
            const { server, base, detached } = await fixture();
            const request = get(`${base}/events`, { headers: { "accept-encoding": encoding } });

            try {
                const [response] = (await once(request, "response")) as [IncomingMessage];
                const compressed = encoding === "gzip";
                let wireBytes = 0;

                assert.equal(response.headers["content-encoding"], compressed ? "gzip" : undefined);
                assert.equal(response.headers.vary, "accept-encoding");
                response.on("data", (bytes: Buffer) => {
                    wireBytes += bytes.length;
                });
                const body = compressed ? response.pipe(createGunzip()) : response;
                let text = "";

                for await (const chunk of body) {
                    text += chunk.toString();

                    if (text.includes('event: ready\ndata: {"ok":true}\n\n')) {
                        break;
                    }
                }

                assert.equal(text, `retry: 1500\n\n${frame}event: ready\ndata: {"ok":true}\n\n`);

                if (compressed) {
                    assert.ok(wireBytes < Buffer.byteLength(frame) / 10);
                }
            } finally {
                request.destroy();
                await detached;
                await close(server);
            }
        }
    },
);

test(
    "poll responses decode to the same events; gzip refusal is respected",
    { timeout: 10_000 },
    async () => {
        for (const encoding of ["gzip", "gzip;q=0", "identity"]) {
            const { server, base, detached } = await fixture();

            try {
                const response = await fetch(`${base}/poll`, {
                    headers: { "accept-encoding": encoding },
                });
                const answer = (await response.json()) as { session: string; events: unknown[] };

                assert.equal(
                    response.headers.get("content-encoding"),
                    encoding === "gzip" ? "gzip" : null,
                );
                assert.deepEqual(answer.events, [
                    { seq: 1, event: "view", data },
                    { seq: 2, event: "ready", data: { ok: true } },
                ]);
                const closed = await fetch(`${base}/poll?session=${answer.session}&close=1`);

                await closed.arrayBuffer();
                await detached;
            } finally {
                await close(server);
            }
        }
    },
);

test(
    "a blocked stream is disconnected and detached rather than buffering unlimited events",
    { timeout: 10_000 },
    async () => {
        for (const encoding of ["gzip", "identity"]) {
            const { server, base, detached } = await fixture((client) => {
                for (let i = 0; i < 200; i++) {
                    client.send("view", { text: "x".repeat(1000), i });
                }
            }, 4096);
            const request = get(`${base}/events`, { headers: { "accept-encoding": encoding } });
            const ended = new Promise<void>((resolve) => {
                request.on("error", (error: NodeJS.ErrnoException) => {
                    assert.equal(error.code, "ECONNRESET");
                    resolve();
                });
                request.on("response", (response) => {
                    response.on("error", () => resolve());
                    response.on("close", () => resolve());
                    response.resume();
                });
            });

            try {
                await ended;
                await detached;
            } finally {
                request.destroy();
                await close(server);
            }
        }
    },
);
