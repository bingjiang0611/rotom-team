// Legacy service extension files remain available as data but are not loaded in archive mode.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type App, cleanUp, openApp, owner, root, scriptedModel } from "./helpers.ts";

const dataDir = join(root, "data");
const dropIns = join(dataDir, "extensions");
const source =
    "/** preserved historical extension */\nexport default () => { throw new Error('must not load'); };\n";

let app: App;

before(async () => {
    mkdirSync(dropIns, { recursive: true });
    writeFileSync(join(dropIns, "shout.ts"), source);
    app = await openApp(scriptedModel(), dataDir);
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("legacy extension files and choices stay preserved while service loading is disabled", async () => {
    assert.equal(app.loader, undefined);
    assert.equal(readFileSync(join(dropIns, "shout.ts"), "utf8"), source);

    app.config.addUser("Sid", "guest", ["1"]);
    assert.deepEqual(app.config.enabledExtensions, []);
    assert.deepEqual(app.config.disabledExtensions, []);
    await assert.rejects(
        app.setExtensionEnabled(owner(app), "shout.ts", true),
        /Agent Extensions only|read-only archive/,
    );
});

test("archive restart does not delete or execute preserved extension source", async () => {
    await app.close();
    app = await openApp(scriptedModel(), dataDir);

    assert.equal(app.loader, undefined);
    assert.equal(readFileSync(join(dropIns, "shout.ts"), "utf8"), source);
});
