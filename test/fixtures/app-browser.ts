// Native Team UI, synthetic account only. Hold app.js until the component-commit probe is installed.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PocketApp } from "../../src/server/app.ts";
import { Browsers } from "../../src/server/browser.ts";
import { createHandler } from "../../src/server/http.ts";
import { serveFile, WEB } from "../../src/server/http/assets.ts";
import { noInferenceModels, owner, root, until, work } from "../helpers.ts";

export async function withAppPage<T>(
    task: (evaluate: (expression: string) => Promise<any>) => Promise<T>,
    transport: "stream" | "poll" = "stream",
) {
    const directory = mkdtempSync(join(root, "app-commits-"));
    const app = await PocketApp.open({
        dataDir: join(realpathSync(directory), "data"),
        defaultCwd: realpathSync(work),
        supervised: false,
        kernel: true,
        browser: null,
        log: () => {},
        configureUserModels: noInferenceModels,
    });
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });
    const pageHtml = readFileSync(join(WEB, "index.html"), "utf8").replace(
        '<script type="module" src="/app.js"></script>',
        "",
    );
    const server = createServer((request, response) => {
        const path = new URL(request.url!, "http://fixture.local").pathname;

        if (path === "/" || /^\/s\/\d+$/.test(path)) {
            response.setHeader("content-type", "text/html");
            response.end(pageHtml);
        } else if (path === "/commit-fixture.js") {
            void serveFile(
                request,
                response,
                fileURLToPath(new URL("./app-commits.js", import.meta.url)),
            ).catch((error) => {
                response.writeHead(500).end(String(error));
            });
        } else {
            handler(request, response);
        }
    });
    const browsers = new Browsers({
        dataDir: join(directory, "browser"),
        load: async () => undefined,
        save: () => {},
    });

    try {
        const { id } = await app.commands.createSession(owner(app), { backend: "rotom" });

        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const base = `http://${transport === "poll" ? "localhost." : "127.0.0.1"}:${(server.address() as { port: number }).port}`;
        const page = await browsers.open(1);
        const evaluate = async (expression: string) =>
            JSON.parse(await page.evaluate(`JSON.stringify(await (${expression}))`));

        await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
        await page.navigate(`${base}/s/${id}`);

        if (transport === "poll") {
            await evaluate(
                "(localStorage.setItem('pocket.transport', 'poll:' + Date.now()), true)",
            );
        }

        await evaluate("import('/commit-fixture.js').then(() => true)");
        await evaluate("import('/app.js').then(() => appCommitFixture.attach()).then(() => true)");
        await until(
            async () =>
                await evaluate(`Boolean(appCommitFixture.state().me &&
            appCommitFixture.state().view.conversation?.id === ${id} &&
            appCommitFixture.state().view.kernel?.initializing === false &&
            document.querySelector('.composer textarea'))`),
            "native UI initialized",
            30_000,
        );
        await evaluate("appCommitFixture.flush().then(() => true)");
        assert.equal(await evaluate("Boolean(appCommitFixture.state().view.kernel)"), true);

        return await task(evaluate);
    } finally {
        await browsers.closeAll({ final: true });
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await app.close();
    }
}
