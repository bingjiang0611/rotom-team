// Fixed frame workload, real production Markdown/marked/DOMPurify in Chromium. Counts, not a timing/SLO claim.
// node docs/performance/review-2026-10-23/markdown-bench.mjs [--capture <golden.json>]
import { writeFileSync } from "node:fs";
import { withMarkdownPage } from "../../../test/fixtures/markdown-browser.ts";

await withMarkdownPage(async (evaluate) => {
    const results = {};

    for (const mode of ["burst", "paced", "unchanged"]) {
        results[mode] = await evaluate(`markdownFixture.measure(${JSON.stringify(mode)})`);
    }

    const capture = process.argv.indexOf("--capture");

    if (capture !== -1) {
        writeFileSync(
            process.argv[capture + 1],
            `${JSON.stringify(await evaluate("markdownFixture.capture()"), null, 4)}\n`,
        );
    }

    console.log(JSON.stringify({ frames: 20, results }, null, 2));
});
