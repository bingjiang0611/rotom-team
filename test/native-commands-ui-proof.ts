/** Actual native-command browser interactions against the isolated HTTP proof fixture. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { nativeSessionManager } from "../src/server/rotom-kernel.ts";
import type { PocketApp } from "../src/server/app.ts";
import type { User } from "../src/server/config.ts";
import type { ConversationId } from "@earendil-works/pi-durable";
import { until } from "./helpers.ts";

export async function nativeFailureBannerProof(root: string, base: string, id: ConversationId) {
    assert.ok(findBrowser(), "Chromium is required for this opt-in proof");
    const browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "failure-browser-")),
        load: async () => undefined,
        save: () => {},
    });
    const page = await browsers.open(1);

    try {
        // The fixture bootstrap selects the failed session and signs in a synthetic member.
        for (let i = 0; i < 2; i++) {
            await page.navigate(i === 0 ? `${base}/native-command-bootstrap` : `${base}/s/${id}`);
            await until(
                async () => {
                    const text = await page.evaluate(
                        "document.querySelector('.native-banner')?.textContent ?? ''",
                    );

                    return (
                        text.includes("finalization") &&
                        text.includes("exceeded the size limit") &&
                        text.includes("will not be continued automatically")
                    );
                },
                "durable native failure reason survives page reload",
                20000,
            );
        }

        const image = await page.screenshot();
        const path = join(root, "native-finalization-failure.jpg");

        writeFileSync(path, Buffer.from(image.data, "base64"), { mode: 0o600 });

        return { finalizationReasonAfterReload: true, screenshot: path };
    } finally {
        await browsers.closeAll();
    }
}

export async function nativeCommandUiProof(options: {
    root: string;
    base: string;
    modelCalls: () => number;
    lastImageCount: () => number;
    hold: () => void;
    release: () => void;
    lastThinking: () => string | undefined;
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

    const pasteImages = async () => {
        await page.evaluate(`
            const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
            const clipboardData = new DataTransfer();
            for (let i = 0; i < 4; i++) {
                clipboardData.items.add(new File([bytes], 'command-image-' + i + '.png', {type: 'image/png'}));
            }
            document.querySelector('.composer textarea').dispatchEvent(new ClipboardEvent('paste', {clipboardData, bubbles: true, cancelable: true}));
        `);
        await until(
            async () =>
                (await page.evaluate(
                    `document.querySelectorAll('.composer .files .chip').length === 4 && !${send}.disabled`,
                )) === "true",
            "four command images uploaded and ready",
            20_000,
        );
    };

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

        if (command.startsWith("FIXTURE_")) {
            await until(
                () => !options.app.kernel!.isRunning(options.id),
                "input fixture lease closes",
                20_000,
            );
        }
    };

    const screenshot = async (name: string) => {
        await page.evaluate(
            `await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().endTime !== Infinity).map(animation => animation.finished.catch(() => {})))`,
        );
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
        await page.evaluate(`
            const { actions } = await import('/store.js');
            const submit = actions.submit;
            globalThis.commandTrace = [];
            actions.submit = async (...args) => {
                try {
                    const result = await submit(...args);
                    globalThis.commandTrace.push({text: args[0], result});
                    return result;
                } catch (error) {
                    globalThis.commandTrace.push({text: args[0], error: String(error)});
                    throw error;
                }
            };
        `);
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
        await type("/llama");
        await until(
            async () => (await text('.command-hint[role="status"]')).includes("local terminal"),
            "terminal-only command explanation",
            20_000,
        );
        assert.equal(
            await page.evaluate("document.querySelector('.commands .command').disabled"),
            "true",
        );
        await page.evaluate(`${send}.click()`);
        assert.equal(options.modelCalls(), before);
        assert.equal(
            await page.evaluate(
                "globalThis.commandTrace.filter(each=>each.text.startsWith('/llama')).length",
            ),
            "0",
        );
        assert.equal(
            await page.evaluate("document.querySelector('.composer textarea').value"),
            "/llama",
            "unavailable command retains draft",
        );
        await type("/subagents-stop");
        await until(
            async () => (await text(".commands")).includes("<run-id>"),
            "run-control argument guidance",
            20_000,
        );
        await type("");

        // This is a synthetic public-projection rendering fixture, not a claim that a model wrote these files.
        // File opening still goes through the real authorized HTTP view/download endpoints.
        const outputsDir = join(options.app.cwdOf(options.id), "ux-outputs");

        mkdirSync(outputsDir, { recursive: true });
        writeFileSync(
            join(outputsDir, "hello.html"),
            "<!doctype html><h1>Outputs preview fixture</h1><button>Count</button>",
        );
        writeFileSync(
            join(outputsDir, "证据 空格.md"),
            "# Outputs evidence\nSynthetic fixture, no inference.\n",
        );
        await page.evaluate(`
            const {store} = await import('/store.js');
            store.set({notices:[]});
            globalThis.outputOriginalProjection = {entries:store.state.view.entries,order:store.state.view.order};
            const extra = [{
                id: 999001, kind: 'assistant', blocks: [
                    {type:'toolCall', id:'output-html', name:'Write', args:{file_path:'ux-outputs/hello.html'}},
                    {type:'toolCall', id:'output-md', name:'write', args:{path:'ux-outputs/证据 空格.md'}},
                    {type:'toolCall', id:'output-failed', name:'write', args:{path:'ux-outputs/failed.md'}}
                ]
            },
            {id:999002,kind:'toolResult',callId:'output-html',name:'Write',text:'written',isError:false},
            {id:999003,kind:'toolResult',callId:'output-md',name:'write',text:'written',isError:false},
            {id:999004,kind:'toolResult',callId:'output-failed',name:'write',text:'failed',isError:true}];
            const entries = new Map(store.state.view.entries);
            for (const entry of extra) entries.set(entry.id,entry);
            store.set({view:{...store.state.view,entries,order:[...store.state.view.order,...extra.map(entry=>entry.id)]}});
        `);
        await page.evaluate("document.querySelector('[aria-label=Outputs]').click()");
        await until(
            async () => (await text(".sheet")).includes("证据 空格.md"),
            "generated file history in Outputs",
            20_000,
        );
        assert.match(await text(".sheet"), /same folder|share.*folder/);
        assert.ok(!(await text(".sheet")).includes("failed.md"));
        assert.equal(await page.evaluate("document.querySelectorAll('.output-file').length"), "2");
        await screenshot("outputs-desktop");
        await page.evaluate(
            "const theme = await import('/theme.js'); globalThis.outputOriginalTheme = theme.prefs().theme; theme.setPrefs({theme:'catppuccin-latte'})",
        );
        await screenshot("outputs-light");
        await page.evaluate(
            "(await import('/theme.js')).setPrefs({theme:globalThis.outputOriginalTheme}); delete globalThis.outputOriginalTheme",
        );
        await page.setViewport(VIEWPORTS.mobile);
        assert.equal(
            await page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
            "true",
        );
        await screenshot("outputs-mobile");
        await page.setViewport(VIEWPORTS.desktop);
        await page.evaluate("document.querySelectorAll('.output-file')[1].click()");
        await until(
            async () =>
                (await text(".sheet")).includes("hello.html") &&
                (await text(".sheet")).includes("Preview"),
            "Output opens existing file viewer",
            20_000,
        );
        assert.match(await text(".sheet"), /Preview/);
        await screenshot("outputs-file-viewer");
        await page.evaluate(`
            const {store,closeSheet} = await import('/store.js');
            closeSheet();
            store.set({view:{...store.state.view,...globalThis.outputOriginalProjection}});
            delete globalThis.outputOriginalProjection;
        `);
        assert.equal(options.modelCalls(), before);
        await type("/cont");
        await until(
            async () => (await text(".commands")).includes("/context"),
            "context is discovered in the native command menu",
            20_000,
        );
        await execute("/context");
        await until(
            async () => (await text(".sheet")).includes("Context usage"),
            "native context usage opens in a Web sheet",
            20_000,
        );
        assert.ok((await text(".native-context")).includes("System Prompt"));
        assert.ok(!(await text(".native-context")).includes("TUI mode only"));
        assert.equal(
            await page.evaluate("document.querySelectorAll('.native-context-cell').length"),
            "256",
            "usage renders the native 16 by 16 context map",
        );
        assert.ok((await text(".native-context-legend")).includes("Window %"));
        assert.ok((await text(".native-context-legend")).includes("Auto-Compact Buffer"));
        assert.ok((await text(".native-context-legend")).includes("Free Space"));
        assert.equal(options.modelCalls(), before, "context before first prompt runs no probe");
        await screenshot("native-context-usage");
        await page.evaluate("document.querySelector('.native-context details > summary').click()");
        assert.equal(
            await page.evaluate("document.querySelector('.native-context details').open"),
            "true",
            "native context category can expand its measured breakdown",
        );
        await page.evaluate("document.querySelector('.native-context details > summary').click()");
        assert.equal(
            await page.evaluate("document.querySelector('.native-context details').open"),
            "false",
            "native context category can collapse without another request",
        );
        await page.setViewport(VIEWPORTS.mobile);
        assert.equal(
            await page.evaluate(
                "document.documentElement.scrollWidth <= innerWidth && document.querySelector('.sheet').scrollWidth <= document.querySelector('.sheet').clientWidth",
            ),
            "true",
            "context sheet fits mobile width",
        );
        await screenshot("native-context-mobile");
        await page.setViewport(VIEWPORTS.desktop);
        await page.evaluate("(await import('/store.js')).closeSheet()");
        await execute("/context injections");
        await until(
            async () => (await text(".sheet")).includes("Context injections"),
            "native injection sources open in a Web sheet",
            20_000,
        );
        assert.ok((await text(".native-context")).includes("sources"));
        assert.equal(options.modelCalls(), before, "injections performs no inference");
        await screenshot("native-context-injections");
        await page.evaluate("(await import('/store.js')).closeSheet()");

        // Content pressure from the terminal reference. This renders the production component,
        // not a separate mock page; no provider request or persisted context is changed.
        const categories = [
            { id: "system-prompt", label: "System Prompt", tokens: 4500 },
            { id: "context-files", label: "Instruction Files", tokens: 1400 },
            { id: "skills", label: "Skills", tokens: 503 },
            { id: "built-in-tools", label: "Built-in Tools", tokens: 420 },
            { id: "custom-tools", label: "Custom Tools", tokens: 5700 },
            { id: "user-messages", label: "User Messages", tokens: 69 },
            { id: "assistant-messages", label: "Assistant Messages", tokens: 1100 },
            { id: "assistant-thinking", label: "Assistant Thinking", tokens: 24900 },
            { id: "tool-calls", label: "Tool Calls", tokens: 42100 },
            {
                id: "tool-output",
                label: "Tool Output",
                tokens: 178600,
                children: [
                    { id: "read", label: "read", tokens: 85500 },
                    { id: "bash", label: "bash", tokens: 58100 },
                    { id: "codemode", label: "codemode", tokens: 28700 },
                    { id: "edit", label: "edit", tokens: 6000 },
                    { id: "write", label: "write", tokens: 273 },
                    { id: "obs_recall", label: "obs_recall", tokens: 27 },
                ],
            },
        ];
        const context = {
            type: "native-context",
            title: "Context usage",
            view: "usage",
            captured: true,
            model: "context-ui-fixture",
            reported: { contextWindow: 272000, tokens: 259292 },
            estimatedTokens: categories.reduce((sum, row) => sum + row.tokens, 0),
            autoCompactReserveTokens: 16384,
            categories,
        };

        const showContext = async (value: unknown) => {
            await until(
                async () =>
                    (await page.evaluate("Boolean(document.querySelector('.sheet'))")) === "false",
                "previous sheet closes before replacing the context snapshot",
            );
            await page.evaluate(
                `(await import('/store.js')).openSheet({type: 'native-info', result: {context: ${JSON.stringify(value)}}})`,
            );
            await until(
                async () => (await text(".native-context-model")) === "context-ui-fixture",
                "fixture context opens",
            );
        };

        await showContext(context);
        assert.equal(
            await page.evaluate("document.querySelector('.native-context-category').open"),
            "true",
            "Tool Output breakdown is visible by default like the terminal",
        );
        assert.ok((await text(".native-context-legend")).includes("85.5k"));
        assert.ok((await text(".native-context-legend")).includes("66%"));
        assert.equal(
            await page.evaluate(
                "new Set(Array.from(document.querySelectorAll('.native-context-cell.full')).map(cell => getComputedStyle(cell).backgroundColor)).size > 3",
            ),
            "true",
            "category map has distinct theme colors, not accent-opacity stripes",
        );
        assert.equal(
            await page.evaluate(
                "document.querySelector('.native-context-map').getBoundingClientRect().right < document.querySelector('.native-context-legend').getBoundingClientRect().left",
            ),
            "true",
            "desktop map and legend sit side by side",
        );
        await screenshot("native-context-terminal-parity");
        await page.evaluate("document.querySelector('.native-context-category > summary').focus()");
        await page.input([{ type: "key", key: "Enter" }]);
        assert.equal(
            await page.evaluate("document.querySelector('.native-context-category').open"),
            "false",
            "keyboard Enter collapses the tool breakdown",
        );
        await page.input([{ type: "key", key: " " }]);
        assert.equal(
            await page.evaluate("document.querySelector('.native-context-category').open"),
            "true",
            "keyboard Space expands the tool breakdown",
        );
        await page.setViewport(VIEWPORTS.mobile);
        assert.equal(
            await page.evaluate(
                "document.documentElement.scrollWidth <= innerWidth && document.querySelector('.sheet').scrollWidth <= document.querySelector('.sheet').clientWidth && document.querySelector('.native-context-legend').scrollWidth <= document.querySelector('.native-context-legend').clientWidth",
            ),
            "true",
            "full terminal breakdown and numeric columns fit mobile",
        );
        assert.equal(
            await page.evaluate(
                "document.querySelector('.native-context-map-panel').getBoundingClientRect().bottom <= document.querySelector('.native-context-legend').getBoundingClientRect().top",
            ),
            "true",
            "mobile map sits above the legend",
        );
        await screenshot("native-context-terminal-mobile");
        await page.setViewport({ width: 320, height: 740, scale: 1, mobile: true });
        assert.equal(
            await page.evaluate(
                "document.querySelector('.sheet').scrollWidth <= document.querySelector('.sheet').clientWidth",
            ),
            "true",
            "context also fits a 320px narrow phone",
        );
        await page.setViewport(VIEWPORTS.desktop);
        await page.evaluate(
            "const theme = await import('/theme.js'); globalThis.contextOriginalTheme = theme.prefs().theme; theme.setPrefs({theme: 'catppuccin-latte'})",
        );
        assert.equal(await page.evaluate("document.documentElement.dataset.mode"), "light");
        await screenshot("native-context-terminal-light");
        await page.evaluate(
            "(await import('/theme.js')).setPrefs({theme: globalThis.contextOriginalTheme})",
        );
        await page.evaluate("(await import('/store.js')).closeSheet()");
        await showContext({ ...context, reported: undefined });
        assert.equal(
            await page.evaluate("document.querySelectorAll('.native-context-cell').length"),
            "0",
        );
        assert.ok((await text(".native-context")).includes("Context window unknown"));
        assert.ok((await text(".native-context-legend")).includes("unknown"));
        assert.equal(
            await page.evaluate(
                "document.querySelector('.native-context-map-panel').getBoundingClientRect().bottom <= document.querySelector('.native-context-legend').getBoundingClientRect().top",
            ),
            "true",
            "unknown context window removes the empty map column",
        );
        await screenshot("native-context-unknown-window");
        await page.evaluate("(await import('/store.js')).closeSheet()");
        await showContext({
            ...context,
            estimatedTokens: 0,
            categories: [],
            autoCompactReserveTokens: 0,
        });
        assert.equal(
            await page.evaluate("document.querySelectorAll('.native-context-cell.free').length"),
            "256",
            "known empty window shows real free space",
        );
        assert.ok((await text(".native-context-legend")).includes("272k"));
        assert.equal(options.modelCalls(), before, "context UI interactions run no inference");
        await page.evaluate("(await import('/store.js')).closeSheet()");

        for (const key of ["Tab", "Enter"]) {
            await type("/sett");
            await until(
                async () => (await text(".commands")).includes("/settings"),
                "settings suggestion",
            );
            await page.evaluate(
                `document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', {key: ${JSON.stringify(key)}, bubbles: true, cancelable: true}))`,
            );
            assert.equal(
                await page.evaluate("document.querySelector('.composer textarea').value"),
                "/settings",
            );
            assert.equal(
                await page.evaluate("Boolean((await import('/store.js')).store.state.sheet)"),
                "false",
                "completion must not execute",
            );
        }

        await type("");

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

        await until(
            async () => (await text(".session-row.active")).includes("model-a"),
            "sidebar model-a arrives through session subscription",
            20_000,
        );
        await execute("/thinking");
        await until(
            async () => (await text(".sheet")).includes("Thinking Level"),
            "dedicated thinking picker",
        );
        await page.evaluate(`
            const search = document.querySelector('.native-selector input');
            search.value = 'high';
            search.dispatchEvent(new Event('input', {bubbles: true}));
        `);
        await page.evaluate(
            "document.querySelector('.native-selector input').dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}))",
        );
        await until(
            async () =>
                (await page.evaluate(
                    "(await import('/store.js')).store.state.view.kernel.thinkingLevel",
                )) === "high",
            "thinking keyboard selection persists",
            20_000,
        );
        await execute("/settings");
        await until(
            async () => (await text(".sheet")).includes("Auto-resize images"),
            "real native settings sheet",
            20_000,
        );
        await page.evaluate(
            `document.querySelector('.native-selector-row[data-value="imageAutoResize"]').click()`,
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
        await page.evaluate(
            `document.querySelector('.native-selector-row[data-value="scope"]').click()`,
        );
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
        await until(
            async () => (await text(".session-row.active")).includes("model-b"),
            "sidebar model-b arrives without reloading the page",
            20_000,
        );
        await page.evaluate(`(await import('/store.js')).closeSheet()`);
        await execute("/reload");
        assert.equal(options.modelCalls(), before, "selection and settings do not infer");

        await execute("/qoder-credits");
        await until(
            async () => (await text(".sheet")).includes("Account snapshot"),
            "private readable Qoder credits",
        );
        assert.ok((await text(".native-command-output")).includes("7 / 10 credits"));
        assert.ok((await text(".native-command-output")).includes("addon: not reported"));
        assert.ok(
            (await text(".native-command-output")).includes("shared: remaining ? / ? unknown"),
        );
        await screenshot("native-command-credits");
        await page.evaluate("(await import('/store.js')).closeSheet()");
        await execute("/computer-use");

        // The real native browser handler asks for input. Empty Enter cancels without touching Chrome or a model.
        await type("/browser");
        await page.evaluate(`${send}.click()`);
        await until(
            async () =>
                (await page.evaluate(
                    "Boolean(document.querySelector('.native-question input'))",
                )) === "true",
            "native browser input dialog",
            20_000,
        );
        await screenshot("native-command-browser-input");
        await page.evaluate("document.querySelector('.native-question input').focus()");
        await page.press("Enter");
        await until(
            async () =>
                (await page.evaluate("document.querySelector('.composer textarea')?.value")) === "",
            "empty browser input completes",
            20_000,
        );
        assert.equal(options.modelCalls(), before);

        const kernel = options.app.kernel!;

        await until(() => !kernel.isRunning(options.id), "thinking handoff completes", 20_000);
        await type("/fixture-prompt");
        await until(
            async () => (await text(".commands")).includes("/fixture-prompt"),
            "template is recognized before sending its images",
            30_000,
        );
        const beforeTemplate = options.modelCalls();

        await pasteImages();
        await execute("/fixture-prompt TEMPLATE_IMAGE_DRAFT");
        await until(
            () => options.modelCalls() > beforeTemplate && !kernel.isRunning(options.id),
            "template with images completes",
            20_000,
        );
        assert.equal(options.lastImageCount(), 4, "the template sends actual images to inference");
        assert.equal(
            await page.evaluate("document.querySelectorAll('.composer .files .chip').length"),
            "0",
        );
        const beforeSkill = options.modelCalls();

        await type("/");
        await until(
            async () => (await text(".commands")).includes("/skill:pi-subagents"),
            "skill discovered for the new segment",
            30_000,
        );
        await until(() => !kernel.isRunning(options.id), "new segment discovery completes", 20_000);
        await pasteImages();
        options.hold();
        await execute("/skill:pi-subagents LIVE_SKILL_DRAFT");
        await until(
            () => options.modelCalls() > beforeSkill,
            "skill inference remains held",
            20_000,
        );
        assert.equal(kernel.isRunning(options.id), true);
        assert.equal(options.lastImageCount(), 4, "the skill sends actual images to inference");
        assert.equal(
            await page.evaluate("document.querySelectorAll('.composer .files .chip').length"),
            "0",
            "accepted skill images clear before inference finishes",
        );
        await until(
            async () => (await text(".thinking-chip")).includes("high"),
            "visible current thinking",
            20_000,
        );
        await type("NEXT_DRAFT_AFTER_SKILL");
        await page.evaluate("document.querySelector('.thinking-chip').click()");
        await until(
            async () => (await text(".sheet")).includes("Thinking Level"),
            "live thinking picker",
            20_000,
        );
        assert.equal(
            await page.evaluate("document.querySelector('.composer textarea').value"),
            "NEXT_DRAFT_AFTER_SKILL",
        );
        await page.evaluate(
            "document.querySelector('.native-selector-row[data-value=off]').click()",
        );
        await until(
            async () => (await text(".thinking-chip")).includes("off"),
            "thinking off remains visible",
            20_000,
        );
        await page.evaluate("document.querySelector('.thinking-chip').click()");
        await until(
            async () => (await text(".sheet")).includes("Thinking Level"),
            "reopen live thinking picker",
            20_000,
        );
        await page.evaluate(
            "document.querySelector('.native-selector-row[data-value=medium]').click()",
        );
        await until(
            async () => (await text(".thinking-chip")).includes("medium"),
            "live thinking chip updates",
            20_000,
        );
        assert.equal(kernel.isRunning(options.id), true);
        await screenshot("native-live-thinking-desktop");
        await page.setViewport(VIEWPORTS.mobile);
        await screenshot("native-live-thinking-phone");
        assert.equal(
            await page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
            "true",
        );
        assert.equal(
            await page.evaluate(
                "(() => { const chip = document.querySelector('.thinking-chip'); return chip.scrollWidth <= chip.clientWidth; })()",
            ),
            "true",
            "mobile thinking level is not clipped",
        );
        await page.setViewport(VIEWPORTS.desktop);
        await page.evaluate(`${send}.click()`);
        await until(
            async () =>
                (await page.evaluate("document.querySelector('.composer textarea').value")) === "",
            "follow-up draft clears",
            20_000,
        );
        options.release();
        await until(() => !kernel.isRunning(options.id), "skill and follow-up complete", 30_000);
        assert.equal(options.lastThinking(), "medium");

        await type("FIXTURE_STATUS");
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
        await until(
            () => !options.app.kernel!.isRunning(options.id),
            "input fixture closes its native lease",
            20_000,
        );
        const beforeGoal = options.modelCalls();

        await execute("/goal");
        await until(
            async () => (await text(".sheet")).includes("Start a goal"),
            "web Goal manager",
        );
        assert.equal(
            await page.evaluate(
                `document.querySelector('.native-selector-row[data-value="settings"]').getAttribute('aria-disabled')`,
            ),
            "true",
        );
        await screenshot("native-command-goal-manager");
        await page.setViewport(VIEWPORTS.mobile);
        assert.equal(
            await page.evaluate(
                `const sheet = document.querySelector('.sheet'); JSON.stringify(sheet.scrollWidth <= sheet.clientWidth)`,
            ),
            "true",
        );
        await screenshot("native-command-goal-mobile");
        await page.setViewport(VIEWPORTS.desktop);
        await page.evaluate(
            `document.querySelector('.native-selector-row[data-value="start"]').click()`,
        );
        await page.evaluate(
            `const input = document.querySelector('.native-goal-form textarea'); input.value = 'clear'; input.dispatchEvent(new Event('input', {bubbles: true}));`,
        );
        await page.evaluate(`${button("Start goal")}.click()`);
        await until(
            async () => (await text('.sheet [role="alert"]')).includes("native Goal control"),
            "objective cannot become a destructive control command",
        );
        assert.equal(options.modelCalls(), beforeGoal);
        await page.evaluate(
            `const input = document.querySelector('.native-goal-form textarea'); input.value = 'Browser wake proof, then pause for my decision.'; input.dispatchEvent(new Event('input', {bubbles: true}));`,
        );
        await page.evaluate(`${button("Start goal")}.click()`);
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
            "paused Goal lease closes",
            20_000,
        );
        const beforeEdit = options.modelCalls();

        await execute("/goal");
        await page.evaluate(
            `document.querySelector('.native-selector-row[data-value="edit"]').click()`,
        );
        await page.evaluate(
            `const input = document.querySelector('.native-goal-form textarea'); input.value = 'Edited browser Goal objective'; input.dispatchEvent(new Event('input', {bubbles: true}));`,
        );
        await page.evaluate(`${button("Update goal")}.click()`);
        await until(
            async () => (await text(".goal-bar")).includes("Edited browser Goal objective"),
            "native Goal edit snapshot",
            20_000,
        );
        await until(
            () => !options.app.kernel!.isRunning(options.id),
            "edited Goal lease closes",
            20_000,
        );
        await execute("/goal");
        await page.evaluate(
            `document.querySelector('.native-selector-row[data-value="clear"]').click()`,
        );
        await until(
            async () => (await text(".sheet")).includes("Conversation history is retained"),
            "clear requires confirmation",
        );
        await page.evaluate(`${button("Clear goal")}.click()`);
        await until(
            async () =>
                (await page.evaluate("Boolean(document.querySelector('.goal-bar'))")) === "false",
            "native Goal cleared",
            20_000,
        );
        assert.equal(
            options.modelCalls(),
            beforeEdit,
            "editing and clearing a paused Goal never infer",
        );
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
        assert.ok(
            (await text('.native-selector-row[aria-selected="true"]')).includes(
                "THIRD_BROWSER_MARKER",
            ),
            "fork starts on the latest user message, like the terminal",
        );
        await screenshot("native-command-fork-selector");
        await page.evaluate(
            `document.querySelector('.native-selector').dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowUp', bubbles: true, cancelable: true}))`,
        );
        assert.equal(
            await page.evaluate(
                `document.querySelector('.native-selector-row[aria-selected="true"]').dataset.entryId`,
            ),
            selected.id,
        );
        await page.evaluate(
            `document.querySelector('.native-selector').dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}))`,
        );
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
        await execute("FIXTURE_CANCEL_TREE");
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
        await execute("FIXTURE_ALLOW_TREE");
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
        await execute("FIXTURE_CUSTOM_MESSAGE");
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
            outputsSyntheticProjectionAndRealFileOpening: true,
            outputsMobileContainment: true,
            sidebarModelsUpdatedWithoutReload: true,
            terminalOnlyCommandRetainsDraftWithoutInference: true,
            keyedStatusWidgetReplaceClear: true,
            earlierUserForkDraft: true,
            nativeTreeSummaryDraft: true,
            cancelledTreePreservesDraft: true,
            immutableAuditVsActiveBranch: true,
            firstSessionDiscoveryWithoutInference: true,
            initialDiscoveryWithoutExtraClick: true,
            completionWithoutPrematureExecution: true,
            dedicatedThinkingPicker: true,
            skillDraftClearsDuringInference: true,
            templateImagesSentAndCleared: true,
            skillImagesSentAndClearedDuringInference: true,
            liveThinkingAndOffVisible: true,
            thinkingPreservesUnsentDraft: true,
            nextRequestUsesSelectedThinking: true,
            mobileThinkingNotClipped: true,
            privateReadableCredits: true,
            browserInputEnterWithoutSideEffects: true,
            templateAndSkillSelectionWithoutInference: true,
            builtinExclusions: true,
            modelPickerHandoff: true,
            persistedSettings: true,
            scopedModelCycle: true,
            goalManagerStartEditConfirmedClearAndReservedObjective: true,
            goalWaitingAndPlainWake: true,
            contextUsageAndInjections: true,
            contextBeforePromptNoInference: true,
            contextMobileContainment: true,
            contextExpandableBreakdown: true,
            contextTerminalMapAndPercentages: true,
            contextDefaultToolBreakdown: true,
            contextKeyboardBreakdown: true,
            contextUnknownAndEmptyWindows: true,
            contextNarrowPhoneContainment: true,
            screenshots,
        };
    } catch (error) {
        await screenshot("native-command-failure");
        writeFileSync(join(options.root, "browser-failure.txt"), await text("body"));
        writeFileSync(
            join(options.root, "browser-command-trace.json"),
            await page.evaluate("JSON.stringify(globalThis.commandTrace)"),
        );

        throw error;
    } finally {
        await browsers.closeAll({ final: true });
    }
}
