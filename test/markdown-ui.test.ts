// Real Chromium/Preact/parser/sanitizer; the frame clock is held to expose batching and immediate-finalization bugs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { withMarkdownPage } from "./fixtures/markdown-browser.ts";

const golden = JSON.parse(
    readFileSync(new URL("./fixtures/markdown-golden.json", import.meta.url), "utf8"),
);

test("streaming Markdown retains exact HTML and safety while coalescing work", async (t) => {
    await withMarkdownPage(async (evaluate) => {
        await t.test(
            "same-frame and unchanged input work disappears; paced input still parses",
            async () => {
                const expected = {
                    burst: {
                        parseCalls: 22,
                        parseChars: 195758,
                        sanitizeCalls: 22,
                        pending: 0,
                        finalChars: 17049,
                    },
                    paced: {
                        parseCalls: 22,
                        parseChars: 24643,
                        sanitizeCalls: 22,
                        pending: 0,
                        finalChars: 2139,
                    },
                    unchanged: {
                        parseCalls: 2,
                        parseChars: 26,
                        sanitizeCalls: 2,
                        pending: 0,
                        finalChars: 13,
                    },
                };

                for (const [mode, counts] of Object.entries(expected)) {
                    assert.deepEqual(
                        await evaluate(`markdownFixture.measure(${JSON.stringify(mode)})`),
                        counts,
                    );
                }
            },
        );

        for (const [name, html] of Object.entries(golden)) {
            await t.test(
                `${name}: final HTML equals the pre-change bytes, without waiting for a frame`,
                async () => {
                    const result = await evaluate(`(async () => {
                    const f = markdownFixture;
                    f.reset();
                    let text = '';
                    let unsafe = 0;
                    const chunks = f.cases[${JSON.stringify(name)}];
                    for (let i = 0; i < chunks.length; i++) {
                        text += chunks[i];
                        f.render(text);
                        // Leave the last chunk queued: completion must flush even in a hidden/paused tab.
                        if (i !== chunks.length - 1) await f.frame();
                        unsafe += f.host.querySelectorAll('script, [onload], [onerror], a[href^="javascript:"]').length;
                    }
                    const html = f.render(text, true);
                    const pending = f.pending();
                    await f.frame();
                    return { html, after: f.host.innerHTML, pending, unsafe,
                        executed: Boolean(window.__markdownXss), counts: f.counts() };
                })()`);

                    assert.equal(result.html, html);
                    assert.equal(
                        result.after,
                        html,
                        "no stale callback may overwrite the final result",
                    );
                    assert.equal(result.pending, 0);
                    assert.equal(result.unsafe, 0);
                    assert.equal(result.executed, false);
                    assert.ok(result.counts.sanitizeCalls > 0);
                    assert.equal(result.counts.sanitizeCalls, result.counts.parseCalls);
                },
            );
        }

        await t.test(
            "one retained frame takes the latest text; returning to the shown text cancels it",
            async () => {
                const result = await evaluate(`(async () => {
                const f = markdownFixture;
                f.reset();
                const raf = window.requestAnimationFrame;
                let requests = 0;
                window.requestAnimationFrame = callback => { requests++; return raf(callback); };
                try {
                    const initial = f.render('Frame initial');
                    f.render('Frame next');
                    f.render('Frame latest');
                    const before = f.host.innerHTML;
                    const pending = f.pending();
                    await f.frame();
                    const after = f.host.textContent;
                    f.render('Frame reversed');
                    f.render('Frame latest');
                    return { initial, before, pending, requests, after, left: f.pending(), counts: f.counts() };
                } finally { window.requestAnimationFrame = raf; }
            })()`);

                assert.equal(result.before, result.initial);
                assert.equal(result.pending, 1);
                assert.equal(
                    result.requests,
                    2,
                    "one request for the burst, one for the subsequently cancelled update",
                );
                assert.equal(result.after.trim(), "Frame latest");
                assert.equal(result.left, 0);
                assert.equal(result.counts.parseCalls, 2);
            },
        );

        await t.test(
            "conversation and basePath changes invalidate immediately, including pending text",
            async () => {
                const result = await evaluate(`(async () => {
                const f = markdownFixture;
                f.reset();
                f.render('[Context](same.md)', false, '/first/readme.md');
                f.render('[Queued context](same.md)', false, '/first/readme.md');
                f.conversation(42);
                f.render('[Queued context](same.md)', false, '/first/readme.md');
                const conversation = f.host.querySelector('a').getAttribute('href');
                const label = f.host.textContent;
                f.render('[Queued context](same.md)', false, '/second/readme.md');
                const base = f.host.querySelector('a').getAttribute('href');
                const pending = f.pending();
                await f.frame();
                return { conversation, base, label, pending, after: f.host.querySelector('a').getAttribute('href') };
            })()`);

                assert.equal(result.conversation, "/api/c/42/download?path=%2Ffirst%2Fsame.md");
                assert.equal(result.base, "/api/c/42/download?path=%2Fsecond%2Fsame.md");
                assert.equal(result.label.trim(), "Queued context");
                assert.equal(result.after, result.base);
                assert.equal(result.pending, 0);
            },
        );

        await t.test(
            "unmount cancels work; a new stream has an immediate first value",
            async () => {
                const result = await evaluate(`(async () => {
                const f = markdownFixture;
                f.reset();
                f.render('Unmount initial');
                f.render('Unmount pending');
                const queued = f.pending();
                f.unmount();
                const cancelled = f.pending();
                await f.frame();
                const empty = f.host.innerHTML;
                f.render('New settled', true);
                f.render('New stream');
                return { queued, cancelled, empty, newText: f.host.textContent, counts: f.counts() };
            })()`);

                assert.equal(result.queued, 1);
                assert.equal(result.cancelled, 0);
                assert.equal(result.empty, "");
                assert.equal(result.newText.trim(), "New stream");
                assert.equal(result.counts.parseCalls, 3);
            },
        );

        await t.test(
            "rich-block streaming flag and final source change without waiting for a frame",
            async () => {
                const result = await evaluate(String.raw`(async () => {
                const f = markdownFixture;
                f.reset(); f.rich();
                f.render('Rich fixture\n\n' + '\x60\x60\x60html\n<div>first');
                const initial = f.host.querySelector('section')?.dataset.streaming;
                const final = 'Rich fixture\n\n' + '\x60\x60\x60html\n<div>last</div>\n\x60\x60\x60';
                f.render(final);
                f.render(final, true);
                const flag = f.host.querySelector('section')?.dataset.streaming;
                const text = f.host.textContent;
                const pending = f.pending();
                await f.frame();
                return { initial, flag, text, after: f.host.textContent, pending };
            })()`);

                assert.equal(result.initial, "true");
                assert.equal(result.flag, "false");
                assert.match(result.text, /last/);
                assert.equal(result.after, result.text);
                assert.equal(result.pending, 0);
            },
        );
        await t.test(
            "deferred text growth follows the bottom, but never drags a reader back down",
            async () => {
                const result = await evaluate(String.raw`(async () => {
                const f = markdownFixture;
                f.reset();
                const { h, render } = await import('preact');
                const { Transcript } = await import('/transcript.js');
                const { store } = await import('/store.js');
                const style = document.createElement('style');
                style.textContent = '.scroller { height: 140px; overflow: auto; }';
                document.head.append(style);
                const draw = text => {
                    store.state.view.live = { busy: true, generation: { message: { blocks: [{ type: 'text', text }] } } };
                    render(h(Transcript), f.host);
                };
                const resized = (element, before) => new Promise(resolve => {
                    const observer = new ResizeObserver(([entry]) => {
                        if (entry.contentRect.height > before) {
                            observer.disconnect(); resolve();
                        }
                    });
                    observer.observe(element);
                });
                try {
                    let text = 'Scroll line\n\n'.repeat(30);
                    draw(text);
                    const scroller = f.host.querySelector('.scroller');
                    const content = scroller.firstElementChild;
                    await resized(content, 0);
                    const initialGap = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
                    const grew = resized(content, content.getBoundingClientRect().height);
                    text += 'Deferred line\n\n'.repeat(20);
                    draw(text);
                    await f.frame();
                    await grew;
                    const grownGap = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
                    scroller.scrollTop = 0;
                    scroller.dispatchEvent(new Event('scroll'));
                    const readMore = resized(content, content.getBoundingClientRect().height);
                    draw(text + 'More while reading\n\n'.repeat(20));
                    await f.frame();
                    await readMore;
                    return { initialGap, grownGap, readingTop: scroller.scrollTop };
                } finally { f.unmount(); style.remove(); }
            })()`);

                assert.equal(result.initialGap, 0);
                assert.equal(result.grownGap, 0);
                assert.equal(result.readingTop, 0);
            },
        );
    });
});
