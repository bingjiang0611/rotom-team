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
import { parseClaim } from "../view-claim.ts";
import { HttpError } from "../errors.ts";
import { SUBSCRIPTION_COPY } from "../constants/copy.ts";

const ROOM_EVENTS = new Set(["view", "missing", "chat", "notes", "browser", "presence", "changes"]);

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
    queue: { seq: number; json: string; bytes: number }[];
    queueBytes: number;
    seq: number;
    waiting: ServerResponse | undefined;
    /** Whether the waiting request takes a gzip answer. */
    gzip: boolean;
    timer: NodeJS.Timeout | undefined;
    expiry: NodeJS.Timeout | undefined;
}

/** The newest entries a tab may ask to be pushed (`tail`); anything else is ignored, and the tab gets every entry. */
function viewTail(raw: string | null): number | undefined {
    const tail = Number(raw);

    return raw !== null && Number.isSafeInteger(tail) && tail >= 1 && tail <= 100_000
        ? tail
        : undefined;
}

function newClient(url: URL, user: User, send: Client["send"]): Client {
    const raw = url.searchParams.get("c");
    const tail = viewTail(url.searchParams.get("tail"));

    const generation =
        url.searchParams.get("subscriptions") === "1"
            ? Number(url.searchParams.get("generation"))
            : undefined;

    if (generation !== undefined && (!Number.isSafeInteger(generation) || generation < 0)) {
        throw new HttpError(400, SUBSCRIPTION_COPY.invalidRequest);
    }

    const client: Client = {
        id: (url.searchParams.get("tab") ?? randomUUID()).slice(0, 64),
        connection: randomUUID(),
        sessionDeltas: url.searchParams.get("sessions") === "delta",
        liveDeltas: url.searchParams.get("live") === "delta",
        user,
        conversationId: raw === null || raw === "" ? undefined : conversationId(raw),
        viewClaim:
            raw === null || raw === "" ? undefined : parseClaim(url.searchParams.get("have")),
        ...(tail === undefined ? {} : { viewTail: tail }),
        sentEntries: new Set(),
        orderKey: "",
        subscriptionGeneration: generation,
        send(event, data) {
            // Stamp before serialization/enqueue, never when an old poll batch is retransmitted.
            send(
                event,
                generation !== undefined && ROOM_EVENTS.has(event)
                    ? { generation: client.subscriptionGeneration, data }
                    : data,
            );
        },
    };

    return client;
}

/** The event routes of one HTTP handler, with their own pollers. */
export function createEventStreams(app: PocketApp, maxBufferedBytes = STREAM_BUFFER_BYTES) {
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

            if (buffered + Buffer.byteLength(frame) > maxBufferedBytes) {
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
            // Each event is frozen at enqueue time. Retransmission only joins those strings.
            const body = `{"session":"${poller.id}","events":[${poller.queue.map((item) => item.json).join(",")}]}`;

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
        poller.queue = [];
        poller.queueBytes = 0;
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
                queueBytes: 0,
                seq: 0,
                waiting: undefined,
                gzip: false,
                timer: undefined,
                expiry: undefined,
            };

            created.client = newClient(url, user, (event, data) => {
                if (!pollers.has(created.id)) {
                    return;
                }

                const seq = ++created.seq;
                const json = JSON.stringify({ seq, event, data });
                // Include the array separator. The fixed UUID envelope adds only constant overhead.
                const bytes = Buffer.byteLength(json) + 1;

                if (created.queueBytes + bytes > maxBufferedBytes) {
                    // Never send a partial initial view as success. A new poll gets a fresh full view.
                    created.waiting?.destroy();
                    created.waiting = undefined;
                    closePoller(created);

                    return;
                }

                created.queue.push({ seq, json, bytes });
                created.queueBytes += bytes;

                if (pushChannel.hasSubscribers) {
                    pushChannel.publish({
                        event,
                        bytes: null,
                        transport: "poll",
                    } satisfies PushSignal);
                }

                // Answer once this burst of events (sent together, synchronously) is queued: the tab is waiting.
                if (created.waiting !== undefined) {
                    clearTimeout(created.timer);
                    created.timer = setTimeout(() => answerPoll(created), 0);
                }
            });
            created.client.close = () => closePoller(created);
            pollers.set(created.id, created);
            keepPoller(created);
            await app.attach(created.client);

            if (!pollers.has(created.id)) {
                response.destroy();

                return;
            }

            poller = created;
        } else {
            const ack = Number(url.searchParams.get("ack") ?? 0);

            if (!Number.isSafeInteger(ack) || ack < 0 || ack > poller.seq) {
                throw new HttpError(400, SUBSCRIPTION_COPY.invalidAck);
            }

            let acknowledgedBytes = 0;

            poller.queue = poller.queue.filter((item) => {
                if (item.seq > ack) {
                    return true;
                }

                acknowledgedBytes += item.bytes;

                return false;
            });
            poller.queueBytes -= acknowledgedBytes;
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
            current.queue.length > 0 ? 0 : POLL_HOLD_MS,
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
