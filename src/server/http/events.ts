/**
 * Live events for each browser tab: an event stream (`/api/events`), or long polling (`/api/poll`) for connections
 * that hold event streams back. Either way the tab is a `Client` that the app attaches.
 */
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { constants, createGzip, gzip as gzipCallback } from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PocketApp } from "../app.ts";
import type { User } from "../config.ts";
import type { Client } from "../room.ts";
import { pushChannel, type PushSignal } from "../perf-channels.ts";
import { conversationId, json, send } from "./io.ts";

const gzip = promisify(gzipCallback);

/** How long a poll waits for events before answering empty, and how long an unpolled session lives. */
const POLL_HOLD_MS = 25_000;
const POLL_EXPIRE_MS = 60_000;
/** A blocked tab reconnects for a fresh view rather than retaining an unlimited event backlog. */
const STREAM_BUFFER_BYTES = 8 * 1024 * 1024;

/** Explicit gzip refusal beats a wildcard; names and q parameters are case-insensitive. */
export function acceptsGzip(header: string | undefined): boolean {
    const qualities = new Map<string, number>();

    for (const part of (header ?? "").split(",")) {
        const [rawName, ...parameters] = part.trim().toLowerCase().split(";");
        const q = parameters.find((parameter) => parameter.trim().startsWith("q="));
        const value = q === undefined ? 1 : Number(q.trim().slice(2));

        qualities.set(
            rawName!.trim(),
            Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0,
        );
    }

    return (qualities.get("gzip") ?? qualities.get("*") ?? 0) > 0;
}

/** One browser tab that receives events by long polling instead of an event stream. */
interface Poller {
    id: string;
    userId: string;
    client: Client;
    queue: { seq: number; event: string; data: unknown }[];
    seq: number;
    waiting: ServerResponse | undefined;
    /** Whether the waiting request takes a gzip answer. */
    gzip: boolean;
    timer: NodeJS.Timeout | undefined;
    expiry: NodeJS.Timeout | undefined;
}

function newClient(url: URL, user: User, send: Client["send"]): Client {
    const raw = url.searchParams.get("c");

    return {
        id: (url.searchParams.get("tab") ?? randomUUID()).slice(0, 64),
        connection: randomUUID(),
        sessionDeltas: url.searchParams.get("sessions") === "delta",
        user,
        conversationId: raw === null || raw === "" ? undefined : conversationId(raw),
        sentEntries: new Set(),
        orderKey: "",
        send,
    };
}

/** The event routes of one HTTP handler, with their own pollers. */
export function createEventStreams(app: PocketApp, maxStreamBytes = STREAM_BUFFER_BYTES) {
    const events = async (
        request: IncomingMessage,
        response: ServerResponse,
        url: URL,
        user: User,
    ): Promise<void> => {
        // Views and session lists are repetitive JSON: compressed, with each event flushed at once (one compressor per
        // stream, so later events reuse what earlier ones sent). Compression runs off the main thread.
        const compressor = acceptsGzip(request.headers["accept-encoding"])
            ? createGzip({ flush: constants.Z_SYNC_FLUSH, level: 6, memLevel: 7 })
            : undefined;
        const out = compressor ?? response;
        let overflowed = false;

        const write = (frame: string): void => {
            if (out.writableEnded || response.destroyed || overflowed) {
                return;
            }

            const buffered =
                response.writableLength +
                (compressor === undefined
                    ? 0
                    : compressor.writableLength + compressor.readableLength);

            if (buffered + Buffer.byteLength(frame) > maxStreamBytes) {
                overflowed = true;
                compressor?.destroy();
                response.destroy();

                return;
            }

            out.write(frame);
        };

        compressor?.pipe(response);
        compressor?.on("error", () => response.destroy());

        const client = newClient(url, user, (event, data) => {
            if (!out.writableEnded && !response.destroyed && !overflowed) {
                const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

                write(frame);

                if (pushChannel.hasSubscribers) {
                    pushChannel.publish({
                        event,
                        bytes: Buffer.byteLength(frame),
                        transport: "stream",
                    } satisfies PushSignal);
                }
            }
        });

        client.close = () => out.end();
        response.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            // HTTP/2 refuses connection headers: its streams stay open by themselves.
            ...(request.httpVersionMajor >= 2 ? {} : { connection: "keep-alive" }),
            "x-accel-buffering": "no",
            vary: "accept-encoding",
            ...(compressor === undefined ? {} : { "content-encoding": "gzip" }),
        });
        write("retry: 1500\n\n");
        const ping = setInterval(() => {
            if (!out.writableEnded) {
                write(": ping\n\n");
            }
        }, 15_000);

        response.once("close", () => {
            clearInterval(ping);
            compressor?.destroy();
            app.detach(client);
        });
        await app.attach(client);
    };

    // ─── Long polling: the same events as /api/events, for connections that hold back event streams (Cloudflare
    // quick tunnels do). Each answer carries every event after the client's `ack`, so a lost answer is sent again.
    const pollers = new Map<string, Poller>();

    const answerPoll = (poller: Poller): void => {
        clearTimeout(poller.timer);
        poller.timer = undefined;
        const response = poller.waiting;

        poller.waiting = undefined;

        if (response !== undefined && !response.writableEnded) {
            const body = JSON.stringify({ session: poller.id, events: poller.queue });

            // A first answer carries the whole view: compressed off the main thread when it is worth it.
            if (!poller.gzip || body.length < 1024) {
                return send(response, 200, body, "application/json");
            }

            gzip(body).then(
                (compressed) => {
                    if (!response.writableEnded) {
                        send(response, 200, compressed, "application/json", {
                            "content-encoding": "gzip",
                            vary: "accept-encoding",
                        });
                    }
                },
                () => response.destroy(),
            );
        }
    };

    const closePoller = (poller: Poller): void => {
        clearTimeout(poller.expiry);

        if (!pollers.delete(poller.id)) {
            return;
        }

        answerPoll(poller);
        app.detach(poller.client);
    };

    const keepPoller = (poller: Poller): void => {
        clearTimeout(poller.expiry);
        poller.expiry = setTimeout(
            () => (poller.waiting === undefined ? closePoller(poller) : keepPoller(poller)),
            POLL_EXPIRE_MS,
        );
        poller.expiry.unref();
    };

    const poll = async (
        request: IncomingMessage,
        response: ServerResponse,
        url: URL,
        user: User,
    ): Promise<void> => {
        let poller = pollers.get(url.searchParams.get("session") ?? "");

        if (poller !== undefined && poller.userId !== user.id) {
            poller = undefined;
        }

        if (url.searchParams.get("close") === "1") {
            if (poller !== undefined) {
                closePoller(poller);
            }

            return json(response, 200, { ok: true });
        }

        if (poller === undefined) {
            // A new tab, or one whose session ended (the server restarted): attach afresh, which sends hello and a full view.
            const created: Poller = {
                id: randomUUID(),
                userId: user.id,
                client: undefined as unknown as Client,
                queue: [],
                seq: 0,
                waiting: undefined,
                gzip: false,
                timer: undefined,
                expiry: undefined,
            };

            created.client = newClient(url, user, (event, data) => {
                created.queue.push({ seq: ++created.seq, event, data });

                if (pushChannel.hasSubscribers) {
                    pushChannel.publish({
                        event,
                        bytes: null,
                        transport: "poll",
                    } satisfies PushSignal);
                }

                // A short pause lets a burst of events go out in one answer.
                if (created.waiting !== undefined) {
                    clearTimeout(created.timer);
                    created.timer = setTimeout(() => answerPoll(created), 30);
                }
            });
            created.client.close = () => closePoller(created);
            pollers.set(created.id, created);
            keepPoller(created);
            await app.attach(created.client);
            poller = created;
        } else {
            const ack = Number(url.searchParams.get("ack") ?? 0);

            poller.queue = poller.queue.filter((item) => item.seq > ack);
            keepPoller(poller);
        }

        const current = poller;

        // One waiting request per tab: an older one answers now.
        if (current.waiting !== undefined) {
            answerPoll(current);
        }

        current.waiting = response;
        current.gzip = acceptsGzip(request.headers["accept-encoding"]);
        current.timer = setTimeout(
            () => answerPoll(current),
            current.queue.length > 0 ? 30 : POLL_HOLD_MS,
        );
        // Closes when answered, or when the browser gives up on this request.
        response.on("close", () => {
            if (current.waiting !== response) {
                return;
            }

            clearTimeout(current.timer);
            current.waiting = undefined;
        });
    };

    return { events, poll };
}
