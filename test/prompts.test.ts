// Pi's prompt templates as slash commands: where they load from, how arguments fill them, and sending one.
import {
    type App,
    cleanUp,
    context,
    openApp,
    owner,
    root,
    scriptedModel,
    seedHistoricalSession,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
    expandPromptTemplate,
    fillTemplate,
    loadPromptTemplates,
    loadSkillCommands,
    parseArguments,
} from "../src/server/prompts.ts";

test("arguments split at spaces outside quotes, and fill every kind of placeholder", () => {
    assert.deepEqual(parseArguments(`a "b c" 'd e'  f`), ["a", "b c", "d e", "f"]);
    const args = ["one", "two", "three"];

    assert.equal(fillTemplate("$1 and $2, $4.", args), "one and two, .");
    assert.equal(fillTemplate("all: $@ / $ARGUMENTS", args), "all: one two three / one two three");
    assert.equal(fillTemplate("${2:-x} ${4:-four} ${@:-none}", args), "two four one two three");
    assert.equal(fillTemplate("${@:-none}", []), "none");
    assert.equal(
        fillTemplate("${@:2} | ${@:1:2} | ${@:0}", args),
        "two three | one two | one two three",
    );
    assert.equal(fillTemplate("$1", ["$2"]), "$2", "values are not filled in again");
});

test("only a known template name expands", () => {
    const templates = [
        { name: "review", description: "", content: "Review $1 for $2", path: "/x/review.md" },
    ];

    assert.equal(
        expandPromptTemplate("/review src/a.ts bugs", templates),
        "Review src/a.ts for bugs",
    );
    assert.equal(expandPromptTemplate("/review", templates), "Review  for ");
    assert.equal(expandPromptTemplate("/etc/hosts is odd", templates), undefined);
    assert.equal(expandPromptTemplate("review src", templates), undefined);
});

test("templates load from Pi's folder, the project, and Pi's settings, first of each name", () => {
    const agentDir = join(root, "templates-agent");
    const project = join(root, "templates-project");
    const extra = join(root, "templates-extra");

    for (const directory of [join(agentDir, "prompts"), join(project, ".pi", "prompts"), extra]) {
        mkdirSync(directory, { recursive: true });
    }

    writeFileSync(
        join(agentDir, "prompts", "review.md"),
        "---\ndescription: Review a file\nargument-hint: <file>\n---\nReview $1 carefully.",
    );
    writeFileSync(
        join(project, ".pi", "prompts", "review.md"),
        "The project's review, shadowed by Pi's own.",
    );
    writeFileSync(
        join(project, ".pi", "prompts", "ship.md"),
        "\n\nShip it: run the tests, then tag a release with a long first line here",
    );
    writeFileSync(join(project, ".pi", "prompts", "notes.txt"), "not a template");
    writeFileSync(join(extra, "explain.md"), "Explain $@");
    const templates = loadPromptTemplates(project, agentDir, [extra, join(root, "missing")]);

    assert.deepEqual(
        templates.map(({ name, description, argumentHint }) => ({
            name,
            description,
            argumentHint,
        })),
        [
            { name: "review", description: "Review a file", argumentHint: "<file>" },
            {
                name: "ship",
                description: "Ship it: run the tests, then tag a release with a long first...",
                argumentHint: undefined,
            },
            { name: "explain", description: "Explain $@", argumentHint: undefined },
        ],
    );
    assert.equal(templates[0]!.content, "Review $1 carefully.");
});

test("native skill suggestions omit personal defaults while Durable keeps them", () => {
    const agentDir = join(root, "skill-command-agent");
    const project = join(root, "skill-command-project");
    const projectSkills = join(project, ".pi/skills");

    for (const [directory, name] of [
        [join(agentDir, "skills/personal"), "personal"],
        [join(projectSkills, "project"), "project"],
    ] as const) {
        mkdirSync(directory, { recursive: true });
        writeFileSync(
            join(directory, "SKILL.md"),
            `---\nname: ${name}\ndescription: ${name} skill\n---\nSkill instructions.\n`,
        );
    }

    assert.deepEqual(
        loadSkillCommands(project, agentDir, []).map((skill) => skill.name),
        ["personal", "project"],
    );
    assert.deepEqual(
        loadSkillCommands(project, agentDir, [projectSkills], false).map((skill) => skill.name),
        ["project"],
    );
});

let app: App;

before(async () => {
    mkdirSync(join(process.env.PI_CODING_AGENT_DIR!, "prompts"), { recursive: true });
    writeFileSync(
        join(process.env.PI_CODING_AGENT_DIR!, "prompts", "fix.md"),
        "---\ndescription: Fix an issue\n---\nFix issue $1. Keep the change small.",
    );
    mkdirSync(join(work, ".pi", "prompts"), { recursive: true });
    writeFileSync(join(work, ".pi", "prompts", "tidy.md"), "Tidy up $@");
    app = await openApp(scriptedModel());
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("a session offers its folder's templates, and sending one sends it filled in", async () => {
    const id = await seedHistoricalSession(app);

    assert.deepEqual(
        app.promptTemplates(id).map((template) => template.name),
        ["fix", "tidy"],
    );
    const before = await (await app.harness.conversation(id, context))!.entries(
        {},
        10,
        undefined,
        context,
    );

    await assert.rejects(
        app.commands.submit(id, owner(app), { text: "/fix 42", requestId: "t1" }),
        /read-only archive/,
    );
    await assert.rejects(
        app.commands.submit(id, owner(app), { text: "/nothing here", requestId: "t2" }),
        /read-only archive/,
    );
    const after = await (await app.harness.conversation(id, context))!.entries(
        {},
        10,
        undefined,
        context,
    );

    assert.deepEqual(after, before);
});
