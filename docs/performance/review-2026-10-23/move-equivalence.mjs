// D6 review-only evidence, not a permanent constraint on later behavior changes. Never regenerate the baseline.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const exists = (path) => existsSync(new URL(path, root));
const hash = (text) => createHash("sha256").update(text).digest("hex");
const statements = (source) =>
    ts.createSourceFile("move.ts", source, ts.ScriptTarget.Latest, true).statements;
const name = (node) =>
    ts.isVariableStatement(node)
        ? node.declarationList.declarations[0].name.getText()
        : node.name?.getText();
const text = (node) => node.getFullText().trim();
// Imports and local export declarations are linkage, not moved implementation. Keep bodies/comments byte-for-byte.
const body = (source) =>
    statements(source)
        .filter((node) => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node))
        .map(text)
        .join("\n\n");
const selected = (source, names) =>
    statements(source)
        .filter((node) => names.includes(name(node)))
        .map(text)
        .join("\n\n");
const without = (source, names) =>
    statements(source)
        .filter(
            (node) =>
                !ts.isImportDeclaration(node) &&
                !ts.isExportDeclaration(node) &&
                !names.includes(name(node)),
        )
        .map(text)
        .join("\n\n");
const helpers = {
    upload: "src/server/http/conversation-routes/upload.ts",
    projection: "src/server/team-kernel/projection.ts",
    tail: "src/server/rotom-executions/native-tail.ts",
};
const uploadNames = ["MAX_UPLOAD", "safeName"];
const tailNames = ["NATIVE_LINE_LIMIT", "NATIVE_TAIL_CACHE_LIMIT"];
const route = read("src/server/http/conversation-routes.ts");
const upload = exists(helpers.upload) ? read(helpers.upload) : route;
const routeTail = upload.slice(
    upload.indexOf('    if (third === "upload"'),
    upload.lastIndexOf("\n}"),
);

assert.ok(routeTail.startsWith('    if (third === "upload"'));
let routeRebuilt = body(route);

if (exists(helpers.upload)) {
    assert.equal(without(upload, [...uploadNames, "conversationUpload"]), "");
    const wrapper = statements(upload).find((node) => name(node) === "conversationUpload");

    assert.equal(
        wrapper.body.statements.length,
        3,
        "only parameter binding, original if, original 404",
    );
    assert.equal(
        wrapper.body.statements[0].getText(),
        "const { app, request, response, url, user } = api;",
    );
    const limit = selected(upload, ["MAX_UPLOAD"]);
    const safe = selected(upload, ["safeName"]);

    routeRebuilt =
        limit +
        "\n\n" +
        routeRebuilt
            .replace(
                "export async function conversationRoutes",
                safe + "\n\nexport async function conversationRoutes",
            )
            .replace("    return conversationUpload(api, id, third, method);", routeTail);
}

const team = read("src/server/team-kernel.ts");
const projection = exists(helpers.projection)
    ? body(read(helpers.projection))
    : selected(team, ["publicEntry", "applyUpdate"]);
const executions = read("src/server/rotom-executions.ts");
const tail = exists(helpers.tail) ? read(helpers.tail) : executions;
const tailBlock = selected(tail, ["readNativeSnapshot", "readNativeEntries", "NativeTail"]);
const limits = selected(tail, tailNames);
let executionsRebuilt = body(executions);

if (exists(helpers.tail)) {
    executionsRebuilt =
        executionsRebuilt.replace(
            "/** Observers of one prompt:",
            limits + "\n\n/** Observers of one prompt:",
        ) +
        "\n\n" +
        tailBlock;
    assert.equal(
        without(tail, [...tailNames, "readNativeSnapshot", "readNativeEntries", "NativeTail"]),
        "",
    );
}

// These new owners cannot acquire side-effectful app dependencies or introduce a circular owner import.
for (const [key, path] of Object.entries(helpers)) {
    if (!exists(path)) {
        continue;
    }

    const imports = statements(read(path)).filter(ts.isImportDeclaration);
    const allowed = {
        upload: [
            "node:crypto",
            "node:fs",
            "node:path",
            "node:stream/promises",
            "../../errors.ts",
            "../assets.ts",
            "../io.ts",
        ],
        projection: [],
        tail: ["node:crypto", "node:fs", "../perf-channels.ts"],
    }[key];

    for (const node of imports) {
        if (!node.importClause?.isTypeOnly) {
            assert.ok(
                allowed.includes(node.moduleSpecifier.text),
                `${path}: unexpected runtime import`,
            );
        }
    }

    for (const node of statements(read(path)).filter(ts.isExportDeclaration)) {
        assert.equal(node.moduleSpecifier, undefined, "direct owner, no re-export barrel");
    }
}

const css = read("web/style.css");
const split = exists("web/native.css");
const suffix = split
    ? read("web/native.css")
    : css.slice(css.indexOf("/* A rotom operation whose outcome is unknown"));
const index = read("web/index.html").replace(
    '        <link rel="stylesheet" href="/native.css" />\n',
    "",
);
const signIn = read("src/server/http/sign-in.ts").replace(
    '<link rel="stylesheet" href="/native.css">',
    "",
);

if (split) {
    assert.match(
        read("web/index.html"),
        /href="\/style\.css" \/>\n        <link rel="stylesheet" href="\/native\.css"/,
    );
    assert.match(
        read("src/server/http/sign-in.ts"),
        /href="\/style\.css"><link rel="stylesheet" href="\/native\.css">/,
    );
    assert.ok(!suffix.includes("@import"));
}

const observed = {
    routeOwner: hash(routeRebuilt),
    uploadTail: hash(routeTail),
    uploadDependencies: hash(selected(upload, uploadNames)),
    teamOwner: hash(body(team) + (exists(helpers.projection) ? "\n\n" + projection : "")),
    projection: hash(projection),
    executionsOwner: hash(executionsRebuilt),
    nativeTail: hash(tailBlock),
    nativeLimits: hash(limits),
    css: hash(split ? css + "\n" + suffix : css),
    cssSuffix: hash(suffix),
    index: hash(index),
    signIn: hash(signIn),
};
const baseline = new URL("./move-baseline.json", import.meta.url);

if (process.argv.includes("--record")) {
    assert.ok(!existsSync(baseline), "baseline already exists; do not regenerate to fit a move");
    assert.ok(!Object.values(helpers).some(exists) && !split);
    writeFileSync(
        baseline,
        JSON.stringify({ revision: "5551a50", hashes: observed }, null, 2) + "\n",
    );
} else {
    assert.deepEqual(observed, JSON.parse(readFileSync(baseline, "utf8")).hashes);
}

console.log(
    JSON.stringify(
        {
            equivalent: true,
            base: "5551a50",
            moved: {
                ...Object.fromEntries(
                    Object.entries(helpers).map(([key, path]) => [key, exists(path)]),
                ),
                css: split,
            },
            hashes: observed,
        },
        null,
        2,
    ),
);
