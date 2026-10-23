/** Bounded, revalidated app assets. File reads and gzip run asynchronously, once per observed file revision. */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";
import { gzip as compress } from "node:zlib";
import { acceptsGzip } from "./events.ts";
import { send } from "./io.ts";

const gzip = promisify(compress);
const LIMIT = 16 * 1024 * 1024;
const files = new Map<string, { stamp: string; asset: Asset }>();
const pending = new Map<string, Promise<Asset>>();
let bytes = 0;

type Asset = {
    body: Buffer;
    etag: string;
    zipped?: Buffer;
    zippedTag?: string;
    compressing?: Promise<Buffer>;
};

export function asset(body: Buffer): Asset {
    return { body, etag: createHash("sha256").update(body).digest("hex") };
}

function trim(): void {
    while (bytes > LIMIT || files.size > 128) {
        const key = files.keys().next().value!;
        const value = files.get(key)!.asset;

        bytes -= value.body.length + (value.zipped?.length ?? 0);
        files.delete(key);
    }
}

export async function readAsset(file: string): Promise<Asset> {
    const stats = await stat(file, { bigint: true });
    const stamp = `${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
    const cached = files.get(file);

    if (cached?.stamp === stamp) {
        return cached.asset;
    }

    const key = `${file}\0${stamp}`;
    const inflight = pending.get(key);

    if (inflight) {
        return inflight;
    }

    const loading = readFile(file)
        .then((body) => {
            const value = asset(body);
            const previous = files.get(file)?.asset;

            if (previous) {
                bytes -= previous.body.length + (previous.zipped?.length ?? 0);
            }

            files.delete(file);
            files.set(file, { stamp, asset: value });
            bytes += body.length;
            trim();

            return value;
        })
        .finally(() => pending.delete(key));

    pending.set(key, loading);

    return loading;
}

export async function sendAsset(
    request: IncomingMessage,
    response: ServerResponse,
    value: Asset,
    type: string,
    extra: Record<string, string> = {},
): Promise<void> {
    const compressed = acceptsGzip(request.headers["accept-encoding"]);
    let body = value.body;

    if (compressed) {
        if (!value.compressing) {
            value.compressing = gzip(value.body)
                .then((zipped) => {
                    value.zipped = zipped;
                    value.zippedTag = createHash("sha256").update(zipped).digest("hex");

                    if ([...files.values()].some((entry) => entry.asset === value)) {
                        bytes += zipped.length;
                        trim();
                    }

                    return zipped;
                })
                .catch((error) => {
                    value.compressing = undefined;

                    throw error;
                });
        }

        body = await value.compressing;
        response.setHeader("content-encoding", "gzip");
    }

    // Hash the actual representation, including gzip bytes, even across Node/zlib upgrades.
    const etag = `"${compressed ? value.zippedTag : value.etag}"`;
    const headers = { ...extra, "cache-control": "no-cache", vary: "Accept-Encoding", etag };
    const matches = request.headers["if-none-match"]?.split(",").some((tag) => {
        const normalized = tag.trim().replace(/^W\//, "");

        return normalized === "*" || normalized === etag;
    });

    if (matches && (request.method === "GET" || request.method === "HEAD")) {
        send(response, 304, "", type, headers);

        return;
    }

    send(response, 200, body, type, headers);
}
