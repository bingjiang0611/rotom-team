// The message box's helpers on the server: `!` commands, mentioned files sent along, skills, the file viewer, undoing a
// file from Changes, and session titles.
import {
    type App,
    cleanUp,
    lastText,
    seedHistoricalSession,
    openApp,
    owner,
    root,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { mentionedPaths } from "../src/server/files.ts";
import { cleanTitle, TITLE_PROMPT, titleModel, wantsTitle } from "../src/server/titles.ts";

/** Echoes, except that it names sessions when asked to. */
const route: FauxResponseStep = (request) => {
    const { text } = lastText(request as never);

    if (text.startsWith(TITLE_PROMPT)) {
        return fauxAssistantMessage([fauxText('"Tidy The Release Script."')]);
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let app: App;
const folder = join(root, "qol");

before(async () => {
    mkdirSync(folder, { recursive: true });
    app = await openApp(scriptedModel(route), join(root, "qol-data"));
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("legacy archive rejects shell, mention, skill, and restart execution without side effects", async () => {
    const id = await seedHistoricalSession(app, folder);
    const marker = join(folder, "runs.txt");

    await assert.rejects(
        app.shell.start(id, owner(app), { command: `echo run >> ${marker}` }),
        /read-only archive/,
    );
    await assert.rejects(
        app.commands.submit(id, owner(app), {
            text: "Check @plan.md",
            requestId: "qol-archive",
            inlineFiles: true,
        }),
        /read-only archive/,
    );
    assert.equal(existsSync(marker), false);
    const skill = join(process.env.PI_CODING_AGENT_DIR!, "skills", "deploy");

    mkdirSync(skill, { recursive: true });
    writeFileSync(
        join(skill, "SKILL.md"),
        "---\nname: deploy\ndescription: Ship the app\n---\nRun deploy.\n",
    );
    assert.deepEqual(
        (await app.skillCommands(id)).map(({ name, description }) => ({ name, description })),
        [{ name: "deploy", description: "Ship the app" }],
    );
    await assert.rejects(
        app.commands.submit(id, owner(app), { text: "/skill:deploy", requestId: "skill-archive" }),
        /read-only archive/,
    );
    assert.deepEqual(mentionedPaths('see @a.ts, @"my notes.md" and me@x.com (@b/c.js)'), [
        { written: "a.ts,", candidates: ["a.ts,", "a.ts"] },
        { written: "my notes.md", candidates: ["my notes.md"] },
        { written: "b/c.js)", candidates: ["b/c.js)", "b/c.js"] },
    ]);
});

test("only the owner may read Pi's folder and the app's data, but anyone who steers may read uploads", async () => {
    const id = await seedHistoricalSession(app, folder);
    const { user: guest } = app.config.addUser("Guest", "guest");

    try {
        const agentFile = join(process.env.PI_CODING_AGENT_DIR!, "settings-test.json");

        writeFileSync(agentFile, "{}");
        await assert.rejects(
            app.workspace.viewFile(id, guest, agentFile),
            /outside.*readable locations/,
        );
        await assert.rejects(
            app.workspace.viewFile(id, guest, join(app.dataDir, "config.json")),
            /outside.*readable locations/,
        );
        assert.equal((await app.workspace.viewFile(id, owner(app), agentFile)).kind, "text");
        mkdirSync(app.workspace.uploadDirectory(id), { recursive: true });
        writeFileSync(join(app.workspace.uploadDirectory(id), "shared.txt"), "hi");
        assert.equal(
            (
                await app.workspace.viewFile(
                    id,
                    guest,
                    join(app.workspace.uploadDirectory(id), "shared.txt"),
                )
            ).kind,
            "text",
        );
    } finally {
        app.config.removeUser(guest.id);
    }
});

test("the viewer shows text, folders, images, and binary files, and says when a file is not there", async () => {
    const id = await seedHistoricalSession(app, folder);

    mkdirSync(join(folder, "docs"), { recursive: true });
    writeFileSync(join(folder, "docs", "a.md"), "alpha\n");
    writeFileSync(join(folder, "blob.bin"), Buffer.from([1, 0, 2, 3]));
    writeFileSync(join(folder, "shot.png"), "not really a png");
    const me = owner(app);

    assert.deepEqual(await app.workspace.viewFile(id, me, "docs/a.md"), {
        path: join(folder, "docs", "a.md"),
        display: "docs/a.md",
        kind: "text",
        size: 6,
        text: "alpha\n",
        truncated: false,
    });
    assert.deepEqual(
        (await app.workspace.viewFile(id, me, "docs")).kind === "folder" &&
            (await app.workspace.viewFile(id, me, "docs")),
        {
            path: join(folder, "docs"),
            display: "docs",
            kind: "folder",
            entries: [{ name: "a.md", dir: false }],
            truncated: false,
        },
    );
    assert.equal((await app.workspace.viewFile(id, me, "blob.bin")).kind, "binary");
    assert.equal((await app.workspace.viewFile(id, me, "shot.png")).kind, "image");
    execFileSync("mkfifo", [join(folder, "pipe")]);
    assert.equal(
        (await app.workspace.viewFile(id, me, "pipe")).kind,
        "other",
        "a pipe is not opened",
    );
    mkdirSync(join(folder, "many"), { recursive: true });

    for (let index = 0; index < 1100; index++) {
        writeFileSync(join(folder, "many", `f${index}.txt`), "");
    }

    const many = await app.workspace.viewFile(id, me, "many");

    assert.equal(many.kind === "folder" && many.entries.length, 1000);
    assert.equal(many.kind === "folder" && many.truncated, true);
    await assert.rejects(app.workspace.viewFile(id, me, "nope.txt"), /nope\.txt is not there/);
});

test("archive Changes mutation is rejected and leaves the repository unchanged", async () => {
    const repo = join(root, "qol-repo");

    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    writeFileSync(join(repo, "keep.txt"), "one\n");
    git("add", "-A");
    git("commit", "-qm", "init");
    writeFileSync(join(repo, "keep.txt"), "changed\n");
    const id = await seedHistoricalSession(app, repo);

    await assert.rejects(
        app.workspace.revertChange(id, owner(app), "keep.txt"),
        /read-only archive/,
    );
    assert.equal(readFileSync(join(repo, "keep.txt"), "utf8"), "changed\n");
    assert.notEqual(git("status", "--porcelain"), "");
});

test("title parsing remains readable while legacy message title mutation is rejected", async () => {
    assert.equal(wantsTitle("fix the login bug"), false);
    assert.equal(wantsTitle("please look at the release script and tidy it up for me"), true);
    assert.equal(wantsTitle("one\ntwo"), true);
    assert.equal(cleanTitle('Title: "Fix the login flow."\nmore'), "Fix the login flow");
    assert.equal(cleanTitle("  \n"), undefined);
    const model = (id: string, provider = "p", cost = 1) =>
        ({ id, provider, input: ["text"], cost: { input: cost, output: cost } }) as never;

    assert.equal(
        titleModel(
            [
                model("big"),
                model("big-mini", "p", 0.5),
                model("gemini-pro"),
                model("other-haiku", "q"),
            ],
            model("big"),
        ).id,
        "big-mini",
    );
    assert.equal(titleModel([model("gemini-pro")], model("big")).id, "big");

    const id = await seedHistoricalSession(app, folder);

    await assert.rejects(
        app.commands.submit(id, owner(app), {
            text: "please look at the release script and tidy it up so the tags come out right",
            requestId: "title-archive",
        }),
        /read-only archive/,
    );
    assert.equal(app.sessionMeta(id)?.title, "Historical test session");
});
