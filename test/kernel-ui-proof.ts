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

        return {
            unifiedTranscript: true,
            streamedThenPersisted: true,
            questionAnswered: true,
            screenshots,
        };
    } finally {
        await browsers.closeAll({ final: true });
    }
}
