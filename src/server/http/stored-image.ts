/** Stored image HTTP semantics, after session/fork authorization and byte-integrity checks. */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export function sendStoredImage(
    request: IncomingMessage,
    response: ServerResponse,
    image: { data: Buffer; mimeType: string; etag?: string },
): void {
    const { data, mimeType } = image;
    const etag = image.etag ?? `"sha256-${createHash("sha256").update(data).digest("hex")}"`;
    const headers = {
        "content-type": mimeType,
        "cache-control": "private, max-age=31536000, immutable",
        "accept-ranges": "bytes",
        etag,
    };
    const matches = String(request.headers["if-none-match"] ?? "")
        .split(",")
        .some((value) => value.trim() === "*" || value.trim().replace(/^W\//, "") === etag);

    if (matches) {
        response.writeHead(304, headers);
        response.end();

        return;
    }

    let start = 0;
    let end = data.length - 1;
    let partial = false;
    const range = request.headers.range;
    const ifRange = request.headers["if-range"];

    // Range applies only to GET. Unsupported units/multipart and stale/weak/date If-Range get a full response.
    if (
        request.method === "GET" &&
        typeof range === "string" &&
        (ifRange === undefined || ifRange === etag)
    ) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());

        if (match && (match[1] !== "" || match[2] !== "")) {
            partial = true;

            if (match[1] === "") {
                const suffix = Number(match[2]);

                start = Math.max(0, data.length - suffix);
            } else {
                start = Number(match[1]);
                end = match[2] === "" ? end : Math.min(end, Number(match[2]));
            }

            if (
                !Number.isSafeInteger(start) ||
                !Number.isSafeInteger(end) ||
                start > end ||
                start >= data.length
            ) {
                response.writeHead(416, {
                    ...headers,
                    "content-range": `bytes */${data.length}`,
                    "content-length": 0,
                });
                response.end();

                return;
            }
        }
    }

    response.writeHead(partial ? 206 : 200, {
        ...headers,
        "content-length": end - start + 1,
        ...(partial ? { "content-range": `bytes ${start}-${end}/${data.length}` } : {}),
    });
    response.end(request.method === "HEAD" ? undefined : data.subarray(start, end + 1));
}
