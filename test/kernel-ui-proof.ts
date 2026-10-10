/** Opt-in native UI regression using Pocket's existing isolated Chromium test infrastructure; no real accounts. */
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
    memberId: string;
    configurationDigest: string;
    busyId: number;
}) {
    assert.ok(findBrowser(), "Chromium is required; native UI verification cannot be skipped");
    const browsers = new Browsers({
        dataDir: mkdtempSync(join(options.root, "native-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    const page = await browsers.open(1);
    const key = `rotom.kernel.pending.${options.memberId}.${options.id}`;
    const draftKey = `kernel.${options.memberId}.${options.id}`;
    const draft = "Keep this unexecuted draft";
    const button = (label: string) =>
        `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(label)})`;
    const screenshots: string[] = [];

    try {
        await page.navigate(`${options.base}/kernel-proof-bootstrap`);
        await until(
            async () =>
                (await page.evaluate(`Boolean(${button("Configuration & skills")})`)) === "true",
            "native UI ready",
            20000,
        );
        await page.evaluate(
            `localStorage.setItem(${JSON.stringify(key)}, 'fork:fork-gap'); (await import('/store.js')).drafts.set(${JSON.stringify(draftKey)}, ${JSON.stringify(draft)});`,
        );
        await page.navigate(`${options.base}/s/${options.id}`);
        await until(
            async () =>
                (await page.evaluate(
                    `Boolean(${button("Dismiss unexecuted pending request")})`,
                )) === "true",
            "prepared-only UI recovery",
            20000,
        );
        await page.evaluate(`${button("Dismiss unexecuted pending request")}.click()`);
        await until(
            async () =>
                (await page.evaluate(`localStorage.getItem(${JSON.stringify(key)}) === null`)) ===
                "true",
            "explicit pending dismissal",
            20000,
        );
        assert.equal(
            await page.evaluate(
                `(await import('/store.js')).drafts.get(${JSON.stringify(draftKey)})`,
            ),
            draft,
        );
        const lookup = JSON.parse(
            await page.evaluate(
                `return JSON.stringify(await (await fetch('/api/c/${options.id}/kernel-request?operation=fork&requestId=fork-gap')).json())`,
            ),
        );

        assert.equal(lookup.preparedOnly, true);
        assert.equal(lookup.receipt, null);

        for (const width of [390, 320, 1280]) {
            await page.setViewport({ width, height: 844, scale: 1, mobile: width < 600 });
            await page.evaluate(
                "await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return 'ready';",
            );
            const geometry = JSON.parse(
                await page.evaluate(
                    `return JSON.stringify({ width:innerWidth, overflow:document.documentElement.scrollWidth-innerWidth, controls:Array.from(document.querySelectorAll('[aria-label="Native session actions"] button')).map(button => { const r=button.getBoundingClientRect(); return {label:button.textContent.trim(),left:r.left,right:r.right,width:r.width}; }) })`,
                ),
            );

            assert.equal(geometry.width, width);
            assert.ok(geometry.overflow <= 1, JSON.stringify(geometry));
            assert.equal(geometry.controls.length, 5);

            for (const control of geometry.controls) {
                assert.ok(
                    control.left >= 0 && control.right <= width + 1 && control.width > 0,
                    JSON.stringify(control),
                );
            }

            const image = await page.screenshot();
            const path = join(options.root, `native-ui-${width}.jpg`);

            writeFileSync(path, Buffer.from(image.data, "base64"), { mode: 0o600, flag: "wx" });
            screenshots.push(path);
        }

        await page.evaluate(`${button("Configuration & skills")}.click()`);
        await until(
            async () =>
                (await page.evaluate(
                    `document.body.innerText.includes(${JSON.stringify(options.configurationDigest.slice(0, 12))})`,
                )) === "true",
            "active native snapshot in profile sheet",
            20000,
        );
        assert.equal(
            await page.evaluate(`Boolean(${button("Save & activate in this session")})`),
            "false",
        );
        assert.equal(
            await page.evaluate(`document.body.innerText.includes('Activate saved profile')`),
            "true",
        );

        await page.evaluate(
            `const input=Array.from(document.querySelectorAll('label')).find(label=>label.textContent.trim().startsWith('Profile name')).querySelector('input'); input.value='UI private draft'; input.dispatchEvent(new Event('input',{bubbles:true}));`,
        );
        await page.evaluate(`${button("Save my profile")}.click()`);
        await until(
            async () =>
                (await page.evaluate(
                    "document.body.innerText.includes('Personal profile saved. Existing sessions are unchanged.')",
                )) === "true",
            "personal draft saved without activation",
            20000,
        );
        const savedProfile = JSON.parse(
            await page.evaluate(
                "return JSON.stringify(await (await fetch('/api/profile')).json())",
            ),
        );

        assert.equal(savedProfile.name, "UI private draft");
        const stillActive = JSON.parse(
            await page.evaluate(
                `return JSON.stringify(await (await fetch('/api/c/${options.id}/configuration')).json())`,
            ),
        );

        assert.equal(stillActive.digest, options.configurationDigest);

        // Server busy/refusal is exercised by the HTTP proof; isolate its UI contract here.
        await page.navigate(`${options.base}/s/${options.busyId}`);
        await until(
            async () =>
                (await page.evaluate(
                    `Boolean(document.querySelector('textarea') && !document.querySelector('textarea').disabled)`,
                )) === "true",
            "own native session ready",
            20000,
        );
        const busyKey = `rotom.kernel.pending.${options.memberId}.${options.busyId}`;
        const busyDraftKey = `kernel.${options.memberId}.${options.busyId}`;

        await page.evaluate(`
            const original = window.fetch;
            window.busyDispatch = null;
            window.fetch = async (url, options) => {
                if (url === '/api/c/${options.busyId}/submit' && options?.method === 'POST') {
                    window.fetch = original;
                    window.busyDispatch = localStorage.getItem(${JSON.stringify(busyKey)});
                    return new Response(JSON.stringify({error:'Fixture known busy refusal'}), {status:409, headers:{'content-type':'application/json'}});
                }
                return original(url, options);
            };
            const input=document.querySelector('textarea');
            input.value='Keep the busy draft';
            input.dispatchEvent(new Event('input',{bubbles:true}));
        `);
        await page.evaluate(`${button("Send")}.click()`);
        await until(
            async () =>
                (await page.evaluate(
                    `Boolean(window.busyDispatch && localStorage.getItem(${JSON.stringify(busyKey)}) === null)`,
                )) === "true",
            "known refusal clears only pending identity",
            20000,
        );
        const busyIdentity = await page.evaluate("window.busyDispatch");

        assert.match(busyIdentity, /^submit:/);
        const absent = JSON.parse(
            await page.evaluate(
                `return JSON.stringify(await (await fetch('/api/c/${options.busyId}/kernel-request?operation=submit&requestId='+encodeURIComponent(${JSON.stringify(busyIdentity.slice(7))}))).json())`,
            ),
        );

        assert.equal(absent.receipt, null);
        await page.navigate(`${options.base}/s/${options.busyId}`);
        await until(
            async () =>
                (await page.evaluate(`Boolean(${button("Configuration & skills")})`)) === "true",
            "reload after refusal",
            20000,
        );
        assert.equal(
            await page.evaluate(`localStorage.getItem(${JSON.stringify(busyKey)}) === null`),
            "true",
        );
        assert.equal(
            await page.evaluate(
                `(await import('/store.js')).drafts.get(${JSON.stringify(busyDraftKey)})`,
            ),
            "Keep the busy draft",
        );

        return {
            knownBusyRefusalClearsPendingWithoutReplay: true,
            nativeProfileDraftSavedWithoutActivation: true,
            preparedOnlyDismissedWithoutReplay: true,
            draftRetained: true,
            nativeProfileSheet: true,
            viewportWidths: [390, 320, 1280],
            screenshots,
        };
    } finally {
        await browsers.closeAll({ final: true });
    }
}
