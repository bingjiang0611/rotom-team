/**
 * Where a send waits, in phases. Headless Chromium runs the real web app on a name that is not loopback, so the app
 * chooses its transport as it does for a remote member (`web/store.js`): long polling when told to, the event stream
 * otherwise. A message goes from the composer with Enter to a native session whose process is already warm; the page,
 * the server and a second (Node) tab each stamp when they saw the message and the first of its answer.
 *
 * Every phase is milliseconds after the key press, on this process's clock: page stamps are mapped onto it with an
 * offset measured over DevTools before and after, and `clockUncertaintyMs` bounds that mapping. The page also reports
 * the app's own `send.shown` and `reply.first` (`web/perf.js`), the numbers the daily journal holds, as a check that
 * this measures the same waits. Where this machine has no Chromium the scenario is unavailable, never zero.
 *
 * `userEchoedMs` is the first paint of the message anywhere in the transcript, including a row the tab shows by itself
 * while the message goes (`.user-row.sending`); `userShownMs` is the first paint of the server's entry for it.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { Chromium } from "../../src/server/browser/cdp.ts";
import { findBrowser } from "../../src/server/browser/discovery.ts";
import {
    kernelRunChannel,
    webTimingChannel,
    type KernelRunSignal,
    type WebTimingSignal,
} from "../../src/server/perf-channels.ts";
import { raw, since, snapshot, type Counts } from "./counters.ts";
import { SEND_NETWORK } from "./workload.ts";
import { pageScript, REMOTE_HOST, sendClock, type Phases, watcher } from "./send-phases-browser.ts";

export async function measureSend(options: {
    base: string;
    ownerToken: string;
    token: string;
    sessionId: number;
    transport: "poll" | "stream";
    /** The newest answer already in the session, shown before the send. */
    ready: string;
    /** The end of the answer to this send. */
    done: string;
    quiet: () => Promise<void>;
    profile: string;
    /** New network scenarios only; established workloads keep their original transport conditions. */
    network?: boolean;
}): Promise<
    { ms: number; counts: Counts; extra: Record<string, number> } | { unavailable: string }
> {
    const executable = findBrowser();

    if (executable === undefined) {
        return { unavailable: "no Chromium-based browser on this machine" };
    }

    const port = new URL(options.base).port;
    const origin = `http://${REMOTE_HOST}:${port}`;
    const marker = `${options.transport}${options.network ? "network" : ""}`;
    const user = `SPLIT-USER-${marker}`;
    const reply = `SPLIT-REPLY-${marker}`;

    mkdirSync(options.profile, { recursive: true });
    const chromium = await Chromium.launch(executable, options.profile, [
        `--host-resolver-rules=MAP ${REMOTE_HOST} 127.0.0.1`,
        // A system proxy would be asked for the made-up name; this page talks to the loopback server only.
        "--no-proxy-server",
    ]);
    const cdp = chromium.connection;
    const runs: (KernelRunSignal & { at: number })[] = [];
    const appTimings: WebTimingSignal[] = [];
    const onRun = (message: unknown) =>
        runs.push({ ...(message as KernelRunSignal), at: sendClock() });
    const onWeb = (message: unknown) => appTimings.push(message as WebTimingSignal);
    let watch: ReturnType<typeof watcher> | undefined;

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
                targetId,
                sessionId,
                navigate: async (url: string) => {
                    const load = new Promise<void>((resolve) => (loaded = resolve));

                    await cdp.send("Page.navigate", { url }, sessionId);
                    await load;
                },
            };
        };

        const evaluate = async (expression: string, sessionId: string, timeout = 30_000) => {
            const answer = await cdp.send(
                "Runtime.evaluate",
                { expression, awaitPromise: true, returnByValue: true },
                sessionId,
                timeout,
            );

            assert.equal(
                answer.exceptionDetails,
                undefined,
                raw.stringify(answer.exceptionDetails),
            );

            return answer.result.value as unknown;
        };

        // Sign in on the remote name (its own cookie), then load the session in a fresh tab.
        const signIn = await page();

        await signIn.navigate(`${origin}/login?token=${encodeURIComponent(options.ownerToken)}`);
        await cdp.send("Target.closeTarget", { targetId: signIn.targetId });
        await options.quiet();

        const tab = await page();

        await cdp.send("Performance.enable", {}, tab.sessionId);
        let networkControl:
            { networkUnthrottledMs: number; networkThrottledMs: number } | undefined;

        if (options.network) {
            await cdp.send("Network.enable", {}, tab.sessionId);
            // Calibrate outside the send window, before opening either transport. This does not claim a physical RTT.
            await tab.navigate(`${origin}/api/theme`);
            const probe = async () =>
                Number(
                    await evaluate(
                        `(async () => {
                            const started = performance.now();
                            const response = await fetch("/api/theme", {cache: "no-store"});
                            if (response.status !== 200) {
                                throw new Error("network control refused");
                            }
                            await response.arrayBuffer();
                            return performance.now() - started;
                        })()`,
                        tab.sessionId,
                    ),
                );
            const networkUnthrottledMs = await probe();

            await cdp.send(
                "Network.emulateNetworkConditions",
                {
                    offline: false,
                    latency: SEND_NETWORK.latencyMs,
                    downloadThroughput: SEND_NETWORK.bytesPerSecond,
                    uploadThroughput: SEND_NETWORK.bytesPerSecond,
                },
                tab.sessionId,
            );
            const networkThrottledMs = await probe();

            assert.ok(
                networkThrottledMs - networkUnthrottledMs >= SEND_NETWORK.latencyMs * 0.8,
                `network control must observe the injected response delay: ${networkUnthrottledMs} → ${networkThrottledMs} ms`,
            );
            networkControl = { networkUnthrottledMs, networkThrottledMs };
        }

        await cdp.send(
            "Page.addScriptToEvaluateOnNewDocument",
            { source: pageScript(options.transport) },
            tab.sessionId,
        );
        await tab.navigate(`${origin}/s/${options.sessionId}`);
        await evaluate(`window.__sendReady(${raw.stringify(options.ready)})`, tab.sessionId);

        // The app took the transport asked for, and only that one.
        const used = (await evaluate(
            "({ polls: window.__sendPhases.polls, streams: window.__sendPhases.streams })",
            tab.sessionId,
        )) as { polls: number; streams: number };

        assert.ok(
            options.transport === "poll"
                ? used.polls > 0 && used.streams === 0
                : used.streams > 0 && used.polls === 0,
            `the page should use ${options.transport} only: ${raw.stringify(used)}`,
        );

        // Focus the message box (the app warms the native process), make sure the warm start has finished, and type.
        await evaluate(`document.querySelector("textarea").focus(), true`, tab.sessionId);
        const warmed = await fetch(`${options.base}/api/c/${options.sessionId}/warm`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${options.token}`,
                "x-pocket": "1",
                "content-type": "application/json",
            },
            body: "{}",
        });

        assert.equal(warmed.status, 200, await warmed.text());
        await cdp.send("Input.insertText", { text: `Split send ${user}, PACED.` }, tab.sessionId);
        watch = watcher(options.base, options.token, options.sessionId, [user, reply]);
        await watch.full;
        await options.quiet();

        // The page's epoch clock against this process's: the midpoint of a DevTools round trip.
        const offset = async () => {
            const sent = sendClock();
            const pageAt = Number(
                await evaluate("performance.timeOrigin + performance.now()", tab.sessionId),
            );
            const back = sendClock();

            return { offset: pageAt - (sent + back) / 2, half: (back - sent) / 2 };
        };

        const metrics = async () =>
            Object.fromEntries(
                (
                    (await cdp.send("Performance.getMetrics", {}, tab.sessionId)) as {
                        metrics: { name: string; value: number }[];
                    }
                ).metrics.map(({ name, value }) => [name, value]),
            ) as Record<string, number>;
        const first = await offset();

        assert.equal(
            await evaluate(
                `Object.keys(window.__rotomPerf).forEach(k => window.__rotomPerf[k] = 0);
                window.__sendArm(${raw.stringify(user)}, ${raw.stringify(reply)})`,
                tab.sessionId,
            ),
            true,
            "neither marker may be on the page before the send",
        );
        kernelRunChannel.subscribe(onRun);
        webTimingChannel.subscribe(onWeb);
        const before = await metrics();
        const counted = snapshot();
        const key = {
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
        };

        await cdp.send(
            "Input.dispatchKeyEvent",
            { type: "keyDown", ...key, text: "\r" },
            tab.sessionId,
        );
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }, tab.sessionId);
        await evaluate(`window.__sendDone(${raw.stringify(options.done)})`, tab.sessionId);

        for (
            let waited = 0;
            !runs.some((run) => run.outcome.startsWith("prompt:")) && waited < 10_000;
            waited += 20
        ) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }

        const after = await metrics();

        await options.quiet();
        const counts = since(counted);
        const last = await offset();
        const phases = (await evaluate("window.__sendPhases", tab.sessionId)) as Phases;
        const client = (await evaluate("window.__rotomPerf", tab.sessionId)) as Record<
            string,
            number
        >;

        // Leaving the page sends the app's queued timings (`pagehide`), as a closed tab would.
        await tab.navigate("about:blank");

        for (
            let waited = 0;
            !["send.shown", "reply.first"].every((name) =>
                appTimings.some((timing) => timing.name === name),
            ) && waited < 5_000;
            waited += 20
        ) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }

        const run = runs.find((each) => each.outcome.startsWith("prompt:"));

        assert.ok(run !== undefined, "the send made a prompt run");
        assert.equal(run.outcome, "prompt:settled", raw.stringify(runs));
        assert.ok(run.prompt !== undefined, "a prompt run reports its phases");
        assert.equal(run.prompt.process, "reused", "the send goes to the warm process");
        assert.ok(run.prompt.firstOutputMs !== null, "the model answered");

        for (const [name, value] of Object.entries(phases)) {
            assert.ok(value !== null, `the page stamped ${name}`);
        }

        assert.ok(watch.seen.has(user) && watch.seen.has(reply), "the watching tab saw both");

        const app = (name: string) => {
            const timing = appTimings.find((each) => each.name === name);

            assert.ok(timing !== undefined && "ms" in timing, `the app reported ${name}`);
            assert.equal(timing.transport, options.transport);

            return timing.ms;
        };

        const shift = (first.offset + last.offset) / 2;
        const keyAt = phases.key! - shift;
        const fromKey = (at: number | null) => at! - phases.key!;
        const server = (at: number) => at - keyAt;
        const admitted = run.at - run.ms;
        const dispatched = admitted + run.prompt.dispatchMs;
        const extra = {
            ...networkControl,
            submitSentMs: fromKey(phases.submitSent),
            submitAnsweredMs: fromKey(phases.submitAnswered),
            runAdmittedMs: server(admitted),
            promptDispatchedMs: server(dispatched),
            userPushedMs: server(watch.seen.get(user)!),
            userArrivedMs: fromKey(phases.userArrived),
            userEchoedMs: fromKey(phases.userEchoed),
            userShownMs: fromKey(phases.userShown),
            modelFirstOutputMs: server(dispatched + run.prompt.firstOutputMs),
            replyPushedMs: server(watch.seen.get(reply)!),
            replyArrivedMs: fromKey(phases.replyArrived),
            replyShownMs: fromKey(phases.replyShown),
            appSendShownMs: app("send.shown"),
            appReplyFirstMs: app("reply.first"),
            clockUncertaintyMs:
                Math.max(first.half, last.half) + Math.abs(last.offset - first.offset) / 2,
            scriptMs: ((after.ScriptDuration ?? 0) - (before.ScriptDuration ?? 0)) * 1000,
            taskMs: ((after.TaskDuration ?? 0) - (before.TaskDuration ?? 0)) * 1000,
        };

        return {
            ms: extra.replyShownMs,
            counts: {
                ...counts,
                "cdp.LayoutCount": (after.LayoutCount ?? 0) - (before.LayoutCount ?? 0),
                "cdp.RecalcStyleCount":
                    (after.RecalcStyleCount ?? 0) - (before.RecalcStyleCount ?? 0),
                "cdp.Nodes": after.Nodes ?? 0,
                "web.event.parse.calls": client.eventParseCalls!,
                "web.event.parse.chars": client.eventParseChars!,
                "web.view.apply.calls": client.viewApplyCalls!,
                "web.view.base.entry.copies": client.viewBaseEntryCopies!,
                "web.view.delta.entries": client.viewDeltaEntries!,
                "web.view.prune.checks": client.viewPruneChecks!,
                "web.view.order.ids": client.viewOrderIds!,
            },
            extra,
        };
    } finally {
        kernelRunChannel.unsubscribe(onRun);
        webTimingChannel.unsubscribe(onWeb);
        await watch?.close();
        chromium.kill();
        await chromium.exited;
    }
}
