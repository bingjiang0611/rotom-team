/**
 * The browser side of the benchmarks: headless Chromium, driven over the DevTools protocol, opens a session page of
 * the real web app and waits until the session's last answer is in the page. It reports the time from navigation to
 * then (in the page's own clock), Chromium's layout and style counts for that load, and the server's work counters.
 * Where this machine has no Chromium the scenario is unavailable, never zero.
 */
import { mkdirSync } from "node:fs";
import { Chromium } from "../../src/server/browser/cdp.ts";
import { findBrowser } from "../../src/server/browser/discovery.ts";
import { raw, since, snapshot, type Counts } from "./counters.ts";

type Metrics = Record<string, number>;

export async function measureWebOpen(options: {
    base: string;
    ownerToken: string;
    sessionId: number;
    marker: string;
    quiet: () => Promise<void>;
    profile: string;
}): Promise<{ ms: number; counts: Counts; metrics: Metrics } | { unavailable: string }> {
    const executable = findBrowser();

    if (executable === undefined) {
        return { unavailable: "no Chromium-based browser on this machine" };
    }

    mkdirSync(options.profile, { recursive: true });
    const chromium = await Chromium.launch(executable, options.profile, []);
    const cdp = chromium.connection;

    try {
        const page = async () => {
            const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
            const { sessionId } = await cdp.send("Target.attachToTarget", {
                targetId,
                flatten: true,
            });

            let loaded: () => void = () => {};

            cdp.listen(sessionId, (method) => {
                if (method === "Page.loadEventFired") {
                    loaded();
                }
            });
            await cdp.send("Page.enable", {}, sessionId);

            return {
                sessionId,
                navigate: async (url: string) => {
                    const load = new Promise<void>((resolve) => (loaded = resolve));

                    await cdp.send("Page.navigate", { url }, sessionId);
                    await load;
                },
            };
        };

        // Sign in once (a cookie), then measure a fresh tab, so the measured load is the session page alone.
        const signIn = await page();

        await signIn.navigate(
            `${options.base}/login?token=${encodeURIComponent(options.ownerToken)}`,
        );
        await options.quiet();

        const tab = await page();

        await cdp.send("Performance.enable", {}, tab.sessionId);
        // Watch from the document's start, reading text only: innerText would lay the page out and count as work.
        await cdp.send(
            "Page.addScriptToEvaluateOnNewDocument",
            {
                source: `window.__perfShown = new Promise((resolve) => {
                    const shown = () => document.documentElement?.textContent.includes(${raw.stringify(options.marker)});
                    const done = () => requestAnimationFrame(() => resolve(performance.now()));
                    const observer = new MutationObserver(() => {
                        if (shown()) {
                            observer.disconnect();
                            done();
                        }
                    });

                    observer.observe(document, { subtree: true, childList: true, characterData: true });
                });`,
            },
            tab.sessionId,
        );
        const metrics = async () =>
            Object.fromEntries(
                (
                    (await cdp.send("Performance.getMetrics", {}, tab.sessionId)) as {
                        metrics: { name: string; value: number }[];
                    }
                ).metrics.map(({ name, value }) => [name, value]),
            ) as Metrics;
        const before = await metrics();
        const counted = snapshot();

        await tab.navigate(`${options.base}/s/${options.sessionId}`);
        const shown = await cdp.send(
            "Runtime.evaluate",
            { expression: "window.__perfShown", awaitPromise: true, returnByValue: true },
            tab.sessionId,
            30_000,
        );
        const after = await metrics();

        await options.quiet();

        return {
            ms: Number(shown.result.value),
            counts: {
                ...since(counted),
                "cdp.LayoutCount": (after.LayoutCount ?? 0) - (before.LayoutCount ?? 0),
                "cdp.RecalcStyleCount":
                    (after.RecalcStyleCount ?? 0) - (before.RecalcStyleCount ?? 0),
                "cdp.Nodes": after.Nodes ?? 0,
            },
            metrics: {
                scriptMs: ((after.ScriptDuration ?? 0) - (before.ScriptDuration ?? 0)) * 1000,
                taskMs: ((after.TaskDuration ?? 0) - (before.TaskDuration ?? 0)) * 1000,
                heapUsedBytes: after.JSHeapUsedSize ?? 0,
            },
        };
    } finally {
        chromium.kill();
        await chromium.exited;
    }
}
