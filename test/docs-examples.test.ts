// Historical extension examples remain valid source, but the current app never loads or executes them.
import { cleanUp, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { ConfigStore } from "../src/server/config.ts";

const DOCS = fileURLToPath(new URL("../docs/", import.meta.url));
const EXAMPLES = join(DOCS, "examples");
const data = join(root, "docs-data");
const dropIns = join(data, "extensions");
let app: Awaited<ReturnType<typeof openApp>>;

before(async () => {
    mkdirSync(dropIns, { recursive: true });

    for (const file of readdirSync(EXAMPLES).filter((each) => each.endsWith(".ts"))) {
        copyFileSync(join(EXAMPLES, file), join(dropIns, file));
    }

    const config = new ConfigStore(data);

    config.setExtensionEnabled("clock.ts", true);
    config.setExtensionEnabled("no-force-push.ts", false);
    app = await openApp(scriptedModel(), data);
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** Parse historical code without importing an extension, invoking a factory, or dispatching a tool. */
function source(path: string): ts.SourceFile {
    const text = readFileSync(path, "utf8");
    const checked = ts.transpileModule(text, { fileName: path, reportDiagnostics: true });

    assert.deepEqual(
        checked.diagnostics?.filter(
            (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
        ) ?? [],
        [],
        `${path} parses`,
    );

    return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
}

test("example source and old extension choices survive archive startup without loading", async () => {
    for (let restart = 0; restart < 2; restart++) {
        assert.equal(app.loader, undefined);
        assert.deepEqual(app.config.enabledExtensions, ["clock.ts"]);
        assert.deepEqual(app.config.disabledExtensions, ["no-force-push.ts"]);
        assert.equal(existsSync(join(dropIns, "node_modules")), false);
        await assert.rejects(app.extensions(owner(app)), { status: 404 });
        await assert.rejects(app.setExtensionEnabled(owner(app), "clock.ts", false), {
            status: 404,
        });

        for (const name of ["clock.ts", "no-force-push.ts"]) {
            assert.equal(
                readFileSync(join(dropIns, name), "utf8"),
                readFileSync(join(EXAMPLES, name), "utf8"),
            );
            const parsed = source(join(EXAMPLES, name));
            const comment = ts.getLeadingCommentRanges(parsed.text, 0)?.[0];

            assert.ok(
                comment && comment.end - comment.pos > 20,
                "the example retains its descriptive header",
            );
            assert.ok(
                parsed.statements.some(
                    (statement) =>
                        ts.canHaveModifiers(statement) &&
                        ts
                            .getModifiers(statement)
                            ?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword),
                ),
                "the example retains its default export",
            );
        }

        if (restart === 0) {
            await app.close();
            app = await openApp(scriptedModel(), data);
        }
    }
});

test("every link between the docs leads to a file, and to a heading there when it names one", () => {
    const docs = [
        ...readdirSync(DOCS)
            .filter((file) => file.endsWith(".md"))
            .map((file) => join(DOCS, file)),
        resolve(DOCS, "../AGENTS.md"),
    ];
    const anchors = (file: string) =>
        new Set(
            [...readFileSync(file, "utf8").matchAll(/^#+ (.+)$/gm)].map((match) =>
                match[1]!
                    .toLowerCase()
                    .replace(/[^a-z0-9 _-]/g, "")
                    .replace(/ /g, "-"),
            ),
        );

    for (const doc of docs) {
        // Links in running text, not in code.
        const text = readFileSync(doc, "utf8")
            .replace(/```[\s\S]*?```/g, "")
            .replace(/`[^`\n]*`/g, "");

        for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
            if (/^[a-z]+:/.test(target!)) {
                continue;
            }

            const [path, anchor] = target!.split("#");
            const file = path === "" ? doc : resolve(dirname(doc), path!);

            assert.ok(existsSync(file), `${doc}: ${target} leads to a file`);

            if (anchor !== undefined && file.endsWith(".md")) {
                assert.ok(anchors(file).has(anchor), `${doc}: ${target} leads to a heading`);
            }
        }
    }
});
