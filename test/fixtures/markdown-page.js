// Counts the real parser/sanitizer and drives real Preact/DOM, with an explicit frame clock (not wall time).
import DOMPurify from "dompurify";
import { marked } from "marked";
import { h, options, render } from "preact";
import { Markdown, setRichBlock } from "/ui.js";
import { store } from "/store.js";

const host = document.createElement("main");

document.body.append(host);
options.debounceRendering = queueMicrotask;
const frames = new Map();
let nextFrame = 0;

window.requestAnimationFrame = (callback) => {
    const id = ++nextFrame;

    frames.set(id, callback);

    return id;
};

window.cancelAnimationFrame = (id) => frames.delete(id);
let counts;
const parse = marked.parse;
const sanitize = DOMPurify.sanitize;

marked.parse = function (text, ...args) {
    counts.parseCalls++;
    counts.parseChars += text.length;

    return parse.call(this, text, ...args);
};

DOMPurify.sanitize = function (text, ...args) {
    counts.sanitizeCalls++;

    return sanitize.call(this, text, ...args);
};

const cases = {
    openFence: [
        "Before\n\n```js\n",
        "const value = '<img onerror=evil()>';\n",
        "console.log(value);",
    ],
    closeFence: ["Start\n\n`", "``js\nconst n = 1;\n", "``", "`\n\nEnd."],
    structures: [
        "[Guide][target]\n\n> quoted",
        " **bold**\n> continued\n\n- one\n",
        "  - nested\n\n| a | b |\n",
        "| - | - |\n| 1 | 2 |\n\n",
        "[target]: https://example.test/guide\n",
    ],
    htmlPage: [
        "<!doc",
        "type html>\n<html><body>",
        "<script>window.__markdownXss = 1;</script>",
        "</body></html>",
    ],
    xss: [
        "<img src='missing.png' on",
        "error='window.__markdownXss=1'>\n",
        "<svg onload='window.__markdownXss=1'></svg>\n",
        "[bad](java",
        "script:alert(1))\n<script>window.__markdownXss=1;</script>",
    ],
    longCode: [
        "Long code\n\n```js\n",
        ...Array.from({ length: 130 }, (_, i) => `const line${i} = ${i};\n`),
        "```",
    ],
    paths: [
        "Read [notes]",
        "(notes/readme.md) and `src/ui.js`.\n\n",
        "![preview](images/shot.png)",
    ],
    richBlocks: ["```html\n<div>Page</div>\n", "```\n\nText\n\n```diff\n", "-old\n+new\n```"],
};

const fixture = (window.markdownFixture = {
    host,
    cases,
    reset() {
        render(null, host);
        counts = { parseCalls: 0, parseChars: 0, sanitizeCalls: 0 };
        store.state.view.conversation = { id: 41 };
        setRichBlock(null);
    },
    render(text, cache = false, basePath = null) {
        render(h(Markdown, { text, cache, basePath }), host);

        return host.innerHTML;
    },
    unmount() {
        render(null, host);
    },
    counts: () => ({ ...counts }),
    pending: () => frames.size,
    conversation(id) {
        store.state.view.conversation = { id };
    },
    rich() {
        setRichBlock(({ html, streaming }) =>
            h("section", {
                "data-streaming": String(streaming),
                dangerouslySetInnerHTML: { __html: html },
            }),
        );
    },
    async frame() {
        const batch = [...frames.values()];

        frames.clear();

        for (const callback of batch) {
            callback(performance.now());
        }

        await Promise.resolve();
    },
    async measure(mode) {
        fixture.reset();
        let text = `# ${mode}\n\n`;

        fixture.render(text);

        for (let frame = 0; frame < 20; frame++) {
            for (let update = 0; update < (mode === "burst" ? 8 : 1); update++) {
                if (mode !== "unchanged") {
                    text += `${frame}.${update} ${"text ".repeat(20)}\n\n`;
                }

                fixture.render(text);

                if (mode === "burst") {
                    fixture.render(text);
                }
            }

            await fixture.frame();
        }

        fixture.render(text, true);

        return { ...counts, pending: frames.size, finalChars: text.length };
    },
    capture() {
        const result = {};

        for (const [name, chunks] of Object.entries(cases)) {
            fixture.reset();
            let text = "";

            for (const chunk of chunks) {
                text += chunk;
                fixture.render(text);
            }

            result[name] = fixture.render(text, true);
        }

        return result;
    },
});

fixture.reset();
