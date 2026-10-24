// Fixed 20 flushed updates per scenario; real production App/Transcript in Chromium, no model inference.
import { withAppPage } from "../../../test/fixtures/app-browser.ts";
import { cleanUp } from "../../../test/helpers.ts";

try {
    await withAppPage(async (evaluate) => {
        const results = {};

        for (const kind of ["text", "thinking", "tool"]) {
            results[kind] = await evaluate(`appCommitFixture.measure(${JSON.stringify(kind)})`);
        }

        console.log(JSON.stringify({ updates: 20, results }, null, 2));
    });
} finally {
    cleanUp();
}
