// D6: full computed-style hashes in Chromium, plus stylesheet requests. No real accounts or inference.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { withAppPage } from "../../../test/fixtures/app-browser.ts";
import { cleanUp } from "../../../test/helpers.ts";
import { VIEWPORTS } from "../../../src/server/browser/viewport.ts";

const baseline = new URL("./style-baseline.json", import.meta.url);
const hash = (text) => createHash("sha256").update(text).digest("hex");
const markup = `<section id="d6-samples" style="position:fixed;inset:0 auto auto 0;width:340px;z-index:9999">
<div class="native-banner">Unknown operation</div>
<div class="native-question"><div class="native-question-title">Question</div><div class="native-question-options"><button>Choice</button></div><textarea>Text</textarea></div>
<div class="native-selector"><div class="native-selector-list"><button class="native-selector-row on">Selected</button></div></div>
<div class="native-context"><span class="tone-accent">Context</span><span class="tone-warning">Warning</span></div>
<div class="native-tree-sheet"><div class="sheet-body"><div class="native-tree">
<div class="native-tree-help">Help</div><label class="native-tree-search"><input value="query"></label>
<div class="native-tree-list"><button class="native-tree-row on"><span class="native-tree-cursor">›</span>Entry</button><div class="native-tree-empty">Empty</div></div>
<label class="native-tree-summary"><input type="checkbox" checked>Summary</label></div></div></div>
<div class="peek-tiles"><div class="peek-tile"><button class="peek-seen">Seen</button></div></div>
</section>`;

try {
    const report = await withAppPage(async (evaluate, _app, page) => {
        const cases = [];
        const trace = [];

        await evaluate(
            `(document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(markup)}), true)`,
        );

        for (const size of ["desktop", "mobile"]) {
            await page.setViewport(VIEWPORTS[size]);

            for (const mode of ["dark", "light"]) {
                const result = await evaluate(`(async () => {
                    document.documentElement.dataset.mode = ${JSON.stringify(mode)};
                    document.documentElement.dataset.motion = 'reduced';
                    await document.fonts.ready;
                    document.querySelector('#d6-samples .native-tree-search input').focus();
                    await new Promise(requestAnimationFrame);
                    const samples = document.querySelector('#d6-samples');
                    samples.getBoundingClientRect();
                    await Promise.allSettled(document.getAnimations().filter(animation => {
                        const target = animation.effect?.target;
                        return target instanceof Element && (samples.contains(target) || target.contains(samples));
                    }).map(animation => animation.finished));
                    await document.fonts.ready;
                    return {
                        coarse: matchMedia('(pointer: coarse)').matches,
                        width: innerWidth,
                        styles: [...document.querySelectorAll('#d6-samples, #d6-samples *')].map(node => ({
                            tag: node.tagName, classes: node.className,
                            properties: Object.fromEntries([...getComputedStyle(node)].sort().map(key =>
                                [key, getComputedStyle(node).getPropertyValue(key).replaceAll(location.origin, 'http://fixture.invalid')]))
                        }))
                    };
                })()`);

                trace.push({ size, mode, ...result });
                assert.equal(result.coarse, size === "mobile");
                cases.push({
                    size,
                    mode,
                    width: result.width,
                    coarse: result.coarse,
                    styles: result.styles.map(({ tag, classes, properties }) => ({
                        tag,
                        classes,
                        hash: hash(JSON.stringify(properties)),
                    })),
                });
            }
        }

        const network = await evaluate(`({
            links: [...document.querySelectorAll('link[rel=stylesheet]')].map(n => new URL(n.href).pathname),
            resources: performance.getEntriesByType('resource').filter(r => /\\/(style|native)\\.css$/.test(r.name)).map(r => ({
                path: new URL(r.name).pathname, initiator: r.initiatorType, start: r.startTime,
                end: r.responseEnd, encodedBytes: r.encodedBodySize, transferredBytes: r.transferSize
            }))
        })`);

        return { cases, network, trace };
    });

    if (process.env.D6_STYLE_TRACE) {
        writeFileSync(process.env.D6_STYLE_TRACE, JSON.stringify(report.trace));
    }

    if (process.argv.includes("--record")) {
        assert.ok(!existsSync(baseline), "baseline exists; do not regenerate it after moving CSS");
        writeFileSync(baseline, JSON.stringify(report.cases, null, 2) + "\n");
    } else {
        assert.deepEqual(report.cases, JSON.parse(readFileSync(baseline, "utf8")));
    }

    console.log(
        JSON.stringify(
            {
                equivalent: true,
                cases: report.cases.length,
                nodesPerCase: report.cases[0].styles.length,
                ...report.network,
            },
            null,
            2,
        ),
    );
} finally {
    cleanUp();
}
