import assert from "node:assert/strict";
import { raw } from "./counters.ts";

/** Resolved to loopback inside Chromium only. Not `localhost` or `127.x`, which the app treats as local. */
export const REMOTE_HOST = "perf-remote.test";

export const sendClock = () => performance.timeOrigin + performance.now();

export type Phases = {
    key: number | null;
    polls: number;
    streams: number;
    submitSent: number | null;
    submitAnswered: number | null;
    userArrived: number | null;
    replyArrived: number | null;
    userEchoed: number | null;
    userShown: number | null;
    replyShown: number | null;
};

/**
 * Installed before the app's own scripts. It chooses the transport, stamps (on the page's epoch clock) the key press,
 * the submit request, the first event that carries each marker, and the first frame after each marker is in the
 * transcript: the first task after the next animation frame, as `web/perf.js` defines "on screen".
 */
export const pageScript = (transport: "poll" | "stream") => `(() => {
    if (${raw.stringify(transport)} === "poll") {
        localStorage.setItem("pocket.transport", "poll:" + Date.now());
    } else {
        localStorage.removeItem("pocket.transport");
    }

    window.__rotomPerf = {
        eventParseCalls: 0, eventParseChars: 0, eventParseMs: 0,
        viewApplyCalls: 0, viewApplyMs: 0, viewBaseEntryCopies: 0,
        viewDeltaEntries: 0, viewPruneChecks: 0, viewOrderIds: 0
    };

    const now = () => performance.timeOrigin + performance.now();
    const phases = window.__sendPhases = {
        key: null, polls: 0, streams: 0, submitSent: null, submitAnswered: null,
        userArrived: null, replyArrived: null, userEchoed: null, userShown: null, replyShown: null
    };
    let markers = null;

    const seen = (text, at) => {
        if (markers === null) {
            return;
        }

        if (phases.userArrived === null && text.includes(markers.user)) {
            phases.userArrived = at;
        }

        if (phases.replyArrived === null && text.includes(markers.reply)) {
            phases.replyArrived = at;
        }
    };

    const fetched = window.fetch;

    window.fetch = async function (input, init) {
        const url = String(input instanceof Request ? input.url : input);
        const polling = url.includes("/api/poll?");
        const submit = markers !== null && phases.submitSent === null && url.includes("/submit");

        if (polling) {
            phases.polls++;
        }

        if (submit) {
            phases.submitSent = now();
        }

        const response = await fetched.call(this, input, init);

        if ((polling && markers !== null) || submit) {
            response.clone().text().then(
                (text) => {
                    const at = now();

                    if (submit) {
                        phases.submitAnswered = at;
                    } else {
                        seen(text, at);
                    }
                },
                () => {}
            );
        }

        return response;
    };

    const Source = window.EventSource;
    const listen = Source.prototype.addEventListener;

    window.EventSource = class extends Source {
        constructor(...args) {
            super(...args);
            phases.streams++;
        }
    };
    Source.prototype.addEventListener = function (type, listener, options) {
        if (typeof listener !== "function") {
            return listen.call(this, type, listener, options);
        }

        return listen.call(this, type, function (event) {
            if (typeof event.data === "string") {
                seen(event.data, now());
            }

            return listener.call(this, event);
        }, options);
    };

    addEventListener("keydown", (event) => {
        if (markers !== null && phases.key === null && event.key === "Enter") {
            phases.key = performance.timeOrigin + event.timeStamp;
        }
    }, true);

    const transcript = () => document.querySelector(".transcript")?.textContent ?? "";

    window.__sendReady = (marker) => new Promise((resolve, reject) => {
        const started = performance.now();
        const check = () => {
            if (transcript().includes(marker) && document.querySelector("textarea")) {
                resolve(true);
            } else if (performance.now() - started > 30000) {
                reject(new Error("the session did not show " + marker));
            } else {
                setTimeout(check, 50);
            }
        };

        check();
    });

    /** Start watching for both markers; false when either is on the page already (the stamps would be wrong). */
    window.__sendArm = (user, reply) => {
        const text = transcript();

        if (text.includes(user) || text.includes(reply)) {
            return false;
        }

        markers = { user, reply };
        const painted = (name) =>
            requestAnimationFrame(() => setTimeout(() => (phases[name] ??= now()), 0));
        // The message as the tab shows it while it goes (a row marked \`sending\`), and as the server's entry.
        const confirmed = () =>
            [...document.querySelectorAll(".transcript .user-row:not(.sending)")].some((row) =>
                row.textContent.includes(markers.user)
            );
        let userEchoed = false;
        let userSeen = false;
        let replySeen = false;
        const observer = new MutationObserver(() => {
            const text = transcript();

            if (!userEchoed && text.includes(markers.user)) {
                userEchoed = true;
                painted("userEchoed");
            }

            if (!userSeen && confirmed()) {
                userSeen = true;
                painted("userShown");
            }

            if (!replySeen && text.includes(markers.reply)) {
                replySeen = true;
                painted("replyShown");
            }

            if (userSeen && replySeen) {
                observer.disconnect();
            }
        });

        observer.observe(document, { subtree: true, childList: true, characterData: true });

        return true;
    };

    window.__sendDone = (marker) => new Promise((resolve, reject) => {
        const started = performance.now();
        const check = () => {
            if (
                phases.userShown !== null &&
                phases.replyShown !== null &&
                transcript().includes(marker) &&
                !document.querySelector(".transcript .user-row.sending")
            ) {
                resolve(true);
            } else if (performance.now() - started > 30000) {
                reject(new Error("the answer did not finish showing"));
            } else {
                setTimeout(check, 20);
            }
        };

        check();
    });
})();`;

/** A Node tab on the event stream that stamps the first frame carrying each marker, without parsing (no JSON work). */
export function watcher(base: string, token: string, sessionId: number, markers: string[]) {
    const controller = new AbortController();
    const seen = new Map<string, number>();
    let ready!: () => void;
    const full = new Promise<void>((resolve) => (ready = resolve));
    const reading = (async () => {
        const response = await fetch(
            `${base}/api/events?c=${sessionId}&tab=perf-send-watch-${Date.now()}`,
            { headers: { authorization: `Bearer ${token}` }, signal: controller.signal },
        );

        assert.equal(response.status, 200);
        const decoder = new TextDecoder();
        let buffer = "";

        for await (const chunk of response.body!) {
            buffer += decoder.decode(chunk as Uint8Array, { stream: true });
            let end: number;

            while ((end = buffer.indexOf("\n\n")) >= 0) {
                const frame = buffer.slice(0, end);
                const at = sendClock();

                buffer = buffer.slice(end + 2);

                if (frame.startsWith("event: view\n") && frame.includes('"full":true')) {
                    ready();
                }

                for (const marker of markers) {
                    if (!seen.has(marker) && frame.includes(marker)) {
                        seen.set(marker, at);
                    }
                }
            }
        }
    })().catch((error: Error) => {
        if (error.name !== "AbortError") {
            throw error;
        }
    });

    return {
        full,
        seen,
        async close() {
            controller.abort();
            await reading;
        },
    };
}
