/** Actual native-command browser interactions against the isolated HTTP proof fixture. */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { nativeSessionManager } from "../src/server/rotom-kernel.ts";
import type { PocketApp } from "../src/server/app.ts";
import type { User } from "../src/server/config.ts";
import type { ConversationId } from "@earendil-works/pi-durable";
import { until } from "./helpers.ts";

export async function nativeCommandUiProof(options: {
    root: string;
    base: string;
    modelCalls: () => number;
    app: PocketApp;
    user: User;
    id: ConversationId;
}) {
    assert.ok(findBrowser(), "Chromium is required for this opt-in proof");
    const browsers = new Browsers({
        dataDir: mkdtempSync(join(options.root, "command-browser-")),
        load: async () => undefined,
        save: () => {},
    });
    const page = await browsers.open(1);
    const screenshots: string[] = [];
    const text = (selector: string) =>
        page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`);
    const button = (label: string) =>
        `Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === ${JSON.stringify(label)})`;
    const type = (value: string) =>
        page.evaluate(
            `const input = document.querySelector('.composer textarea'); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', {bubbles: true}));`,
        );
    const send = `document.querySelector('.composer [aria-label="Send"]')`;

    const execute = async (command: string) => {
        await type(command);
        await until(
            async () => (await page.evaluate(`Boolean(${send} && !${send}.disabled)`)) === "true",
            "native composer admits input",
            20_000,
        );
        await page.evaluate(`${send}.click()`);
        await until(
            async () =>
                (await page.evaluate(`document.querySelector('.composer textarea')?.value`)) === "",
            `composer releases ${command}`,
            30_000,
        );
    };

    const screenshot = async (name: string) => {
        const image = await page.screenshot();
        const path = join(options.root, `${name}.jpg`);

        writeFileSync(path, Buffer.from(image.data, "base64"), { mode: 0o600 });
        screenshots.push(path);
    };

    try {
        await page.navigate(`${options.base}/native-command-bootstrap`);
        await until(
            async () =>
                (await page.evaluate(`Boolean(document.querySelector('.composer textarea'))`)) ===
                "true",
            "native composer",
            20_000,
        );
        const before = options.modelCalls();

        await type("/");
        await until(
            async () => (await text(".commands")).includes("/model"),
            "pinned builtin menu",
            20_000,
        );
        assert.ok(!(await text(".commands")).includes("/share"));
        assert.ok(!(await text(".commands")).includes("/bug"));
        await until(
            async () => (await text(".commands")).includes("/goal"),
            "opening slash suggestions discovers the initial catalog without an extra refresh click",
            30_000,
        );
        assert.equal(options.modelCalls(), before);
        await screenshot("native-command-menu");
        await type("/future.");
        await until(
            async () => (await text(".commands")).includes("/future.点"),
            "generic non-ASCII dotted native command suggestion",
        );
        assert.equal(
            await page.evaluate(
                `(await import('/commands.js')).parseCommand('/future.点 exact')?.command.name`,
            ),
            "future.点",
        );
        assert.equal(
            await page.evaluate(
                `(await import('/commands.js')).parseCommand('/constructor exact')?.command.name`,
            ),
            "constructor",
        );

        for (const name of ["fixture-prompt", "skill:pi-subagents"]) {
            await type(`/${name}`);
            await until(
                async () => (await text(".commands")).includes(`/${name}`),
                `${name} suggestion is available`,
            );
            await page.evaluate(
                `Array.from(document.querySelectorAll('.commands button')).find(button => button.querySelector('.command-name')?.textContent === ${JSON.stringify(`/${name}`)}).click()`,
            );
            await until(
                async () =>
                    (await page.evaluate(`document.querySelector('.composer textarea').value`)) ===
                    `/${name} `,
                `${name} fills the draft instead of executing`,
            );
            assert.equal(
                options.modelCalls(),
                before,
                "selecting a template or skill must not infer",
            );
        }

        await execute("/model");
        await until(
            async () => (await text(".pop-menu")).includes("model-a"),
            "real model picker",
            20_000,
        );
        await page.evaluate(
            `Array.from(document.querySelectorAll('.pop-menu-row')).find(button => button.textContent.includes('model-a')).click()`,
        );
        await until(
            async () =>
                (await page.evaluate(
                    `(await import('/store.js')).store.state.view.kernel.model`,
                )) === "model-a",
            "immutable model handoff",
            20_000,
        );
        await execute("/name Browser Native Name");
        await until(
            async () => (await text(".topbar")).includes("Browser Native Name"),
            "native name mirrored into title",
            20_000,
        );
        await execute("/settings");
        await until(
            async () => (await text(".sheet")).includes("imageAutoResize"),
            "real native settings sheet",
            20_000,
        );
        await page.evaluate(
            `Array.from(document.querySelectorAll('.sheet label')).find(label => label.textContent.includes('imageAutoResize')).querySelector('input').click()`,
        );
        await until(
            async () =>
                (await page.evaluate(
                    `String((await (await import('/store.js')).actions.nativeSettings()).imageAutoResize)`,
                )) === "false",
            "native settings persisted",
            20_000,
        );
        await screenshot("native-command-settings");
        await page.evaluate(`(await import('/store.js')).closeSheet()`);
        await execute("/scoped-models");
        await until(
            async () => (await text(".sheet")).includes("Cycle model"),
            "native model scope sheet",
            20_000,
        );
        await page.evaluate(`${button("Cycle model")}.click()`);
        await until(
            async () =>
                (await page.evaluate(
                    `(await import('/store.js')).store.state.view.kernel.model`,
                )) === "model-b",
            "scoped cycle applies through Team",
            20_000,
        );
        await page.evaluate(`(await import('/store.js')).closeSheet()`);
        await execute("/reload");
        assert.equal(options.modelCalls(), before, "selection and settings do not infer");

        await type("/fixture-status");
        await until(
            async () => (await page.evaluate(`Boolean(${send} && !${send}.disabled)`)) === "true",
            "status fixture command ready",
            20_000,
        );
        await page.evaluate(`${send}.click()`);
        await until(
            async () => (await text(".native-question")).includes("Clear native slots?"),
            "native status fixture holds its lease",
            20_000,
        );
        assert.equal(
            await page.evaluate(
                `document.querySelectorAll('[data-status-key="fixture-status"]').length`,
            ),
            "1",
        );
        assert.equal(await text('[data-status-key="fixture-status"]'), "STATUS_19");
        assert.equal(await text('[data-widget-key="fixture-widget"]'), "WIDGET_19");
        assert.ok(!(await text(".notices")).includes("STATUS_"));
        assert.ok(!(await text(".notices")).includes("WIDGET_"));
        await page.evaluate(`${button("Yes")}.click()`);
        await until(
            async () => (await text(".native-question")).includes("Native slots cleared"),
            "clear events arrive while command is live",
            20_000,
        );
        assert.equal(
            await page.evaluate(
                `document.querySelectorAll('[data-status-key="fixture-status"], [data-widget-key="fixture-widget"]').length`,
            ),
            "0",
        );
        await page.evaluate(`${button("Yes")}.click()`);
        await until(
            async () =>
                (await page.evaluate(`document.querySelector('.composer textarea')?.value`)) === "",
            "status command completes",
            20_000,
        );
        await execute("/goal Browser wake proof, then pause for my decision.");
        await until(
            async () => (await text(".goal-bar")).includes("Waiting"),
            "native waiting Goal visible",
            30_000,
        );
        assert.ok((await text(".goal-bar")).includes("Pause"));
        assert.ok(
            Number(await page.evaluate(`document.querySelectorAll('.notices .notice').length`)) <=
                3,
            "Goal status updates must not accumulate notification overlays",
        );
        await screenshot("native-command-goal-waiting");
        const waitingCalls = options.modelCalls();

        await execute("Wake now and pause for my decision.");
        await until(
            async () => (await text(".goal-bar")).includes("paused"),
            "plain composer input wakes native Goal",
            20_000,
        );
        assert.equal(options.modelCalls(), waitingCalls + 1);
        await screenshot("native-command-goal-paused");
        await until(
            () => !options.app.kernel!.isRunning(options.id),
            "paused Goal closes its lease",
            20_000,
        );

        await execute("FIRST_BROWSER_MARKER");
        await until(
            () => !options.app.kernel!.isRunning(options.id),
            "first branch message settles",
            20_000,
        );
        await execute("SECOND_BROWSER_MARKER");
        await until(
            () => !options.app.kernel!.isRunning(options.id),
            "second branch message settles",
            20_000,
        );
        await execute("THIRD_BROWSER_MARKER");
        await until(
            () => !options.app.kernel!.isRunning(options.id),
            "third branch message settles",
            20_000,
        );
        const kernel = options.app.kernel!;
        const segment = kernel.executions.journal.session(String(options.id));
        const native = await nativeSessionManager();
        const activeMessages = () =>
            native.SessionManager.open(segment.sessionFile!)
                .getBranch()
                .filter((entry: { type?: string }) => entry.type === "message");
        const selected = kernel.executions.journal
            .segmentEntries(segment.segmentId)
            .find(
                (entry) =>
                    entry.type === "message" &&
                    (entry.message as { role?: string })?.role === "user" &&
                    JSON.stringify(entry.message).includes("SECOND_BROWSER_MARKER"),
            )!;
        const selectedButton = `.sheet button[data-entry-id="${selected.id}"]`;
        const beforeFork = options.modelCalls();

        await execute("/fork");
        await until(
            async () =>
                (await page.evaluate(
                    `Boolean(document.querySelector(${JSON.stringify(selectedButton)}))`,
                )) === "true",
            "fork selector uses native entry IDs",
            20_000,
        );
        await page.evaluate(`document.querySelector(${JSON.stringify(selectedButton)}).click()`);
        await until(
            async () =>
                (await page.evaluate(`document.querySelector('.composer textarea')?.value`)) ===
                "SECOND_BROWSER_MARKER",
            "fork restores the selected user's native text",
            20_000,
        );
        const forkId = Number(
            await page.evaluate(`(await import('/store.js')).store.state.conversationId`),
        ) as ConversationId;
        const forkHistory = JSON.stringify(kernel.snapshot(forkId, options.user).messages);

        assert.notEqual(forkId, options.id);
        assert.ok(forkHistory.includes("FIRST_BROWSER_MARKER"));
        assert.ok(!forkHistory.includes("SECOND_BROWSER_MARKER"));
        assert.ok(!forkHistory.includes("THIRD_BROWSER_MARKER"));
        assert.equal(options.modelCalls(), beforeFork, "restoring a fork draft never submits it");
        await screenshot("native-command-fork-draft");
        await page.navigate(`${options.base}/s/${options.id}`);
        await until(
            async () =>
                (await page.evaluate(`Boolean(document.querySelector('.composer textarea'))`)) ===
                "true",
            "original source session",
            20_000,
        );
        await execute("/fixture-cancel-tree");
        await execute("/tree");
        await until(
            async () =>
                (await page.evaluate(
                    `Boolean(document.querySelector(${JSON.stringify(selectedButton)}))`,
                )) === "true",
            "tree selector",
            20_000,
        );
        // The real component must stay usable at phone width, not just render short desktop labels.
        const treeAtRest = () =>
            until(
                async () =>
                    (await page.evaluate(`
                const sheet = document.querySelector('.native-tree-sheet');
                return sheet.getAnimations().length === 0 &&
                    sheet.closest('.overlay').getAnimations().length === 0;
            `)) === "true",
                "tree opening animation finishes",
            );

        await treeAtRest();
        await screenshot("native-command-tree-desktop");
        await page.setViewport(VIEWPORTS.mobile);
        await page.evaluate(`await new Promise(resolve => requestAnimationFrame(resolve))`);
        await treeAtRest();
        const mobileTree = JSON.parse(
            await page.evaluate(`
                const sheet = document.querySelector('.native-tree-sheet');
                const list = document.querySelector('.native-tree-list');
                const row = document.querySelector('.native-tree-row');
                const search = document.querySelector('.native-tree-search input');
                const check = document.querySelector('.native-tree-summary input');
                const selected = document.querySelector('.native-tree-row.on').getBoundingClientRect();
                const bounds = list.getBoundingClientRect();
                return JSON.stringify({
                    selectedVisible: selected.top >= bounds.top && selected.bottom <= bounds.bottom,
                    fits: sheet.getBoundingClientRect().right <= innerWidth &&
                        sheet.scrollWidth <= sheet.clientWidth && list.scrollWidth <= list.clientWidth,
                    bottomVisible: sheet.getBoundingClientRect().bottom <= innerHeight + 1 &&
                        document.querySelector('.native-tree-summary').getBoundingClientRect().bottom <= innerHeight,
                    rowHeight: row.getBoundingClientRect().height,
                    searchFont: parseFloat(getComputedStyle(search).fontSize),
                    checkboxWidth: check.getBoundingClientRect().width,
                });
            `),
        );

        assert.equal(mobileTree.fits, true, "tree stays within the 390px viewport");
        assert.equal(mobileTree.bottomVisible, true, "summary control remains visible on a phone");
        assert.equal(
            mobileTree.selectedVisible,
            true,
            "selection stays visible after viewport resize",
        );
        assert.ok(mobileTree.rowHeight >= 44, "touch rows are at least 44px");
        assert.ok(mobileTree.searchFont >= 16, "search does not trigger iOS font-size zoom");
        assert.ok(mobileTree.checkboxWidth < 30, "summary checkbox is not stretched");
        await screenshot("native-command-tree-mobile");
        await page.setViewport(VIEWPORTS.desktop);
        await type("KEEP_CANCELLED_DRAFT");
        await page.evaluate(`document.querySelector(${JSON.stringify(selectedButton)}).click()`);
        await until(
            async () => (await text(".notices")).includes("navigation was cancelled"),
            "native cancellation forwarded",
            20_000,
        );
        assert.equal(
            await page.evaluate(`document.querySelector('.composer textarea')?.value`),
            "KEEP_CANCELLED_DRAFT",
        );
        assert.ok(JSON.stringify(activeMessages()).includes("THIRD_BROWSER_MARKER"));
        assert.equal(options.modelCalls(), beforeFork);
        const cancelledReceipt = kernel.executions.journal.latest(String(options.id))!;
        const cancelledReadback = await kernel.lookup(
            options.id,
            options.user,
            cancelledReceipt.requestId.slice(options.user.id.length + 1),
            "submit",
        );

        assert.equal(
            (cancelledReadback.nativeResult as { navigation: { cancelled: boolean } }).navigation
                .cancelled,
            true,
        );
        await execute("/fixture-allow-tree");
        await execute("/tree");
        await until(
            async () =>
                (await page.evaluate(
                    `Boolean(document.querySelector(${JSON.stringify(selectedButton)}))`,
                )) === "true",
            "summary navigation selector",
            20_000,
        );
        await page.evaluate(`document.querySelector('.sheet input[type="checkbox"]').click()`);
        await page.evaluate(`
            const input = document.querySelector('.native-tree-search input');
            input.value = 'no-entry-has-this-search-text';
            input.dispatchEvent(new Event('input', {bubbles: true}));
        `);
        assert.ok((await text(".native-tree-empty")).includes("No entries found"));
        await page.evaluate(`
            document.querySelector('.native-tree-search input').dispatchEvent(
                new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})
            );
        `);
        assert.equal(
            await page.evaluate(`document.querySelector('.native-tree-search input')?.value`),
            "",
        );
        assert.equal(
            await page.evaluate(`Boolean(document.querySelector('.native-tree-row.on'))`),
            "true",
        );
        // Keyboard as in the terminal: type to search, arrows to the entry, Enter to go there.
        await page.evaluate(
            `const input = document.querySelector('.native-tree-search input'); input.value = 'SECOND_BROWSER_MARKER'; input.dispatchEvent(new Event('input', {bubbles: true}));`,
        );
        const highlighted = () =>
            page.evaluate(`document.querySelector('.native-tree-row.on')?.dataset.entryId`);
        const rows = Number(
            await page.evaluate(`document.querySelectorAll('.native-tree-row').length`),
        );

        assert.ok(rows > 0 && rows < 10, "search narrows the tree");

        for (let step = 0; step < rows && (await highlighted()) !== selected.id; step++) {
            await page.evaluate(
                `document.querySelector('.native-tree-search input').dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowUp', bubbles: true}))`,
            );
        }

        assert.equal(await highlighted(), selected.id, "arrow keys move the highlight");
        await page.evaluate(
            `document.querySelector('.native-tree-search input').dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}))`,
        );
        await until(
            async () =>
                (await page.evaluate(`document.querySelector('.composer textarea')?.value`)) ===
                "SECOND_BROWSER_MARKER",
            "tree restores canonical native draft text",
            20_000,
        );
        assert.equal(
            options.modelCalls(),
            beforeFork + 1,
            "summary inference is explicitly authorized, not a replayed draft",
        );
        const branch = JSON.stringify(activeMessages());

        assert.ok(branch.includes("FIRST_BROWSER_MARKER"));
        assert.ok(!branch.includes("THIRD_BROWSER_MARKER"));
        const summary = kernel.executions.journal
            .segmentEntries(segment.segmentId)
            .findLast((entry) => entry.type === "branch_summary");

        assert.ok(summary?.summary);
        const usage = kernel.executions.journal.usage(String(options.id)).at(-1)!;

        assert.equal(usage.memberId, options.user.id);
        assert.ok(usage.raw, "native branch summary usage is recorded, not dropped");
        await until(
            async () => (await text(".native-audit-notice")).includes("abandoned branches"),
            "branch audit notice reaches the browser",
            20_000,
        );
        assert.ok(
            (await text(".transcript")).includes("THIRD_BROWSER_MARKER"),
            "immutable audit history is not erased by navigation",
        );
        await screenshot("native-command-tree-summary-draft");
        await execute("/fixture-custom-message");
        const custom = kernel.executions.journal
            .segmentEntries(segment.segmentId)
            .findLast(
                (entry) => entry.type === "custom_message" && entry.customType === "fixture-text",
            )!;
        const customResult = JSON.parse(
            await page.evaluate(
                `JSON.stringify(await (await import('/store.js')).actions.submit(${JSON.stringify(`/tree ${custom.id}`)}, [], 'steer', false, true))`,
            ),
        );

        assert.equal(customResult.nativeResult.navigation.editorText, "CUSTOM_DRAFT");
        assert.equal(
            customResult.nativeResult.navigation.summaryEntry,
            undefined,
            "an old native summary is not this operation's result",
        );
        await page.evaluate(
            `(await import('/sheets/native-command.js')).showNativeResult(${JSON.stringify(customResult)})`,
        );
        await until(
            async () =>
                (await page.evaluate(`document.querySelector('.composer textarea')?.value`)) ===
                "CUSTOM_DRAFT",
            "custom-message canonical draft",
            20_000,
        );
        assert.equal(options.modelCalls(), beforeFork + 1);

        return {
            keyedStatusWidgetReplaceClear: true,
            earlierUserForkDraft: true,
            nativeTreeSummaryDraft: true,
            cancelledTreePreservesDraft: true,
            immutableAuditVsActiveBranch: true,
            firstSessionDiscoveryWithoutInference: true,
            initialDiscoveryWithoutExtraClick: true,
            genericNativeCommandNames: true,
            templateAndSkillSelectionWithoutInference: true,
            builtinExclusions: true,
            modelPickerHandoff: true,
            nativeName: true,
            persistedSettings: true,
            scopedModelCycle: true,
            goalWaitingAndPlainWake: true,
            screenshots,
        };
    } catch (error) {
        await screenshot("native-command-failure");
        writeFileSync(join(options.root, "browser-failure.txt"), await text("body"));

        throw error;
    } finally {
        await browsers.closeAll({ final: true });
    }
}
