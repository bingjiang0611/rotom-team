import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";

const web = fileURLToPath(new URL("../web/", import.meta.url));
const files = readdirSync(web)
    .filter((name) => /^store(?:-.+)?\.js$/.test(name))
    .map((name) => join(web, name));

test("store modules resolve every name and import without assigning to imported bindings", () => {
    const program = ts.createProgram(files, {
        allowJs: true,
        checkJs: true,
        noEmit: true,
        skipLibCheck: true,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2023,
    });
    // This checks JS linking and names, not a new JSDoc/type migration for the application's dynamic state.
    const linking = new Set([2304, 2305, 2306, 2307, 2440, 2451, 2632]);
    const errors = ts
        .getPreEmitDiagnostics(program)
        .filter(
            (error) => error.file && files.includes(error.file.fileName) && linking.has(error.code),
        );

    assert.equal(
        errors.length,
        0,
        ts.formatDiagnosticsWithColorAndContext(errors, {
            getCanonicalFileName: (name) => name,
            getCurrentDirectory: () => process.cwd(),
            getNewLine: () => "\n",
        }),
    );
});

test("store ownership modules form an acyclic dependency graph", () => {
    const program = ts.createProgram(files, { allowJs: true, noEmit: true });
    const visiting = new Set<string>();
    const done = new Set<string>();

    const visit = (file: string) => {
        assert.ok(!visiting.has(file), `store import cycle at ${file}`);

        if (done.has(file)) {
            return;
        }

        visiting.add(file);

        for (const statement of program.getSourceFile(file)!.statements) {
            if (
                (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
                statement.moduleSpecifier &&
                ts.isStringLiteral(statement.moduleSpecifier)
            ) {
                const dependency = resolve(dirname(file), statement.moduleSpecifier.text);

                if (files.includes(dependency)) {
                    visit(dependency);
                }
            }
        }

        visiting.delete(file);
        done.add(file);
    };

    files.forEach(visit);
});
