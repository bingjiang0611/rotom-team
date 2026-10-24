import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
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

test("preload failures preserve the original page and CSP, then recover on later requests", async (t) => {
    const folder = mkdtempSync(join(tmpdir(), "preload-failure-"));

    t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
        rmSync(folder, { recursive: true, force: true });
    });
    cpSync(WEB, folder, { recursive: true });
    // Redirect only this process's asset reads: never edit the live web directory.
    const stat = fsPromises.stat;
    const readFile = fsPromises.readFile;

    t.mock.method(fsPromises, "stat", (...args: Parameters<typeof stat>) => {
        if (typeof args[0] === "string" && args[0].startsWith(`${WEB}/`)) {
            args[0] = join(folder, args[0].slice(WEB.length + 1));
        }

        return stat(...args);
    });
    t.mock.method(fsPromises, "readFile", (...args: Parameters<typeof readFile>) => {
        if (typeof args[0] === "string" && args[0].startsWith(`${WEB}/`)) {
            args[0] = join(folder, args[0].slice(WEB.length + 1));
        }

        return readFile(...args);
    });
    syncBuiltinESMExports();
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
        const first = await fetch(base);
        const preloaded = await first.text();
        const policy = first.headers.get("content-security-policy");
        const original = readFileSync(join(folder, "index.html"), "utf8");
        const app = join(folder, "app.js");
        const script = readFileSync(app, "utf8");

        const fallback = async () => {
            const response = await fetch(base);

            assert.equal(response.status, 200);
            assert.equal(
                await response.text(),
                original,
                "omit hints, not scripts or page content",
            );
            assert.equal(response.headers.get("content-security-policy"), policy);
            const again = await fetch(base, {
                headers: { "if-none-match": response.headers.get("etag")! },
            });

            assert.equal(again.status, 304, "fallback still supports conditional requests");
            assert.equal(again.headers.get("content-security-policy"), policy);
        };

        const recovered = async () => {
            const response = await fetch(base);

            assert.equal(response.status, 200);
            assert.equal(
                await response.text(),
                preloaded,
                "a failure must not disable future preloads",
            );
            assert.equal(response.headers.get("content-security-policy"), policy);
        };

        assert.equal(first.status, 200);
        assert.match(preloaded, /rel="modulepreload"/);
        assert.ok(policy);

        for (const target of ["./not-a-module.js", "/vendor/not-a-module.mjs"]) {
            // Valid JS: the regex sees an import inside text that is not an import declaration.
            writeFileSync(app, `${script}\nconst example = \`\nimport x from "${target}"\n\`;\n`);
            await fallback();
            writeFileSync(app, script);
            await recovered();
        }

        const theme = join(folder, "theme.js");
        const themeSource = readFileSync(theme);

        rmSync(theme);
        await fallback(); // A previously cached graph must tolerate a source disappearing too.
        writeFileSync(theme, themeSource);
        await recovered();
        rmSync(join(folder, "index.html"));
        const missingPage = await fetch(base);

        assert.equal(
            missingPage.status,
            404,
            "a missing index keeps the original not-found response",
        );
        await missingPage.text();
        writeFileSync(join(folder, "index.html"), original);
        await recovered();
    } finally {
        server.close();
        await once(server, "close");
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
