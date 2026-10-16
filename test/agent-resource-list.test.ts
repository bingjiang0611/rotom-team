// helpers.ts first: it points Pi's folder at a temporary one before anything from src/ loads.
import { cleanUp, owner, root as testRoot, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
    existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { listAgentResources } from "../src/server/agent-resource-list.ts";
import { teamPolicyExtension, teamSkillsExtension } from "../src/server/rotom-kernel.ts";
import { PocketApp } from "../src/server/app.ts";
import { createHandler } from "../src/server/http.ts";

after(cleanUp);

// The launcher sets this inside a session; the service does not have it. Native reads it once, on first import.
delete process.env.ROTOM_PRODUCT_VERSION;

const product = fileURLToPath(
    new URL("../runtime/rotom/node_modules/@bingjiang0611/rotom", import.meta.url),
);

function put(file: string, text: string) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
}

const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} skill\n---\n# ${name}\n`;

function fixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-resource-list-")));
    const shared = join(root, "data/team-agent"),
        project = join(root, "work/project");

    put(join(shared, "AGENTS.md"), "shared");
    put(join(shared, "skills/release/SKILL.md"), skill("release"));
    put(join(shared, "skills/off/SKILL.md"), skill("off"));
    put(join(shared, "extensions/note.ts"), "export default () => {};\n");
    put(join(shared, "tools/package.json"), JSON.stringify({ name: "tools" }));
    put(join(shared, "tools/skills/packaged/SKILL.md"), skill("packaged"));
    put(
        join(shared, "settings.json"),
        JSON.stringify({ packages: ["./tools"], skills: ["-skills/off"] }),
    );
    put(
        join(shared, "mcp.json"),
        JSON.stringify({ mcpServers: { docs: { url: "https://example.invalid/mcp" } } }),
    );
    put(join(root, "work/AGENTS.md"), "ancestor");
    put(join(project, "AGENTS.md"), "project");
    put(join(project, ".pi/skills/release/SKILL.md"), skill("release"));
    put(join(project, ".pi/extensions/local.ts"), "export default () => {};\n");
    put(
        join(project, ".pi/mcp.json"),
        JSON.stringify({
            mcpServers: { docs: { enabled: false }, local: { command: "/bin/echo", args: ["."] } },
        }),
    );

    return { root, shared, project };
}

test("shared scope lists only the shared profile's files, with packages and disabled entries", async (t) => {
    const { root, shared } = fixture();

    t.after(() => rmSync(root, { recursive: true, force: true }));
    const list = await listAgentResources(shared);

    assert.deepEqual(list.problems, []);
    assert.deepEqual(list.instructions, [{ path: join(shared, "AGENTS.md"), scope: "shared" }]);
    assert.deepEqual(
        list.skills.map((each) => [each.name, each.path, each.enabled, each.scope]),
        [
            ["off", join(shared, "skills/off/SKILL.md"), false, "shared"],
            ["packaged", join(shared, "tools/skills/packaged/SKILL.md"), true, "shared"],
            ["pi-subagents", join(product, "skills/pi-subagents/SKILL.md"), true, "bundled"],
            ["release", join(shared, "skills/release/SKILL.md"), true, "shared"],
        ],
    );
    assert.equal(list.skills[1]!.packageRoot, join(shared, "tools"));
    assert.equal(list.skills[1]!.source, "./tools");
    assert.deepEqual(
        list.extensions.map((each) => each.path),
        [join(shared, "extensions/note.ts")],
    );
    assert.deepEqual(list.mcp, [
        {
            name: "docs",
            file: join(shared, "mcp.json"),
            scope: "shared",
            enabled: true,
            target: "https://example.invalid/mcp",
        },
    ]);
    assert.deepEqual(list.scanned.mcp, [{ path: join(shared, "mcp.json"), exists: true }]);
});

test("project scope merges the project like a session: instruction chain, same-name skills, MCP overrides", async (t) => {
    const { root, shared, project } = fixture();

    t.after(() => rmSync(root, { recursive: true, force: true }));
    const list = await listAgentResources(shared, project);

    assert.deepEqual(list.instructions, [
        { path: join(shared, "AGENTS.md"), scope: "shared" },
        { path: join(root, "work/AGENTS.md"), scope: "ancestor" },
        { path: join(project, "AGENTS.md"), scope: "project" },
    ]);
    const release = list.skills.filter((each) => each.name === "release");

    // Project resources resolve first, so the project's skill loads and the shared one is reported, not loaded.
    assert.deepEqual(
        release.map((each) => [each.path, each.scope, each.enabled, each.sameNameAs]),
        [
            [join(project, ".pi/skills/release/SKILL.md"), "project", true, undefined],
            [
                join(shared, "skills/release/SKILL.md"),
                "shared",
                false,
                join(project, ".pi/skills/release/SKILL.md"),
            ],
        ],
    );
    assert.deepEqual(
        list.extensions.map((each) => [each.path, each.scope]),
        [
            [join(project, ".pi/extensions/local.ts"), "project"],
            [join(shared, "extensions/note.ts"), "shared"],
        ],
    );
    const docs = list.mcp.find((each) => each.name === "docs")!;

    assert.equal(docs.enabled, false);
    assert.equal(docs.file, join(shared, "mcp.json"));
    assert.equal(docs.override, join(project, ".pi/mcp.json"));
    assert.equal(list.mcp.find((each) => each.name === "local")!.target, "/bin/echo .");
    assert.ok(
        list.scanned.skills.some(
            (each) => each.path === join(project, ".agents/skills") && !each.exists,
        ),
    );
});

test("every session's bundled extensions are listed as the launcher passes them, not only the files", async (t) => {
    const { root, shared } = fixture();

    t.after(() => rmSync(root, { recursive: true, force: true }));
    const { bundled } = await listAgentResources(shared);
    const extensions = Object.fromEntries(bundled.extensions.map((each) => [each.name, each]));

    assert.equal(
        bundled.version,
        JSON.parse(readFileSync(join(product, "package.json"), "utf8")).version,
    );
    assert.deepEqual(
        bundled.extensions.map((each) => [each.from, each.name]),
        [
            ["rotom", "observability"],
            ["rotom", "browser"],
            ["rotom", "coding-policy"],
            ["rotom", "third-party"],
            ["rotom", "qoder"],
            ["team", "rotom-skills"],
            ["team", "rotom-policy"],
            ["pi", "llama.cpp"],
            ["pi", "tool-search"],
            ["pi", "mcp"],
        ],
        "Codemode comes from the product's third-party extension, not Pi's built-in",
    );
    assert.equal(extensions["browser"]!.path, join(product, "extensions/browser/index.ts"));
    assert.equal(extensions["third-party"]!.path, join(product, "extensions/third-party"));
    assert.ok(extensions["third-party"]!.packages!.includes("pi-subagents"));
    assert.equal(extensions["rotom-skills"]!.path, teamSkillsExtension);
    assert.equal(extensions["rotom-policy"]!.path, teamPolicyExtension);
    assert.equal(extensions["mcp"]!.path, "builtin:mcp");

    for (const each of bundled.extensions.filter((extension) => extension.from !== "pi")) {
        assert.ok(existsSync(each.path), each.path);
    }
});

test("a settings file that does not parse is reported, not hidden", async (t) => {
    const { root, shared, project } = fixture();

    t.after(() => rmSync(root, { recursive: true, force: true }));
    put(join(project, ".pi/settings.json"), "{ not json");
    const list = await listAgentResources(shared, project);

    assert.equal(list.problems.length, 1);
    assert.match(list.problems[0]!, /\.pi\/settings\.json/);
});

test("the API lists a project only for people who may view it, on a Team server", async (t) => {
    const dataDir = join(realpathSync(testRoot), "agent-resources-api");
    const project = realpathSync(work);
    const app = await PocketApp.open({
        dataDir,
        defaultCwd: project,
        supervised: false,
        kernel: true,
        browser: null,
        log: () => {},
        configureUserModels: (models) => models.registerNativeProvider(scriptedModel().provider),
    });
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    t.after(async () => {
        server.close();
        await app.close();
    });
    put(join(project, "AGENTS.md"), "project");
    const member = app.config.addUser("Member", "guest");
    const { id } = app.projects.save(
        owner(app),
        { name: "work", cwd: project, members: {} },
        (each) => app.config.userById(each) !== undefined,
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const get = (token: string, query = "") =>
        fetch(`http://127.0.0.1:${port}/api/agent-resources${query}`, {
            headers: { authorization: `Bearer ${token}` },
        });
    const listed = await get(app.config.ownerToken, `?project=${id}`);

    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json()).instructions, [
        { path: join(project, "AGENTS.md"), scope: "project" },
    ]);
    assert.equal((await get(member.token, `?project=${id}`)).status, 404);
    assert.equal((await get(member.token)).status, 200);
});
