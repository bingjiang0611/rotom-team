/**
 * Opt-in UI regression for rotom sessions in Pocket's one Transcript UI, on an isolated Chromium; no real accounts.
 * It sends one message through the composer and watches the answer stream, then persist, in the same transcript.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { until } from "./helpers.ts";

export async function nativeUiProof(options: {
    root: string;
    base: string;
    id: number;
    memberName: string;
}) {
    assert.ok(findBrowser(), "Chromium is required; native UI verification cannot be skipped");
    const browsers = new Browsers({
        dataDir: mkdtempSync(join(options.root, "native-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    const page = await browsers.open(1);
    const text = (selector: string) =>
        page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`);
    const button = (label: string) =>
        `Array.from(document.querySelectorAll('button')).find(b => (b.querySelector(':scope > span')?.textContent ?? b.textContent).trim() === ${JSON.stringify(label)})`;
    const send = `document.querySelector('.composer [aria-label="Send"]')`;
    const screenshots: string[] = [];

    try {
        await page.navigate(`${options.base}/kernel-proof-bootstrap`);
        await until(
            async () => (await text(".transcript")).includes("Write the proof file."),
            "persisted native history in the Transcript",
            20000,
        );
        // Whoever's account ran it last is named; the owner's message below takes it over to their own.
        assert.match(await text(".topbar .title-sub"), /^rotom · .+'s account · /);
        // One UI: the separate kernel view is gone, and Pocket's own browser panel is not offered.
        assert.equal(await page.evaluate(`Boolean(document.querySelector('.kernel'))`), "false");
        assert.equal(
            await page.evaluate(
                `Boolean(document.querySelector('.topbar [aria-label="Browser"]'))`,
            ),
            "false",
        );

        await page.evaluate(`
            const input = document.querySelector('.composer textarea');
            input.value = 'STREAM_SLOWLY from the composer';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        `);
        await until(
            async () => (await page.evaluate(`Boolean(${send} && !${send}.disabled)`)) === "true",
            "composer ready",
            20000,
        );
        await page.evaluate(`${send}.click()`);
        await until(
            async () => {
                const shown = await text(".transcript");

                return shown.includes("PARTIAL_NATIVE") && !shown.includes("STREAM_DONE");
            },
            "the streaming answer shows live",
            20000,
        );
        const image = await page.screenshot();
        const path = join(options.root, "native-ui-streaming.jpg");

        writeFileSync(path, Buffer.from(image.data, "base64"), { mode: 0o600, flag: "wx" });
        screenshots.push(path);
        await until(
            async () => (await text(".transcript")).includes("STREAM_DONE"),
            "the finished answer persists in place",
            20000,
        );
        assert.ok((await text(".transcript")).includes("STREAM_SLOWLY from the composer"));
        await until(
            async () =>
                (await text(".topbar .title-sub")).startsWith(
                    `rotom · ${options.memberName}'s account`,
                ),
            "the sender pays and is named",
            20000,
        );

        // A question from the run (ask_user_question) is answered in place, by the member who pays for it.
        await page.evaluate(`
            const input = document.querySelector('.composer textarea');
            input.value = 'ASK_THE_USER from the composer';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        `);
        await until(
            async () => (await page.evaluate(`Boolean(${send} && !${send}.disabled)`)) === "true",
            "composer ready again",
            20000,
        );
        await page.evaluate(`${send}.click()`);
        const green = `Array.from(document.querySelectorAll('.native-question button')).find(b => b.textContent.includes('Green'))`;

        await until(
            async () => (await page.evaluate(`Boolean(${green})`)) === "true",
            "the question shows above the composer",
            20000,
        );
        const asked = await page.screenshot();
        const askedPath = join(options.root, "native-ui-question.jpg");

        writeFileSync(askedPath, Buffer.from(asked.data, "base64"), { mode: 0o600, flag: "wx" });
        screenshots.push(askedPath);
        await page.evaluate(`${green}.click()`);
        await until(
            async () => (await text(".transcript")).includes("ANSWER_WAS"),
            "the run continues with the answer",
            20000,
        );
        assert.equal(
            await page.evaluate(`Boolean(document.querySelector('.native-question'))`),
            "false",
        );

        // Typing a command offers the project's skills: the kernel runs `/skill:name` for the model.
        const typeInto = (value: string) =>
            page.evaluate(`
                const input = document.querySelector('.composer textarea');
                input.value = ${JSON.stringify(value)};
                input.dispatchEvent(new Event('input', { bubbles: true }));
            `);

        await typeInto("/skill:");
        await until(
            async () => (await text(".composer-wrap .commands")).includes("/skill:project-proof"),
            "the message box offers the project's skills",
            20000,
        );
        const skills = await page.screenshot();
        const skillsPath = join(options.root, "native-ui-skills.jpg");

        writeFileSync(skillsPath, Buffer.from(skills.data, "base64"), { mode: 0o600, flag: "wx" });
        screenshots.push(skillsPath);
        await typeInto("");

        // A reply's sheet offers no fork or send again from that message: the kernel has none, and the server refuses it.
        await page.evaluate(`
            const { openSheet, store } = await import("/store.js");
            const { view } = store.state;
            const reply = view.order.map((id) => view.entries.get(id)).findLast((each) => each?.kind === "assistant");
            openSheet({ type: "message", entryId: reply.id });
        `);
        await until(
            async () => (await page.evaluate(`Boolean(${button("Copy text")})`)) === "true",
            "a reply's sheet",
            20000,
        );
        assert.doesNotMatch(await text(".sheet"), /Fork from here|Send again|Edit and send again/);
        await page.evaluate(`(await import("/store.js")).closeSheet()`);
        // Pi Pocket's extensions run in Durable sessions only: a rotom server shows no Extensions page or guard state.
        await page.evaluate(`(await import("/sheets/settings.js")).openSettings()`);
        await until(
            async () => (await text(".settings-nav")).includes("Running now"),
            "the settings window",
            20000,
        );
        assert.doesNotMatch(await text(".settings-nav"), /Extensions/);
        assert.doesNotMatch(await text(".composer-wrap"), /guard/);
        await page.evaluate(`(await import("/store.js")).closeSheet()`);

        const launcherFinds = async (query: string) => {
            await page.evaluate(`
                (await import("/store.js")).store.set({ launcher: true });
                await new Promise((resolve) => setTimeout(resolve, 100));
                const input = document.querySelector(".launcher-input input");
                input.value = ${JSON.stringify(query)};
                input.dispatchEvent(new Event("input", { bubbles: true }));
                await new Promise((resolve) => setTimeout(resolve, 200));
            `);
            const found = await text(".launcher");

            await page.evaluate(`(await import("/store.js")).store.set({ launcher: false })`);

            return found;
        };

        assert.match(await launcherFinds(">Running"), /Running now/);
        assert.doesNotMatch(await launcherFinds(">Extensions"), /Extensions/);
        await page.evaluate(`document.querySelector('.topbar [aria-label="Menu"]').click()`);
        await until(
            async () => (await page.evaluate(`Boolean(${button("Fork")})`)) === "true",
            "rotom session actions in the menu",
            20000,
        );
        assert.equal(await page.evaluate(`Boolean(${button("New context")})`), "false");
        const menu = await page.screenshot();
        const menuPath = join(options.root, "native-ui-menu.jpg");

        writeFileSync(menuPath, Buffer.from(menu.data, "base64"), { mode: 0o600, flag: "wx" });
        screenshots.push(menuPath);

        // The MCP sheet lists the project's servers as this member's runs reach them. The OAuth one needs the member's
        // own sign-in: the browser (played here by fetch, as on another machine) ends on a callback it cannot reach,
        // and its address is pasted back.
        await page.evaluate(`${button("MCP sign-ins")}.click()`);
        await until(
            async () => /team\s*needs your sign-in/.test(await text(".sheet")),
            "the MCP sheet lists the project's servers",
            60000,
        );
        assert.match(await text(".sheet"), /probe\s*connected · 1 tools/);
        await page.evaluate(`${button("Sign in")}.click()`);
        const link = `document.querySelector('.sheet a[target="_blank"]')`;

        await until(
            async () => (await page.evaluate(`Boolean(${link})`)) === "true",
            "the sign-in page link",
            30000,
        );
        const signing = await page.screenshot();
        const signingPath = join(options.root, "native-ui-mcp-sign-in.jpg");

        writeFileSync(signingPath, Buffer.from(signing.data, "base64"), {
            mode: 0o600,
            flag: "wx",
        });
        screenshots.push(signingPath);
        const landed = (
            await fetch(await page.evaluate(`${link}.href`), { redirect: "manual" })
        ).headers.get("location")!;

        await page.evaluate(`
            const pasted = document.querySelector('.sheet form input');
            pasted.value = ${JSON.stringify(landed)};
            pasted.dispatchEvent(new Event('input', { bubbles: true }));
        `);
        await page.evaluate(`${button("Finish sign-in")}.click()`);
        await until(
            async () => /team\s*connected · 1 tools/.test(await text(".sheet")),
            "signed in with the member's own account",
            60000,
        );
        assert.match(await text(".sheet"), /Signed in to MCP server "team"/);
        const mcp = await page.screenshot();
        const mcpPath = join(options.root, "native-ui-mcp.jpg");

        writeFileSync(mcpPath, Buffer.from(mcp.data, "base64"), { mode: 0o600, flag: "wx" });
        screenshots.push(mcpPath);

        return {
            mcpSignIn: true,
            skillsOffered: true,
            unifiedTranscript: true,
            streamedThenPersisted: true,
            questionAnswered: true,
            screenshots,
        };
    } finally {
        await browsers.closeAll({ final: true });
    }
}
