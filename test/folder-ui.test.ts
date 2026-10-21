// A recent-folder history must not squeeze the working-directory browser into a clipped toolbar.
import { cleanUp, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";

const executable = findBrowser();

after(cleanUp);

test(
    "folder browsing keeps usable space with recent folders, long paths and short viewports",
    { skip: executable === undefined && "no Chromium available", timeout: 60_000 },
    async () => {
        const app = await openApp(scriptedModel());
        const server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );
        const browsers = new Browsers({
            dataDir: join(root, "folder-browser"),
            load: async () => undefined,
            save: () => {},
        });

        try {
            await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
            const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
            const page = await browsers.open(1);
            const evaluate = async (script: string) => JSON.parse(await page.evaluate(script));
            const present = (selector: string) =>
                evaluate(
                    `return JSON.stringify(!!document.querySelector(${JSON.stringify(selector)}))`,
                );
            const click = (selector: string) =>
                page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);

            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await until(
                async () =>
                    evaluate(`return JSON.stringify(!!(await import('/store.js')).store.state.me)`),
                "signed in",
            );
            // Only the folder catalogue is synthetic; render the real sheet, styles and controls.
            await evaluate(`
                const original = window.fetch;
                window.folderRequests = [];
                window.fetch = (input, options) => {
                    if (!String(input).startsWith('/api/fs?')) return original(input, options);
                    window.folderRequests.push(String(input));
                    const path = new URL(input, location.href).searchParams.get('path');
                    return Promise.resolve(Response.json({
                        path, home: '/Users/test', parent: '/Users/test',
                        dirs: Array.from({ length: 40 }, (_, i) => ({
                            name: 'folder-' + i, path: path + '/folder-' + i,
                        })),
                        recent: Array.from({ length: 8 }, (_, i) =>
                            '/Users/test/rotom-team-deployment/workspace/' + 'long-project-name-'.repeat(8) + i),
                    }));
                };
                return JSON.stringify(true);
            `);

            for (const viewport of [
                { width: 1280, height: 800, scale: 1, mobile: false },
                { width: 720, height: 717, scale: 2, mobile: false },
                { width: 390, height: 844, scale: 2, mobile: true },
                { width: 740, height: 420, scale: 1, mobile: false },
            ]) {
                for (const mode of ["new", "change"]) {
                    const label = `${viewport.width}x${viewport.height} ${mode}`;

                    await page.setViewport(viewport);
                    await evaluate(`
                        const { openSheet, store } = await import('/store.js');
                        store.set({ server: { ...store.state.server,
                            defaultCwd: '/Users/test/rotom-team-deployment/workspace/' + 'long-path-'.repeat(10) } });
                        openSheet({ type: 'cwd', mode: ${JSON.stringify(mode)} });
                        return JSON.stringify(true);
                    `);
                    await until(() => present(".cwd-sheet .dir-entries .list-item"), label);
                    await page.evaluate(`document.querySelectorAll('.cwd-sheet, .cwd-sheet *').forEach(
                        node => node.style.animation = 'none')`);

                    assert.equal(
                        await evaluate(
                            `return JSON.stringify(document.querySelector('.cwd-recent').open)`,
                        ),
                        false,
                        `${label}: recent folders are collapsed initially`,
                    );

                    for (const expanded of [false, true]) {
                        if (expanded) {
                            await click(".cwd-recent summary");
                        }

                        const layout = await evaluate(`
                            const sheet = document.querySelector('.cwd-sheet');
                            const entries = sheet.querySelector('.dir-entries');
                            const tools = sheet.querySelector('.dir-tools');
                            const recent = sheet.querySelector('.cwd-recent-list');
                            return JSON.stringify({
                                height: entries.clientHeight,
                                rowHeight: entries.firstElementChild.getBoundingClientRect().height,
                                scrolls: entries.scrollHeight > entries.clientHeight,
                                toolsHeight: tools.clientHeight,
                                buttonHeight: tools.querySelector('button').getBoundingClientRect().height,
                                recentHeight: recent.clientHeight,
                                recentScrolls: recent.scrollHeight > recent.clientHeight,
                                overflow: sheet.scrollWidth > sheet.clientWidth ||
                                    sheet.querySelector('.sheet-body').scrollWidth > sheet.clientWidth,
                                fits: sheet.getBoundingClientRect().height <= innerHeight,
                            });
                        `);

                        assert.ok(
                            layout.height >= layout.rowHeight * 2,
                            `${label}: usable list ${JSON.stringify(layout)}`,
                        );
                        assert.ok(layout.scrolls, `${label}: folders scroll independently`);
                        assert.ok(
                            layout.toolsHeight >= layout.buttonHeight,
                            `${label}: toolbar is not clipped`,
                        );
                        assert.equal(
                            layout.overflow,
                            false,
                            `${label}: long paths do not overflow`,
                        );
                        assert.ok(layout.fits, `${label}: sheet stays in the viewport`);

                        if (expanded) {
                            assert.ok(
                                layout.recentHeight > 0 && layout.recentScrolls,
                                `${label}: recent history is capped and scrollable`,
                            );
                        }
                    }

                    // Scrolling the entries leaves the toolbar outside that scroll region.
                    assert.ok(
                        await evaluate(`
                        const entries = document.querySelector('.dir-entries');
                        const tools = document.querySelector('.dir-tools');
                        const before = tools.getBoundingClientRect().top;
                        entries.scrollTop = entries.scrollHeight;
                        return JSON.stringify(entries.scrollTop > 0 && tools.getBoundingClientRect().top === before);
                    `),
                        `${label}: scrolling does not move the toolbar`,
                    );
                    await click(".dir-tools input");
                    await until(
                        async () =>
                            evaluate(
                                `return JSON.stringify(window.folderRequests.at(-1).includes('hidden=1'))`,
                            ),
                        "show hidden reloads the catalogue",
                    );
                    await click(".dir-tools button");
                    await until(() => present(".new-folder input"), "new folder name");
                    assert.ok(
                        await evaluate(`
                        const input = document.querySelector('.new-folder input');
                        input.scrollIntoView({ block: 'nearest' });
                        const rect = input.getBoundingClientRect();
                        return JSON.stringify(rect.width > 40 && rect.height >= 30 &&
                            document.querySelector('.dir-entries').clientHeight > 40);
                    `),
                        `${label}: naming a folder leaves both input and entries usable`,
                    );
                    await click('.new-folder [aria-label="Cancel"]');
                    await click(".cwd-sheet .row button");
                    await until(async () => !(await present(".dir-list")), "hide browser");
                    await click(".cwd-sheet .row button");
                    await until(() => present(".dir-entries"), "browse again");
                    await evaluate(
                        `(await import('/store.js')).closeSheet(); return JSON.stringify(true)`,
                    );
                    await until(async () => !(await present(".cwd-sheet")), "sheet closed");
                }
            }
        } finally {
            await browsers.closeAll({ final: true });
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await app.close();
        }
    },
);
