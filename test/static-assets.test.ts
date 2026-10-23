import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { test } from "node:test";
import ts from "typescript";
import { serveApp, serveFile, WEB, VENDOR } from "../src/server/http/assets.ts";
import { readAsset } from "../src/server/http/static-cache.ts";
import { requestAsset } from "./perf/static-assets.ts";

test("static assets revalidate actual gzip bytes, edits, concurrent reads and bounded caching", async () => {
    const folder = mkdtempSync(join(tmpdir(), "static-assets-"));
    const file = join(folder, "app.js");
    const original = "export const message = 'original';\n".repeat(200);

    writeFileSync(file, original);
    const server = createServer((request, response) => {
        void serveFile(request, response, file).catch((error) => {
            response.writeHead(500);
            response.end(String(error));
        });
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    try {
        const [one, two] = await Promise.all([readAsset(file), readAsset(file)]);

        assert.equal(one, two, "one read per concurrent file revision");
        const first = await requestAsset(base);

        assert.equal(first.encoding, "gzip");
        assert.ok(first.body.length < Buffer.byteLength(original));
        assert.equal(gunzipSync(first.body).toString(), original);
        const compression = one.compressing;
        const second = await requestAsset(base, first.etag);

        assert.equal(second.status, 304);
        assert.equal(second.body.length, 0);
        assert.equal(one.compressing, compression, "reuse the compression promise");
        const identity = await fetch(base, {
            headers: { "accept-encoding": "gzip;q=0, identity" },
        });

        assert.equal(identity.headers.get("content-encoding"), null);
        assert.notEqual(identity.headers.get("etag"), first.etag);
        assert.equal(identity.headers.get("cache-control"), "no-cache");
        assert.equal(await identity.text(), original);
        const changed = original.replaceAll("original", "modified");

        writeFileSync(file, changed);
        const edited = await requestAsset(base, first.etag);

        assert.equal(edited.status, 200, "same-size edits invalidate the old validator");
        assert.notEqual(edited.etag, first.etag);
        assert.equal(gunzipSync(edited.body).toString(), changed);
        const beforeEviction = await readAsset(file);
        const oversized = join(folder, "large.js");

        writeFileSync(oversized, Buffer.alloc(16 * 1024 * 1024 + 1));
        await readAsset(oversized);
        assert.notEqual(await readAsset(file), beforeEviction, "bounded cache evicts old data");
        rmSync(file);
        assert.equal((await requestAsset(base)).status, 404, "deletion cannot serve stale bytes");
    } finally {
        server.close();
        await once(server, "close");
        rmSync(folder, { recursive: true, force: true });
    }
});

test("module preloads match an independent parser's static graph and preserve script order/CSP", async () => {
    const server = createServer((request, response) => {
        void serveApp(request, response).catch((error) => {
            response.writeHead(500);
            response.end(String(error));
        });
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    try {
        const response = await fetch(base);
        const html = await response.text();
        const source = readFileSync(join(WEB, "index.html"), "utf8");
        const imports = JSON.parse(
            /<script type="importmap">([\s\S]*?)<\/script>/.exec(source)![1]!,
        ).imports as Record<string, string>;
        const expected = new Set<string>();

        const visit = (url: string) => {
            if (expected.has(url)) {
                return;
            }

            expected.add(url);
            const file = url.startsWith("/vendor/")
                ? VENDOR[url.slice(8)]!
                : join(WEB, url.slice(1));
            const ast = ts.createSourceFile(
                file,
                readFileSync(file, "utf8"),
                ts.ScriptTarget.Latest,
                true,
                ts.ScriptKind.JS,
            );

            for (const statement of ast.statements) {
                if (
                    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
                    statement.moduleSpecifier &&
                    ts.isStringLiteral(statement.moduleSpecifier)
                ) {
                    const name = statement.moduleSpecifier.text;

                    visit(imports[name] ?? new URL(name, `http://app.local${url}`).pathname);
                }
            }
        };

        visit("/app.js");
        const actual = new Set(
            [...html.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map(
                (match) => match[1],
            ),
        );

        assert.equal(response.status, 200);
        assert.deepEqual(actual, expected);
        assert.deepEqual(
            [...html.matchAll(/<script[\s\S]*?<\/script>/g)].map((m) => m[0]),
            [...source.matchAll(/<script[\s\S]*?<\/script>/g)].map((m) => m[0]),
        );
        assert.ok(html.indexOf('rel="modulepreload"') > html.indexOf('type="importmap"'));
        assert.match(
            response.headers.get("content-security-policy")!,
            /script-src 'self' 'sha256-/,
        );
        const again = await fetch(base, {
            headers: { "if-none-match": response.headers.get("etag")! },
        });

        assert.equal(again.status, 304);
    } finally {
        server.close();
        await once(server, "close");
    }
});
