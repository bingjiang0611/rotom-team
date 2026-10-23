/** Measure the public static-asset bundle without a browser navigation or fetch decompression. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { VENDOR, WEB } from "../../src/server/http/assets.ts";
import { join } from "node:path";

/** Public non-module files included in the synthetic bundle workload. */
export const SYNTHETIC_PUBLIC_ASSETS = [
    "/apple-touch-icon.png",
    "/icon-192.png",
    "/icon-512.png",
    "/icon.svg",
    "/manifest.webmanifest",
    "/fonts/JetBrainsMono.woff2",
    "/fonts/OFL.txt",
] as const;

type Asset = { path: string; file: string };

/** The files requested by the bundle workload, in a stable order. */
export function enumerateStaticAssets(): Asset[] {
    const root = readdirSync(WEB, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.(?:js|css)$/i.test(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => ({ path: `/${entry.name}`, file: join(WEB, entry.name) }));
    const vendor = Object.entries(VENDOR).map(([name, file]) => ({
        path: `/vendor/${name}`,
        file,
    }));
    const synthetic = SYNTHETIC_PUBLIC_ASSETS.map((path) => ({
        path,
        file: join(WEB, path.slice(1)),
    }));

    return [...root, ...vendor, ...synthetic];
}

type RawAssetResponse = {
    status: number;
    etag: string | undefined;
    encoding: string | undefined;
    body: Buffer;
};

/** One raw HTTP response; unlike fetch, node:http does not transparently decode Content-Encoding. */
export function requestAsset(url: string, etag?: string): Promise<RawAssetResponse> {
    return new Promise((resolve, reject) => {
        const request = httpRequest(
            url,
            {
                headers: {
                    "accept-encoding": "gzip",
                    ...(etag === undefined ? {} : { "if-none-match": etag }),
                },
            },
            (response) => {
                const chunks: Buffer[] = [];

                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.once("end", () =>
                    resolve({
                        status: response.statusCode ?? 0,
                        etag: response.headers.etag,
                        encoding: response.headers["content-encoding"],
                        body: Buffer.concat(chunks),
                    }),
                );
                response.once("error", reject);
            },
        );

        request.once("error", reject);
        request.end();
    });
}

function decoded(response: RawAssetResponse): Buffer {
    if (response.encoding === undefined || response.encoding === "identity") {
        return response.body;
    }

    if (response.encoding === "gzip") {
        return gunzipSync(response.body);
    }

    throw new Error(`Unsupported static asset content encoding: ${response.encoding}`);
}

function digest(body: Buffer): string {
    return createHash("sha256").update(body).digest("hex");
}

type ObservedAsset = {
    digest: string;
    etag: string | undefined;
    body: Buffer;
};

/** A two-phase probe. The second phase reuses the first phase's observed ETags and body digests. */
export function createStaticAssetsProbe(base: string) {
    const assets = enumerateStaticAssets();
    const observed = new Map<string, ObservedAsset>();
    const expected = new Map(assets.map((asset) => [asset.path, readFileSync(asset.file)]));

    const first = async (): Promise<Record<string, number>> => {
        let bodyBytes = 0;
        let requests = 0;

        for (const asset of assets) {
            const response = await requestAsset(`${base}${asset.path}`);
            const body = decoded(response);

            assert.equal(
                response.status,
                200,
                `${asset.path}: expected 200, got ${response.status}`,
            );
            assert.deepEqual(body, expected.get(asset.path), `${asset.path}: actual file bytes`);
            observed.set(asset.path, { digest: digest(body), etag: response.etag, body });
            bodyBytes += response.body.length;
            requests++;
        }

        return { "http.body.bytes": bodyBytes, "http.requests": requests };
    };

    const validated = async (): Promise<Record<string, number>> => {
        assert.equal(observed.size, assets.length, "assets.validated requires assets.first");
        let bodyBytes = 0;
        let requests = 0;

        for (const asset of assets) {
            const prior = observed.get(asset.path)!;
            const response = await requestAsset(`${base}${asset.path}`, prior.etag);

            requests++;
            bodyBytes += response.body.length;

            if (response.status === 304) {
                assert.equal(response.body.length, 0, `${asset.path}: 304 response must be empty`);
                assert.equal(response.etag, prior.etag, `${asset.path}: 304 ETag changed`);
            } else {
                const body = decoded(response);

                assert.equal(
                    response.status,
                    200,
                    `${asset.path}: expected 200/304, got ${response.status}`,
                );
                assert.deepEqual(body, prior.body, `${asset.path}: validated body changed`);
                assert.equal(digest(body), prior.digest, `${asset.path}: validated digest changed`);
            }
        }

        return { "http.body.bytes": bodyBytes, "http.requests": requests };
    };

    return { assets, first, validated };
}
