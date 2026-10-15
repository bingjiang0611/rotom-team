// Real Team startup and HTTP checks; no inference, external services or personal configuration.
import { cleanUp, owner, root, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { PocketApp } from "../src/server/app.ts";
import { createHandler } from "../src/server/http.ts";

after(cleanUp);

const open = (dataDir: string) =>
    PocketApp.open({
        dataDir,
        defaultCwd: realpathSync(work),
        supervised: false,
        kernel: true,
        browser: null,
        log: () => {},
        configureUserModels: (models) => models.registerNativeProvider(scriptedModel().provider),
    });

test("Team startup has no server extension loader or drop-in directory", async () => {
    const dataDir = join(realpathSync(root), "no-service-extensions");
    const app = await open(dataDir);

    try {
        assert.ok(app.kernel);
        assert.equal(app.loader, undefined);
        assert.equal(existsSync(join(dataDir, "extensions")), false);
        assert.deepEqual((await app.hello(owner(app))).server.extensions, []);
        assert.equal(app.guardOn(), false);
        assert.equal(app.browserOn(), false);
    } finally {
        await app.close();
    }
});

test("Team ignores enabled legacy drop-ins and refuses listing, toggling and reloading them", async () => {
    const dataDir = join(realpathSync(root), "retained-service-extensions");
    const directory = join(dataDir, "extensions");
    const marker = join(dataDir, "extension-executed");
    const source = `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "must not execute");
export default function () { return []; }
`;
    const file = join(directory, "probe.ts");

    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(file, source);
    let app = await open(dataDir);

    app.config.setExtensionEnabled("probe.ts", true);
    await app.close();
    app = await open(dataDir);
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    try {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as { port: number }).port;

        for (const [path, method] of [
            ["extensions", "GET"],
            ["extensions/probe.ts", "POST"],
            ["extensions/probe.ts/reload", "POST"],
        ] as const) {
            const response = await fetch(`http://127.0.0.1:${port}/api/${path}`, {
                method,
                headers: {
                    authorization: `Bearer ${app.config.ownerToken}`,
                    "x-pocket": "1",
                    "content-type": "application/json",
                },
                ...(method === "POST" ? { body: JSON.stringify({ enabled: false }) } : {}),
            });

            assert.equal(response.status, 404, path);
            assert.match(await response.text(), /Agent Extensions only/);
        }

        await assert.rejects(app.extensions(owner(app)), /Agent Extensions only/);
        await assert.rejects(
            app.setExtensionEnabled(owner(app), "probe.ts", false),
            /Agent Extensions only/,
        );
        await assert.rejects(app.reloadExtension("probe.ts"), /Agent Extensions only/);
        assert.equal(existsSync(marker), false);
        assert.equal(existsSync(join(directory, "node_modules")), false);
        assert.equal(readFileSync(file, "utf8"), source);
        assert.equal(app.config.extensionChoice("probe.ts"), true);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await app.close();
    }
});
