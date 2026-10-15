// Native file reads use the execution HOME, not the server HOME. No inference or real accounts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { PocketApp } from "../src/server/app.ts";
import { createHandler } from "../src/server/http.ts";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { cleanUp, owner, root, until, work as workspace } from "./helpers.ts";

const work = realpathSync(workspace);

let app: PocketApp;
let server: Server;
let base: string;
let id: ConversationId;
let home: string;
const report = ".local/state/runtime-verify/证据 report.md";
const content = "# Native report\n\nRead from the execution HOME.\n";
const get = (path: string, route = "view", token = app.config.ownerToken) =>
    fetch(`${base}/api/c/${id}/${route}?path=${encodeURIComponent(path)}`, {
        headers: { authorization: `Bearer ${token}` },
    });

before(async () => {
    app = await PocketApp.open({
        dataDir: join(realpathSync(root), "native-files-data"),
        defaultCwd: work,
        kernel: true,
        supervised: false,
        browser: null,
        log: () => {},
        configureUserModels: (models) =>
            models.registerNativeProvider({
                id: "openai",
                name: "Synthetic native files",
                auth: {
                    apiKey: {
                        name: "Synthetic",
                        resolve: async () => ({
                            auth: { apiKey: "synthetic-never-dispatched" },
                            source: "test",
                        }),
                    },
                },
                getModels: () => [
                    {
                        id: "gpt-5.4-mini",
                        name: "Synthetic model",
                        provider: "openai",
                        api: "openai-completions",
                        baseUrl: "http://127.0.0.1:1/not-used",
                        reasoning: true,
                        input: ["text"],
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        contextWindow: 1000,
                        maxTokens: 100,
                    },
                ],
                stream: () => {
                    throw new Error("No model request permitted");
                },
                streamSimple: () => {
                    throw new Error("No model request permitted");
                },
            }),
    });
    ({ id } = await app.commands.createSession(owner(app), { backend: "rotom" }));
    home = app.kernel!.executions.journal.session(String(id)).binding.home;
    mkdirSync(join(home, ".local/state/runtime-verify"), { recursive: true });
    writeFileSync(join(home, report), content);
    writeFileSync(join(work, "native-workspace-report.md"), "Workspace report");
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    if (server) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    await app?.close();
    cleanUp();
});

test("native ~/ reports preview, download and attach from the bound HOME", async () => {
    assert.notEqual(home, homedir());
    assert.equal(app.workspace.conversationPath(id, "~"), home);
    assert.equal(app.workspace.conversationPath(id, `~/${report}`), join(home, report));
    assert.equal(app.workspace.readableFile(owner(app), id, `~/${report}`), join(home, report));
    const preview = await get(`~/${report}`);

    assert.equal(preview.status, 200);
    assert.deepEqual(await preview.json(), {
        path: join(home, report),
        display: `~/${report}`,
        kind: "text",
        size: Buffer.byteLength(content),
        text: content,
        truncated: false,
    });
    const download = await get(`~/${report}`, "download");

    assert.equal(download.status, 200);
    assert.equal(await download.text(), content);
    assert.equal((await get(join(home, report))).status, 200);
    assert.equal((await get("native-workspace-report.md")).status, 200);
    assert.equal(
        app.workspace.conversationPath(id, join(homedir(), "report.md")),
        join(homedir(), "report.md"),
    );
});

test("native HOME resolution does not grant access to private state or bypass workspace scope", async () => {
    const guest = app.config.addUser("Team member", "guest");
    const scoped = app.config.addUser("Session member", "guest", [String(id)]);
    const viewer = app.config.addUser("Viewer", "viewer", [String(id)]);

    mkdirSync(join(home, ".pi/agent"), { recursive: true });
    writeFileSync(join(home, ".pi/agent/file-view-private-fixture.json"), "private fixture");
    symlinkSync(join(home, report), join(work, "native-private-report.md"));

    for (const token of [guest.token, scoped.token]) {
        for (const path of [
            `~/${report}`,
            "~/.pi/agent/file-view-private-fixture.json",
            "native-private-report.md",
        ]) {
            for (const route of ["view", "download"]) {
                assert.equal((await get(path, route, token)).status, 404);
            }
        }

        assert.equal((await get("native-workspace-report.md", "view", token)).status, 200);
    }

    assert.equal((await get(`~/${report}`, "view", viewer.token)).status, 403);
    const denied = await get(`~/${report}`, "view", guest.token);

    assert.match((await denied.json()).error, /outside.*readable locations/);
});

test("missing native files explain how to recover without trying the server HOME", async () => {
    const missing = await get("~/missing-native-report.md");

    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error, /Ask the agent.*workspace/);
});

test(
    "native home links open in both the sheet and the Files panel",
    {
        skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
    },
    async () => {
        const browsers = new Browsers({
            dataDir: mkdtempSync(join(root, "native-files-browser-")),
            load: async () => undefined,
            save: () => {},
        });

        try {
            const page = await browsers.open(1);
            const ready = async (expression: string) =>
                JSON.parse(await page.evaluate(`return JSON.stringify(${expression})`)) as boolean;

            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await page.navigate(`${base}/s/${id}`);
            await until(
                () =>
                    ready(
                        `(await import('/store.js')).store.state.view.conversation?.id === ${JSON.stringify(id)}`,
                    ),
                "native session loaded",
                20_000,
            );
            await page.evaluate(
                `(await import('/ui.js')).openFile(${JSON.stringify(`~/${report}`)})`,
            );
            await until(
                () =>
                    ready(
                        `document.querySelector('.file-viewer .md')?.textContent.includes('Read from the execution HOME.') === true`,
                    ),
                "native HOME sheet preview",
            );
            assert.equal(
                await ready(
                    `document.querySelector('.file-path').title === ${JSON.stringify(join(home, report))}`,
                ),
                true,
            );
            await page.evaluate(`
            (await import('/store.js')).closeSheet();
            (await import('/files-panel.js')).setFilesOpen(true, 'files');
        `);
            await until(
                () => ready(`document.querySelector('.files-body') !== null`),
                "Files panel mounted",
            );
            await page.evaluate(
                `(await import('/ui.js')).openFile(${JSON.stringify(`~/${report}`)})`,
            );
            await until(
                () =>
                    ready(
                        `document.querySelector('.files-body .file-viewer .md')?.textContent.includes('Read from the execution HOME.') === true`,
                    ),
                "native HOME panel preview",
            );
            assert.equal(
                await ready(
                    `document.querySelector('.files-body .file-path').title === ${JSON.stringify(join(home, report))}`,
                ),
                true,
            );
            assert.deepEqual(
                page.logs().filter((entry) => entry.level === "error"),
                [],
            );
        } finally {
            await browsers.closeAll();
        }
    },
);
