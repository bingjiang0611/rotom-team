// End-to-end tests of the server core with a scripted model: no network, no API keys, no Pi config.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    lastText,
    openApp,
    owner as ownerOf,
    root,
    say as sayTo,
    scriptedModel,
    seedHistoricalSession as startSession,
    appendHistoricalTurn,
    until,
    work,
    noInferenceModels,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, mock, test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { Attachment } from "../src/server/commands.ts";
import { PocketApp } from "../src/server/app.ts";
import { NATIVE_ENTRY } from "../src/server/entry-format.ts";
import { ChatDoc } from "../src/server/docs.ts";

/** The provider session id each request carried, with the message it answered. */
const requests: { sessionId: string | undefined; text: string }[] = [];

/** One scripted model for every conversation, answering by the last message, like a tiny real model. */
const route: FauxResponseStep = (context, options) => {
    const { role, text } = lastText(context as never);

    requests.push({ sessionId: (options as { sessionId?: string } | undefined)?.sessionId, text });
    const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
        fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`tool said: ${text}`)]);
    }

    if (text.includes("make an artifact")) {
        return call("artifact", { id: "Demo Page", title: "Demo", content: "<h1>one</h1>" });
    }

    if (text.includes("fix the artifact")) {
        return call("artifact", {
            id: "demo-page",
            title: "Demo",
            edits: [{ oldText: "one", newText: "two" }],
        });
    }

    if (text.includes("start a helper")) {
        return call("subagent", { action: "spawn", name: "helper", message: "say hi please" });
    }

    if (text.includes("run a script")) {
        return call("codemode", {
            code: 'for (const body of ["<p>one</p>", "<p>two</p>"]) await tools.artifact({ id: "notes", title: "Notes", content: body });\nreturn await tools.read({ path: "hello.txt" });',
        });
    }

    if (text.includes("say hi please")) {
        return fauxAssistantMessage([fauxText("hi from helper")]);
    }

    if (text.startsWith("[subagent helper answered")) {
        return fauxAssistantMessage([fauxText("noted")]);
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

const faux = scriptedModel(route);

/** A valid RGB PNG used to prove the native model-image resize path. */
function greyPng(width: number, height: number): Buffer {
    const chunk = (type: string, data: Buffer) => {
        const body = Buffer.concat([Buffer.from(type), data]);
        const frame = Buffer.alloc(8);

        frame.writeUInt32BE(data.length, 0);
        frame.writeUInt32BE(crc32(body), 4);

        return Buffer.concat([frame.subarray(0, 4), body, frame.subarray(4)]);
    };

    const header = Buffer.alloc(13);

    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([8, 2], 8);
    const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);

    return Buffer.concat([
        Buffer.from("89504e470d0a1a0a", "hex"),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

let app: App;
const open = () => openApp(faux);
const owner = () => ownerOf(app);
const newSession = () => seedHistoricalSession();
let nativeSerial = 0;

const openNativeApp = () => {
    const dataDir = join(realpathSync(root), `app-native-${++nativeSerial}`);

    mkdirSync(dataDir, { mode: 0o700 });

    return PocketApp.open({
        dataDir: realpathSync(dataDir),
        defaultCwd: realpathSync(work),
        supervised: false,
        kernel: true,
        browser: null,
        log: () => {},
        configureUserModels: noInferenceModels,
    });
};

const seedHistoricalSession = () => startSession(app);
const say = (id: ConversationId, text: string, attachments?: Attachment[]) =>
    sayTo(app, id, text, attachments);

before(async () => {
    app = await open();
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("a historical session keeps its stored title and rejects a new title", async () => {
    const id = await seedHistoricalSession();
    const before = (await app.sessions()).find((each) => each.id === Number(id));

    await assert.rejects(say(id, "hello there"), /read-only archive/);
    assert.equal(
        (await app.sessions()).find((each) => each.id === Number(id))?.title,
        before?.title,
    );
    assert.equal(before?.cwd, work);
});

test("native loopback submission sets the title and delivers an uploaded image", async () => {
    const { createServer } = await import("node:http");
    const { once } = await import("node:events");
    const requests: string[] = [];
    const model = createServer(async (request, response) => {
        let body = "";

        for await (const chunk of request) {
            body += String(chunk);
        }

        requests.push(body);
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(
            `data: ${JSON.stringify({ id: "app-loopback", object: "chat.completion.chunk", created: 1, model: "app-loopback", choices: [{ index: 0, delta: { role: "assistant", content: "Loopback reply" }, finish_reason: null }] })}\\n\\ndata: ${JSON.stringify({ id: "app-loopback", object: "chat.completion.chunk", created: 1, model: "app-loopback", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\\n\\ndata: [DONE]\\n\\n`,
        );
    });

    model.listen(0, "127.0.0.1");
    await once(model, "listening");
    const baseUrl = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;
    const dataDir = join(realpathSync(root), "app-loopback");

    mkdirSync(dataDir, { mode: 0o700 });
    const native = await PocketApp.open({
        dataDir: realpathSync(dataDir),
        defaultCwd: realpathSync(work),
        kernel: true,
        supervised: false,
        browser: null,
        log: () => {},
        configureUserModels: (models, user) =>
            models.registerNativeProvider({
                id: "openai",
                name: "App loopback",
                auth: {
                    apiKey: {
                        name: "Synthetic",
                        resolve: async () => ({
                            auth: { apiKey: `app:${user.id}` },
                            source: "test",
                        }),
                    },
                },
                getModels: () => [
                    {
                        id: "app-loopback",
                        name: "app-loopback",
                        api: "openai-completions",
                        provider: "openai",
                        baseUrl,
                        reasoning: false,
                        input: ["text", "image"],
                        contextWindow: 32_000,
                        maxTokens: 1024,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    },
                ],
                stream: () => {
                    throw new Error("native kernel owns this stream");
                },
                streamSimple: () => {
                    throw new Error("native kernel owns this stream");
                },
            }),
    });

    try {
        const member = native.config.users.find((user) => user.role === "owner")!;
        const id = (await native.commands.createSession(member, { backend: "rotom" })).id;

        await native.kernel!.chooseModel(
            id,
            member,
            { model: { provider: "openai", modelId: "app-loopback" } },
            "model-1",
        );
        const imagePath = join(native.workspace.uploadDirectory(id), "uploaded.png");
        const image = greyPng(10, 3000);

        writeFileSync(imagePath, image);
        const result = await native.kernel!.submit(
            id,
            member,
            "app-submit-1",
            "hello title",
            true,
            [{ path: imagePath, name: "uploaded.png", mime: "image/png", size: image.length }],
        );

        assert.equal(result.status, "settled");
        assert.equal(
            (await native.sessions()).find((session) => session.id === Number(id))?.title,
            "hello title",
        );
        assert.equal(requests.length, 1);
        const sent = JSON.parse(requests[0]!) as { messages: { content: unknown }[] };
        const content = JSON.stringify(sent.messages.at(-1)?.content);
        const encoded = /base64,([^\\\"]+)/.exec(content)?.[1];

        assert.ok(encoded, "the submitted native turn includes model image data");
        const resized = Buffer.from(encoded!, "base64");

        assert.equal(resized.readUInt32BE(20), 2000, "native model image is bounded to 2000px");
    } finally {
        await native.close();
        model.close();
    }
});

test("archived artifact execution is rejected and no body is published", async () => {
    const id = await seedHistoricalSession();

    await assert.rejects(say(id, "please make an artifact"), /read-only archive/);
    await assert.rejects(app.artifactBody(id, "demo-page", undefined), { status: 404 });
});

test("the page that runs a reply's HTML is for people signed in, sandboxed, and runs only what the app sends it", async () => {
    const { createServer } = await import("node:http");
    const { createHandler } = await import("../src/server/http.ts");
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/a/frame`;

    try {
        assert.equal((await fetch(url)).status, 401);
        const response = await fetch(url, {
            headers: { authorization: `Bearer ${app.config.ownerToken}` },
        });
        const body = await response.text();

        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
        // An opaque origin even when opened in a tab of its own: no cookies, no app.
        assert.match(
            response.headers.get("content-security-policy") ?? "",
            /^sandbox allow-scripts /,
        );
        assert.doesNotMatch(
            response.headers.get("content-security-policy") ?? "",
            /allow-same-origin/,
        );
        assert.ok(body.includes('self.origin !== "null"'), "it runs nothing outside a sandbox");
        assert.ok(
            body.includes("event.source !== window.parent"),
            "it takes HTML from its parent only",
        );
        assert.ok(
            body.includes("event.origin !== location.origin"),
            "a parent at the app's address",
        );
    } finally {
        server.closeAllConnections();
        server.close();
    }
});

test("archive submissions never call a provider route", async () => {
    const first = await seedHistoricalSession();
    const second = await seedHistoricalSession();
    const count = requests.length;

    await assert.rejects(say(first, "session id one"), /read-only archive/);
    await assert.rejects(say(second, "session id two"), /read-only archive/);
    assert.equal(requests.length, count);
});

test("personal sign-in has a stable member-scoped device identity, not the host Pi identity", async () => {
    const calls: unknown[][] = [];
    const { runtime } = await app.accounts.forUser(owner());
    const login = runtime.login;
    const tab = fakeTab(undefined, owner());

    await app.attach(tab.client);
    runtime.login = (async (...args: unknown[]) => {
        calls.push(args);

        return {} as never;
    }) as typeof login;

    try {
        for (let index = 0; index < 2; index++) {
            const flow = await app.providers.startLogin(owner(), "openai", "oauth");

            await until(
                () =>
                    tab.events.some(
                        (event) =>
                            event.event === "auth" &&
                            event.data.flowId === flow &&
                            event.data.step === "done",
                    ),
                "sign-in synchronization",
            );
        }

        const ids = calls.map((args) => (args[3] as { getDeviceId: () => string }).getDeviceId());

        assert.equal(ids.length, 2);
        assert.equal(ids[0], owner().id);
        assert.equal(ids[1], ids[0]);
    } finally {
        runtime.login = login;
        app.detach(tab.client);
    }
});

test("archived codemode requests reject without artifacts or file reads", async () => {
    const id = await seedHistoricalSession();

    await assert.rejects(say(id, "please run a script"), /read-only archive/);
    await assert.rejects(app.artifactBody(id, "notes", undefined), { status: 404 });
});

test("archived subagent requests reject without creating a child", async () => {
    const id = await seedHistoricalSession();

    await assert.rejects(say(id, "start a helper"), /read-only archive/);
    const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
    const doc = await app.harness.conversation(id, BACKGROUND_CONTEXT);

    assert.equal(
        (await doc?.context(BACKGROUND_CONTEXT))?.messages.some((message) =>
            JSON.stringify(message.content).includes("helper"),
        ),
        false,
    );
});

test("archive image attachment rejects writes while path access remains scoped", async () => {
    const id = await seedHistoricalSession();
    const path = join(app.workspace.uploadDirectory(id), "dot.png");
    const png = Buffer.from("89504e470d0a1a0a", "hex");

    writeFileSync(path, png);

    await assert.rejects(say(id, "look at this"), /read-only archive/);
    assert.equal(await app.workspace.conversationPath(id, "chart.png"), join(work, "chart.png"));
    assert.equal(await app.workspace.conversationPath(id, "/tmp/chart.png"), "/tmp/chart.png");
    assert.equal((await app.harness.conversation(id, context)) !== undefined, true);
});

test("archive oversized image configuration is rejected before model access", async () => {
    const id = await seedHistoricalSession();

    await assert.rejects(say(id, "large image"), /read-only archive/);
    assert.equal(app.isBusy(id), false);
});

test("long polling preserves hello/session ordering, replay, ACKs, and close", async () => {
    const { createServer } = await import("node:http");
    const { createHandler } = await import("../src/server/http.ts");
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    type Poll = { session: string; events: { seq: number; event: string }[] };
    const poll = async (query: string): Promise<Poll> =>
        (
            await fetch(`http://127.0.0.1:${port}/api/poll?${query}`, {
                headers: { authorization: `Bearer ${app.config.ownerToken}` },
            })
        ).json() as Promise<Poll>;

    try {
        const id = await seedHistoricalSession();
        const first = await poll(`tab=t1&c=${id}`);

        assert.deepEqual(
            first.events.slice(0, 2).map((each) => each.event),
            ["hello", "sessions"],
        );
        assert.ok(first.events.some((each) => each.event === "view"));
        const again = await poll(`tab=t1&c=${id}&session=${first.session}&ack=0`);

        assert.deepEqual(
            again.events.slice(0, first.events.length).map((each) => each.seq),
            first.events.map((each) => each.seq),
        );
        const ack = first.events.at(-1)!.seq;
        const closed = await poll(`session=${first.session}&close=1`);

        assert.equal(closed.events?.length ?? 0, 0);
        const fresh = await poll(`tab=t1&c=${id}&session=${first.session}&ack=${ack}`);

        assert.notEqual(fresh.session, first.session);
        await poll(`session=${fresh.session}&close=1`);
    } finally {
        server.closeAllConnections();
        server.close();
    }
});

test("legacy service extension access remains unavailable in archive mode", async () => {
    await assert.rejects(app.extensions(owner()), { status: 404 });
});

test("everyone signed in gets the desktop's theme colors; only the owner gets its wallpaper", async () => {
    const { createServer } = await import("node:http");
    const { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createHandler } = await import("../src/server/http.ts");
    const home = mkdtempSync(join(tmpdir(), "pocket-desktop-"));
    const current = join(home, ".local/state/omarchy/current");

    mkdirSync(join(current, "theme"), { recursive: true });
    writeFileSync(
        join(current, "theme", "colors.toml"),
        'background = "#111111"\nforeground = "#eeeeee"\n',
    );
    writeFileSync(join(current, "theme.name"), "gruvbox\n");
    // A real PNG header, so the image check accepts it.
    writeFileSync(
        join(current, "theme", "wall.png"),
        Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
    );
    let hasWallpaper = true;

    try {
        symlinkSync(join(current, "theme", "wall.png"), join(current, "background"), "file");
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;

        if (process.platform !== "win32" || (code !== "EPERM" && code !== "EACCES")) {
            throw error;
        }

        hasWallpaper = false;
    }

    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const guest = app.config.addUser("Guest", "guest");
    const call = (token: string, path: string) =>
        fetch(`http://127.0.0.1:${port}/api/${path}`, {
            headers: { authorization: `Bearer ${token}` },
        });
    const realHome = process.env.HOME;
    const realUserProfile = process.env.USERPROFILE;

    process.env.HOME = home;
    process.env.USERPROFILE = home;

    try {
        type Theme = { theme: { name: string; wallpaper: boolean; stamp: string } };
        const owner = (await (await call(app.config.ownerToken, "theme")).json()) as Theme;

        assert.equal(owner.theme.name, "gruvbox");
        assert.equal(owner.theme.wallpaper, hasWallpaper);
        assert.ok(!owner.theme.stamp.includes(home), "the stamp names no paths");
        const theirs = (await (await call(guest.token, "theme")).json()) as Theme;

        assert.equal(theirs.theme.name, "gruvbox");
        assert.equal(theirs.theme.wallpaper, false);
        assert.equal((await call(guest.token, "theme/wallpaper")).status, 403);
        assert.equal(
            (await call(app.config.ownerToken, "theme/wallpaper")).status,
            hasWallpaper ? 200 : 404,
        );
    } finally {
        if (realHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = realHome;
        }

        if (realUserProfile === undefined) {
            delete process.env.USERPROFILE;
        } else {
            process.env.USERPROFILE = realUserProfile;
        }

        app.config.removeUser(guest.user.id);
        server.closeAllConnections();
        server.close();
    }
});

test("extension routes remain unavailable to archive sessions", async () => {
    const id = await seedHistoricalSession();

    await assert.rejects(
        app.commands.submit(id, owner(), { text: "extension", requestId: "extension-archive" }),
        /read-only archive/,
    );
    await assert.rejects(app.extensions(owner()), { status: 404 });
});

test("extension routes remain unavailable to archive sessions", async () => {
    const id = await seedHistoricalSession();

    await assert.rejects(
        app.commands.submit(id, owner(), { text: "extension", requestId: "extension-archive" }),
        /read-only archive/,
    );
    assert.equal(await app.extensions(owner()).catch((error) => error.status), 404);
});

test("native chat supports presence, typing, deduplication, pins, grants, and reopen", async () => {
    const dataDir = join(realpathSync(root), "app-native-chat");

    mkdirSync(dataDir, { mode: 0o700 });
    let native = await PocketApp.open({
        dataDir: realpathSync(dataDir),
        defaultCwd: realpathSync(work),
        supervised: false,
        kernel: true,
        browser: null,
        log: () => {},
        configureUserModels: noInferenceModels,
    });

    try {
        const member = native.config.users.find((user) => user.role === "owner")!;
        const guest = native.config.addUser("Native guest", "guest").user;
        const id = (await native.commands.createSession(member, { backend: "rotom" })).id;
        const tab = fakeTab(id, member);

        await native.attach(tab.client);
        await assert.rejects(
            native.collab.postChat(id, member, { text: "", requestId: "native-empty" }),
            { status: 400 },
        );
        await assert.rejects(
            native.collab.postChat(id, member, {
                text: "x".repeat(20_001),
                requestId: "native-long",
            }),
            { status: 413 },
        );
        native.collab.setTyping(id, member, "chat");
        const first = await native.collab.postChat(id, member, {
            text: "native @Native guest",
            requestId: "native-chat-1",
        });
        const duplicate = await native.collab.postChat(id, member, {
            text: "native @Native guest",
            requestId: "native-chat-1",
        });

        assert.equal(duplicate.id, first.id);
        assert.deepEqual((await native.collab.pin(id, member, { chatId: first.id })).pinned, true);
        const entry = await native.harness.commit(
            (tx) =>
                tx.appendEntry(id, {
                    kind: "pi.user",
                    model: [{ role: "user", content: "native transcript", timestamp: Date.now() }],
                }),
            context,
        );

        await native.collab.react(id, member, Number(entry.id), "👍");
        native.setAccess(member, guest.id, { role: "viewer", sessions: [String(id)] });
        await native.collab.postChat(id, guest, {
            text: "viewer chat",
            requestId: "native-chat-2",
        });
        assert.equal(
            tab.events.some((event) => event.event === "presence"),
            true,
        );
        native.detach(tab.client);
        await native.close();
        native = await PocketApp.open({
            dataDir: realpathSync(dataDir),
            defaultCwd: realpathSync(work),
            supervised: false,
            kernel: true,
            browser: null,
            log: () => {},
            configureUserModels: noInferenceModels,
        });
        const chat = await native.harness.snapshot(ChatDoc, id, context);

        assert.equal(chat?.messages.length, 3);
        assert.equal(chat?.messages[0]?.text, "native @Native guest");
    } finally {
        await native.close();
    }
});

test("archive chat rejects writes while history remains readable", async () => {
    const id = await seedHistoricalSession();

    await assert.rejects(
        app.collab.postChat(id, owner(), { text: "hello", requestId: "chat-archive" }),
        /read-only archive/,
    );
    assert.ok(await app.conversation(id));
});

test("archive steering rejects without weakening access checks", async () => {
    const id = await seedHistoricalSession();
    const viewer = app.config.addUser("Archive viewer", "viewer").user;

    await assert.rejects(
        app.commands.submit(id, viewer, { text: "steer", requestId: "archive-viewer" }),
        /read-only archive/,
    );
    await assert.rejects(
        app.commands.submit(id, owner(), { text: "steer", requestId: "archive-owner" }),
        /read-only archive/,
    );
});

test("archive turn-taking mutation rejects without activity", async () => {
    const id = await seedHistoricalSession();

    await assert.rejects(app.collab.turns(id, owner(), { action: "ask" }), /read-only archive/);
});

test("a tab that closes while it is attaching is never counted as there", async () => {
    const id = await seedHistoricalSession();
    const gone = fakeTab(id, owner());
    const attaching = app.attach(gone.client);

    app.detach(gone.client);
    await attaching;
    const here = fakeTab(id, owner());

    try {
        await app.attach(here.client);
        const people = (here.last("presence")?.people ?? []) as { id: string; tabs: number }[];

        assert.deepEqual(
            people.map((person) => [person.id, person.tabs]),
            [[owner().id, 1]],
        );
        assert.equal(
            gone.events.some((each) => each.event === "view"),
            false,
            "the closed tab got no view",
        );
    } finally {
        app.detach(here.client);
    }
});

test("requests with the wrong types are refused, and nothing odd is stored", async () => {
    const native = await openNativeApp();
    const member = native.config.users.find((user) => user.role === "owner")!;

    try {
        const id = (await native.commands.createSession(member, { backend: "rotom" })).id;

        await assert.rejects(
            native.commands.updateSession(id, member, { archived: "yes" as never }),
            /archived must be true or false/,
        );
        await assert.rejects(
            native.commands.updateSession(id, member, { title: 5 as never }),
            /title must be text/,
        );
        await assert.rejects(
            native.commands.createSession(member, { cwd: 5 as never }),
            /cwd must be text/,
        );
        assert.equal(
            (await native.sessions()).find((each) => each.id === Number(id))?.archived,
            undefined,
        );
    } finally {
        await native.close();
    }
});

test("archiving leaves a session where it was in the list, and so does bringing it back; renaming moves it up", async () => {
    const app = await openNativeApp();
    const owner = () => app.config.users.find((user) => user.role === "owner")!;
    const newSession = async () =>
        (await app.commands.createSession(owner(), { backend: "rotom" })).id;

    try {
        const id = await newSession();
        const meta = async () => (await app.sessions()).find((each) => each.id === Number(id))!;
        const before = (await meta()).updatedAt;

        await new Promise((resolve) => setTimeout(resolve, 5));
        await app.commands.updateSession(id, owner(), { archived: true });
        assert.equal((await meta()).archived, true);
        assert.equal((await meta()).updatedAt, before);
        await app.commands.updateSession(id, owner(), { archived: false });
        assert.equal((await meta()).archived, false);
        assert.equal((await meta()).updatedAt, before);
        await app.commands.updateSession(id, owner(), { title: "Moved up" });
        assert.ok((await meta()).updatedAt > before);
    } finally {
        await app.close();
    }
});

test("archive metadata cannot be renamed or archived", async () => {
    const id = await seedHistoricalSession();

    await assert.rejects(
        app.commands.updateSession(id, owner(), { title: "changed" }),
        /read-only archive/,
    );
    await assert.rejects(
        app.commands.updateSession(id, owner(), { archived: true }),
        /read-only archive/,
    );
});

test("a lock left by a process that is gone, or is not Node, is taken over; a running server's is not", async () => {
    const { spawn } = await import("node:child_process");
    const { once } = await import("node:events");
    const dataDir = join(root, "locks");

    mkdirSync(dataDir, { recursive: true });
    const lock = join(dataDir, "harness.lock");
    const openHere = () => openApp(faux, dataDir);
    // Something running that is not Node; only Linux (and Android) can tell, through /proc.
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
        argv0: "not-node",
    });
    const node = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);

    try {
        writeFileSync(lock, "999999999\n");
        await (await openHere()).close();

        if (process.platform === "linux" || process.platform === "android") {
            writeFileSync(lock, `${other.pid}\n`);
            await (await openHere()).close();
        }

        writeFileSync(lock, `${node.pid}\n`);
        await assert.rejects(
            openHere(),
            new RegExp(`already running on this data directory \\(pid ${node.pid}\\)`),
        );
    } finally {
        other.kill();
        node.kill();
        await Promise.all([once(other, "exit"), once(node, "exit")]);
    }
});

test("native view deltas send slow-changing fields only when changed", async () => {
    const native = await openNativeApp();
    const member = native.config.users.find((user) => user.role === "owner")!;

    try {
        const id = (await native.commands.createSession(member, { backend: "rotom" })).id;
        const entry = await native.harness.commit(
            (tx) =>
                tx.appendEntry(id, {
                    kind: NATIVE_ENTRY,
                    data: {
                        entry: {
                            type: "message",
                            id: "native-view-answer",
                            parentId: null,
                            message: {
                                role: "assistant",
                                timestamp: Date.now(),
                                content: [{ type: "text", text: "view answer" }],
                            },
                        },
                    },
                }),
            context,
        );
        const tab = fakeTab(id, member);
        const fields = [
            "artifacts",
            "subagents",
            "authors",
            "reactions",
            "pins",
            "turns",
            "decisions",
        ];
        const views = () =>
            tab.events.filter((each) => each.event === "view").map((each) => each.data);

        await native.attach(tab.client);
        const first = views()[0]!;

        assert.equal(first.full, true);

        for (const field of fields) {
            assert.ok(field in first, `a full view has ${field}`);
        }

        await native.collab.react(id, member, Number(entry.id), "👍");
        await until(() => views().length > 1, "native reaction view update");
        const update = views().at(-1)!;

        assert.deepEqual(update.reactions, { [String(entry.id)]: { "👍": [member.id] } });

        for (const field of fields.filter((field) => field !== "reactions")) {
            assert.ok(!(field in update), `unchanged ${field} omitted from delta`);
        }

        native.detach(tab.client);
        await native.attach(tab.client);
        const again = views().at(-1)!;

        assert.equal(again.full, true);

        for (const field of fields) {
            assert.ok(field in again, `reattach includes ${field}`);
        }

        native.detach(tab.client);
    } finally {
        await native.close();
    }
});

test("native reactions, pins, notes, mentions, quotes, and notices preserve shared state", async () => {
    const docs = await import("../src/server/docs.ts");
    const native = await openNativeApp();
    const member = native.config.users.find((user) => user.role === "owner")!;
    const alex = native.config.addUser("Alex", "guest").user;

    try {
        const id = (await native.commands.createSession(member, { backend: "rotom" })).id;
        const other = (await native.commands.createSession(member, { backend: "rotom" })).id;
        const elsewhere = fakeTab(other, alex);

        await native.attach(elsewhere.client);
        const entry = await native.harness.commit(
            (tx) =>
                tx.appendEntry(id, {
                    kind: NATIVE_ENTRY,
                    data: {
                        entry: {
                            type: "message",
                            id: "native-shared-answer",
                            parentId: null,
                            message: {
                                role: "assistant",
                                timestamp: Date.now(),
                                content: [{ type: "text", text: "native answer" }],
                            },
                        },
                    },
                }),
            context,
        );
        const answer = Number(entry.id);

        await native.collab.react(id, alex, answer, "👍");
        await native.collab.react(id, member, answer, "👍");
        await native.collab.react(id, member, answer, "👍");
        assert.deepEqual((await native.harness.snapshot(docs.ReactionsDoc, id, context))?.entries, {
            [String(answer)]: { "👍": [alex.id] },
        });
        await assert.rejects(native.collab.react(id, alex, answer, "💩"), /Pick one/);
        assert.deepEqual(await native.collab.pin(id, alex, { entryId: answer }), { pinned: true });
        const pinned = (await native.harness.snapshot(docs.PinsDoc, id, context))!.items[0]!;

        assert.equal(pinned.author, "Pi");
        assert.equal(pinned.text, "native answer");
        assert.deepEqual(await native.collab.pin(id, alex, { entryId: answer }), { pinned: false });
        const saved = await native.collab.saveNotes(id, alex, "plan: ship it", 0);

        assert.equal(saved.rev, 1);
        await assert.rejects(native.collab.saveNotes(id, member, "stale edit", 0), /Alex changed/);
        const posted = await native.collab.postChat(id, member, {
            text: "@alex look at this, cc @Alexander",
            requestId: "native-m1",
            quote: { entryId: answer },
        });

        assert.deepEqual(posted.mentions, [alex.id]);
        assert.equal(posted.quote?.text, "native answer");
        await until(
            () =>
                elsewhere.events.some(
                    (event) =>
                        event.event === "notice" &&
                        String(event.data.message).includes("mentioned you"),
                ),
            "Alex to hear about the mention elsewhere",
        );
        assert.deepEqual(elsewhere.last("notice")?.link, { conversationId: id, sheet: "chat" });
        const duplicate = await native.collab.postChat(id, member, {
            text: "@alex look at this, cc @Alexander",
            requestId: "native-m1",
            quote: { entryId: answer },
        });

        assert.equal(duplicate.id, posted.id);
        native.detach(elsewhere.client);
    } finally {
        native.config.removeUser(alex.id);
        await native.close();
    }
});

test("the session list shows who is where, the newest chat, and people come and go with a last-seen time", async () => {
    const app = await openNativeApp();
    const owner = () => app.config.users.find((user) => user.role === "owner")!;
    const newSession = async () =>
        (await app.commands.createSession(owner(), { backend: "rotom" })).id;
    const id = await newSession();
    const alex = app.config.addUser("Alex", "guest").user;
    const watcher = fakeTab(undefined, owner());
    const tab = fakeTab(id, alex);

    try {
        await app.attach(watcher.client);
        await app.attach(tab.client);
        const online = (watcher.last("users") as unknown as { id: string; online: boolean }[]).find(
            (each) => each.id === alex.id,
        );

        assert.equal(online?.online, true);
        await app.collab.postChat(id, alex, { text: "hello list", requestId: "l1" });
        await until(() => {
            const sessions = watcher.last("sessions") as unknown as
                { id: number; people?: { name: string }[]; chatBy?: string }[] | undefined;
            const row = sessions?.find((each) => each.id === Number(id));

            return (
                row?.chatBy === alex.id && row.people?.some((each) => each.name === "Alex") === true
            );
        }, "the session row to show Alex and the chat");
        app.detach(tab.client);
        const gone = (
            watcher.last("users") as unknown as { id: string; online: boolean; lastSeen?: number }[]
        ).find((each) => each.id === alex.id);

        assert.equal(gone?.online, false);
        assert.ok((gone?.lastSeen ?? 0) > Date.now() - 5000);
    } finally {
        app.detach(watcher.client);
        app.detach(tab.client);
        app.config.removeUser(alex.id);
        await app.close();
    }
});

test("invites carry a role and a session over HTTP, and viewers get 403 on steering routes", async () => {
    const app = await openNativeApp();
    const owner = () => app.config.users.find((user) => user.role === "owner")!;
    const newSession = async () =>
        (await app.commands.createSession(owner(), { backend: "rotom" })).id;

    try {
        const { createServer } = await import("node:http");
        const { createHandler } = await import("../src/server/http.ts");
        const server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const call = (token: string, path: string, body?: unknown) =>
            fetch(`${base}/api/${path}`, {
                method: body === undefined ? "GET" : "POST",
                headers: {
                    authorization: `Bearer ${token}`,
                    "x-pocket": "1",
                    "content-type": "application/json",
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
        const id = await newSession();
        const joined: string[] = [];

        try {
            const invite = (await (
                await call(app.config.ownerToken, "invite", { role: "viewer", session: Number(id) })
            ).json()) as { code: string; grant: unknown };

            assert.deepEqual(invite.grant, { role: "viewer", session: String(id) });
            const page = await (await fetch(`${base}/join/${invite.code}`)).text();

            assert.match(page, /but not steer Pi/);
            const redeemed = await fetch(`${base}/join/${invite.code}`, {
                method: "POST",
                body: "name=Watcher",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                redirect: "manual",
            });
            const token = decodeURIComponent(
                /pocket_auth=([^;]+)/.exec(redeemed.headers.get("set-cookie") ?? "")![1]!,
            );
            const watcher = app.config.users.find((each) => each.name === "Watcher")!;

            joined.push(watcher.id);
            assert.equal(watcher.role, "viewer");
            assert.deepEqual(watcher.sessions, [String(id)]);
            const submitResponse = await call(token, `c/${id}/submit`, {
                text: "hi",
                requestId: "x",
            });

            assert.equal(submitResponse.status, 403);

            const abortResponse = await call(token, `c/${id}/abort`, {});

            assert.equal(abortResponse.status, 403);

            assert.ok((await call(token, "invite", {})).status === 403);
            assert.ok((await call(token, "fs?path=/")).status === 403);
            assert.ok(
                (await call(token, "fs", { path: join(root, "made-by-watcher") })).status === 403,
            );
            assert.ok((await call(token, `c/${id}/files`)).status === 403);
            assert.ok((await call(token, `c/${id}/view?path=README.md`)).status === 403);
            // Native HTTP shell/revert paths are unsupported; this is not a viewer-policy substitute.
            assert.equal((await call(token, `c/${id}/shell`, { command: "echo hi" })).status, 409);
            const revertResponse = await call(token, `c/${id}/changes/revert`, {
                path: "a.txt",
            });

            assert.equal(revertResponse.status, 409);

            assert.equal(
                (await call(token, `c/${id}/chat`, { text: "hello", requestId: "y" })).status,
                200,
            );
            assert.equal(
                (await call(token, `c/${Number(id) + 999}/chat`, { text: "hello", requestId: "z" }))
                    .status,
                404,
            );
            const sessions = (await (await call(token, "sessions")).json()) as { id: number }[];

            assert.deepEqual(
                sessions.map((each) => each.id),
                [Number(id)],
            );
            const push = (await (await call(token, "push")).json()) as {
                publicKey: string;
                prefs: Record<string, boolean>;
                devices: number;
            };

            assert.equal(push.devices, 0);
            assert.equal(push.prefs.mention, true);
            assert.ok(push.publicKey.length > 80);
            assert.equal(
                (
                    await call(token, "push/subscribe", {
                        subscription: {
                            endpoint: "http://insecure.example/x",
                            keys: { p256dh: "a", auth: "b" },
                        },
                    })
                ).status,
                400,
            );
        } finally {
            for (const userId of joined) {
                app.config.removeUser(userId);
            }

            server.closeAllConnections();
            server.close();
        }
    } finally {
        await app.close();
    }
});

test("sign-in, invite, recovery and expired-link pages use the rotom team identity", async () => {
    const { createServer } = await import("node:http");
    const { createHandler } = await import("../src/server/http.ts");
    const { Auth } = await import("../src/server/auth.ts");
    const auth = new Auth(app.config);
    const member = app.config.addUser("Brand check", "guest");
    const invites = [
        auth.createInvite(owner(), { role: "guest" }),
        auth.createInvite(owner(), { role: "viewer" }),
        auth.createInvite(owner(), { role: "owner" }),
        auth.createInvite(owner(), { role: "recovery", memberId: member.user.id }),
    ];
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    try {
        for (const path of [
            ...invites.map(({ code }) => `/join/${code}`),
            "/join/expired-brand-check",
            "/login?token=expired-brand-check",
            `/login?token=${encodeURIComponent(member.token)}`,
        ]) {
            const response = await fetch(`${base}${path}`, {
                headers: { cookie: `pocket_auth=${app.config.ownerToken}` },
                redirect: "manual",
            });
            const html = await response.text();

            assert.match(html, /<title>[^<]*rotom team<\/title>/, path);
            assert.doesNotMatch(html, /Pi Pocket/, path);
        }
    } finally {
        for (const { code } of invites) {
            auth.cancelInvite(code, owner());
        }

        app.config.removeUser(member.user.id);
        server.closeAllConnections();
        server.close();
    }
});

test("the owner signs another device in as the owner: owner only, once, no one new, and a new owner token signs it out", async () => {
    const { createServer } = await import("node:http");
    const { createHandler } = await import("../src/server/http.ts");
    const { Auth } = await import("../src/server/auth.ts");
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const call = (token: string, path: string, body?: unknown) =>
        fetch(`${base}/api/${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "x-pocket": "1",
                "content-type": "application/json",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    const signIn = (code: string, site: string) =>
        fetch(`${base}/join/${code}`, {
            method: "POST",
            redirect: "manual",
            body: "",
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                "sec-fetch-site": site,
            },
        });
    const id = await seedHistoricalSession();
    const guest = app.config.addUser("Gwen", "guest");
    const viewer = app.config.addUser("Vic", "viewer");

    try {
        // Only the owner makes one, and it is never for one session.
        const invite = (await (
            await call(app.config.ownerToken, "invite", { role: "owner" })
        ).json()) as { code: string; grant: unknown };

        assert.deepEqual(invite.grant, { role: "owner" });
        assert.equal((await call(guest.token, "invite", { role: "owner" })).status, 403);
        assert.equal((await call(viewer.token, "invite", { role: "owner" })).status, 403);
        assert.deepEqual(
            (
                (await (
                    await call(app.config.ownerToken, "invite", {
                        role: "owner",
                        session: Number(id),
                    })
                ).json()) as { grant: unknown }
            ).grant,
            { role: "owner" },
        );

        // Its page says what it gives, asks no name, and says whom this browser stops being.
        const page = await (
            await fetch(`${base}/join/${invite.code}`, {
                headers: { cookie: `pocket_auth=${guest.token}` },
            })
        ).text();

        assert.match(
            page,
            /This device will sign in as you, the owner\. It gets full control of rotom team and of this machine\./,
        );
        assert.match(page, /signed in as Gwen\. It will change to the owner/);
        assert.match(page, />Sign in as owner<\/button>/);
        assert.doesNotMatch(page, /name="name"/);

        // Another site cannot spend it.
        assert.equal((await signIn(invite.code, "cross-site")).status, 403);
        assert.equal(
            (await fetch(`${base}/join/${invite.code}`)).status,
            200,
            "the invite still works",
        );

        // The device gets the owner's token, and no one new is made.
        const people = app.config.users.length;
        const signed = await signIn(invite.code, "same-origin");

        assert.equal(signed.status, 303);
        const cookie = decodeURIComponent(
            /pocket_auth=([^;]+)/.exec(signed.headers.get("set-cookie") ?? "")![1]!,
        );

        assert.equal(cookie, app.config.ownerToken);
        assert.equal(app.config.users.length, people);
        const me = await fetch(`${base}/api/me`, { headers: { cookie: `pocket_auth=${cookie}` } });

        assert.equal(
            ((await me.json()) as { user: { id: string; role: string } }).user.id,
            owner().id,
        );

        // It works once.
        assert.equal((await signIn(invite.code, "same-origin")).status, 410);

        // An owner invite made by anyone else (past the API's check) signs no one in.
        const auth = new Auth(app.config);
        const forged = auth.createInvite(guest.user, { role: "owner" });

        assert.equal(auth.redeem(forged.code, ""), undefined);
        assert.equal(auth.invite(forged.code), undefined, "and it is spent");

        // A new owner token signs the device out.
        app.config.rotateOwnerToken();
        assert.equal(
            (await fetch(`${base}/api/me`, { headers: { cookie: `pocket_auth=${cookie}` } }))
                .status,
            401,
        );
    } finally {
        app.config.removeUser(guest.user.id);
        app.config.removeUser(viewer.user.id);
        server.closeAllConnections();
        server.close();
    }
});

test("an invite lasts as long as asked (an owner's always 15 minutes), outlives a restart, and ends when its maker moves on", async () => {
    const { createServer } = await import("node:http");
    const { createHandler } = await import("../src/server/http.ts");
    const { Auth } = await import("../src/server/auth.ts");
    const { ConfigStore, MAX_INVITES } = await import("../src/server/config.ts");
    const { copyFileSync, mkdtempSync, readFileSync } = await import("node:fs");
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const call = (token: string, path: string, body: unknown) =>
        fetch(`${base}/api/${path}`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "x-pocket": "1",
                "content-type": "application/json",
            },
            body: JSON.stringify(body),
        });
    const make = async (body: unknown) =>
        (await (await call(app.config.ownerToken, "invite", body)).json()) as {
            code: string;
            expiresAt: number;
            minutes: number;
        };
    const live = async (code: string) => (await fetch(`${base}/join/${code}`)).status === 200;
    const guest = app.config.addUser("Gil", "guest");
    const MINUTE = 60_000;

    try {
        // As long as asked, 15 minutes when not said; an owner invite, 15 whatever is asked.
        for (const [body, minutes] of [
            [{}, 15],
            [{ minutes: 60 }, 60],
            [{ minutes: 24 * 60 }, 24 * 60],
            [{ minutes: 7 * 24 * 60, role: "viewer" }, 7 * 24 * 60],
            [{ minutes: 7 * 24 * 60, role: "owner" }, 15],
        ] as const) {
            const before = Date.now();
            const invite = await make(body);

            assert.equal(invite.minutes, minutes, JSON.stringify(body));
            assert.ok(
                invite.expiresAt >= before + minutes * MINUTE &&
                    invite.expiresAt <= Date.now() + minutes * MINUTE,
                JSON.stringify(body),
            );
        }

        for (const minutes of [5, "60", 100_000, null]) {
            assert.equal(
                (await call(app.config.ownerToken, "invite", { minutes })).status,
                400,
                String(minutes),
            );
        }

        // Kept in the data folder, by the code's hash: another start of the server (on a copy, which writes nothing back
        // here) finds it.
        const week = await make({ minutes: 7 * 24 * 60 });
        const copy = mkdtempSync(join(root, "config-"));

        copyFileSync(app.config.file, join(copy, "config.json"));
        const again = new Auth(new ConfigStore(copy));

        assert.deepEqual(again.invite(week.code), { role: "guest" });
        assert.ok(!readFileSync(app.config.file, "utf8").includes(week.code));

        // Only whoever made it ends it.
        assert.equal((await call(guest.token, "invite/cancel", { code: week.code })).status, 200);
        assert.ok(await live(week.code), "someone else cannot end it");
        assert.equal(
            (await call(app.config.ownerToken, "invite/cancel", { code: week.code })).status,
            200,
        );
        assert.ok(!(await live(week.code)), "its maker can");
        const guests = (await (await call(guest.token, "invite", { minutes: 60 })).json()) as {
            code: string;
        };

        await call(app.config.ownerToken, "invite/cancel", { code: guests.code });
        assert.ok(await live(guests.code), "not even the owner ends someone else's");

        // Two devices spending one at once: one gets in.
        const once = await make({ minutes: 60 });
        const both = await Promise.all(
            ["One", "Two"].map((name) =>
                fetch(`${base}/join/${once.code}`, {
                    method: "POST",
                    redirect: "manual",
                    body: `name=${name}`,
                    headers: { "content-type": "application/x-www-form-urlencoded" },
                }),
            ),
        );

        assert.deepEqual(both.map((each) => each.status).sort(), [303, 410]);

        for (const name of ["One", "Two"]) {
            const joined = app.config.users.find((each) => each.name === name);

            if (joined !== undefined) {
                app.config.removeUser(joined.id);
            }
        }

        // It works until its time is up, and not after.
        const auth = new Auth(app.config);

        mock.timers.enable({ apis: ["Date"], now: Date.now() });

        try {
            const hour = auth.createInvite(owner(), { role: "guest" }, 60);
            const late = auth.createInvite(owner(), { role: "guest" }, 60);

            mock.timers.tick(59 * MINUTE);
            const inTime = auth.redeem(hour.code, "In Time");

            assert.equal(inTime?.user.role, "guest");
            app.config.removeUser(inTime!.user.id);
            mock.timers.tick(2 * MINUTE);
            assert.equal(auth.redeem(late.code, "Too Late"), undefined);
        } finally {
            mock.timers.reset();
        }

        // One person keeps at most MAX_INVITES live: beyond that, their oldest ends.
        const many = Array.from({ length: MAX_INVITES + 1 }, () =>
            auth.createInvite(guest.user, { role: "guest" }, 60),
        );

        assert.equal(auth.invite(many[0]!.code), undefined);
        assert.ok(many.slice(1).every((each) => auth.inviteValid(each.code)));

        // Someone removed takes the invites they made along.
        const leaving = app.config.addUser("Lee", "guest").user;
        const left = auth.createInvite(leaving, { role: "viewer" }, 24 * 60);

        app.config.removeUser(leaving.id);
        assert.equal(auth.invite(left.code), undefined);
        assert.ok(!(await live(left.code)));

        // A new owner token ends owner invites not yet used, which would hand it out; others stay.
        const mine = auth.createInvite(owner(), { role: "owner" });
        const theirs = auth.createInvite(owner(), { role: "guest" }, 24 * 60);

        app.config.rotateOwnerToken();
        assert.equal(auth.invite(mine.code), undefined);
        assert.deepEqual(auth.invite(theirs.code), { role: "guest" });
    } finally {
        app.config.removeUser(guest.user.id);
        server.closeAllConnections();
        server.close();
    }
});

test("people who signed in through a Cloudflare quick tunnel are removed once that tunnel is gone", async () => {
    const { createServer } = await import("node:http");
    const { createHandler } = await import("../src/server/http.ts");
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const owner = {
        authorization: `Bearer ${app.config.ownerToken}`,
        "x-pocket": "1",
        "content-type": "application/json",
    };

    const join = async (name: string, host?: string): Promise<string> => {
        const { code } = (await (
            await fetch(`${base}/api/invite`, { method: "POST", headers: owner, body: "{}" })
        ).json()) as { code: string };
        const headers: Record<string, string> = {
            "content-type": "application/x-www-form-urlencoded",
            ...(host === undefined ? {} : { "x-forwarded-host": host }),
        };
        const joined = await fetch(`${base}/join/${code}`, {
            method: "POST",
            body: `name=${name}`,
            headers,
            redirect: "manual",
        });

        return decodeURIComponent(
            /pocket_auth=([^;]+)/.exec(joined.headers.get("set-cookie") ?? "")![1]!,
        );
    };

    const named = (name: string) => app.config.users.find((each) => each.name === name);
    const before = app.access;

    try {
        await join("Tunnelled", "old-tunnel.trycloudflare.com");
        await join("Wifi");
        const legacy = await join("Legacy");

        assert.equal(named("Tunnelled")?.tunnel, "old-tunnel.trycloudflare.com");
        assert.equal(named("Wifi")?.tunnel, undefined);
        // Someone who joined before tunnels were recorded is tagged when their cookie comes back through one.
        await fetch(`${base}/api/me`, {
            headers: {
                cookie: `pocket_auth=${encodeURIComponent(legacy)}`,
                "x-forwarded-host": "old-tunnel.trycloudflare.com",
            },
        });
        assert.equal(named("Legacy")?.tunnel, "old-tunnel.trycloudflare.com");

        // A server restart keeps the tunnel: nobody is removed.
        app.setReach({
            mode: "cloudflare",
            label: "Cloudflare Tunnel",
            url: "https://old-tunnel.trycloudflare.com",
        });
        assert.ok(named("Tunnelled") && named("Legacy") && named("Wifi"));
        // A new tunnel: its address is new, so the old one's people go. Others and the owner stay.
        app.setReach({
            mode: "cloudflare",
            label: "Cloudflare Tunnel",
            url: "https://new-tunnel.trycloudflare.com",
        });
        assert.equal(named("Tunnelled"), undefined);
        assert.equal(named("Legacy"), undefined);
        assert.ok(named("Wifi"));
        assert.ok(app.config.users.some((each) => each.role === "owner"));
    } finally {
        app.access = before;

        for (const name of ["Tunnelled", "Wifi", "Legacy"]) {
            const user = named(name);

            if (user !== undefined) {
                app.config.removeUser(user.id);
            }
        }

        server.closeAllConnections();
        server.close();
    }
});

test("the web edge: page policy, local redirects, asked account switches, no cross-site sign-ins, archive uploads, scoped people", async () => {
    const { createServer } = await import("node:http");
    const { createHandler } = await import("../src/server/http.ts");
    const { createHash } = await import("node:crypto");
    const { existsSync, readFileSync } = await import("node:fs");
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const ownerToken = app.config.ownerToken;
    const id = await newSession();
    const other = await newSession();
    const guest = app.config.addUser("Gus", "guest");
    const scoped = app.config.addUser("Sam", "viewer", [String(id)]);
    const elsewhere = app.config.addUser("Eve", "guest", [String(other)]);
    const cookie = (response: Response) => response.headers.get("set-cookie") ?? "";

    try {
        // The app page allows its own import map by hash and nothing from other sites.
        const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
        const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html)![1]!;

        for (const path of ["/", `/s/${id}`, "/index.html"]) {
            const policy = (await fetch(base + path)).headers.get("content-security-policy") ?? "";

            assert.ok(
                policy.includes(`'sha256-${createHash("sha256").update(map).digest("base64")}'`),
                `${path} allows the import map`,
            );
            assert.match(policy, /img-src 'self' data: blob:;/);
            assert.match(policy, /connect-src 'self';/);
            assert.match(policy, /frame-ancestors 'self'/);
        }

        // After signing in, only paths on this server.
        const login = (query: string, headers: Record<string, string> = {}) =>
            fetch(`${base}/login?${query}`, { redirect: "manual", headers });

        for (const next of ["//evil.example/x", "/\\evil.example/x", "https://evil.example/"]) {
            assert.equal(
                (await login(`token=${ownerToken}&next=${encodeURIComponent(next)}`)).headers.get(
                    "location",
                ),
                "/",
                next,
            );
        }

        assert.equal(
            (await login(`token=${ownerToken}&next=${encodeURIComponent(`/s/${id}`)}`)).headers.get(
                "location",
            ),
            `/s/${id}`,
        );

        // A link for someone else asks before switching; only a same-site post switches.
        const asked = await login(`token=${guest.token}`, { cookie: `pocket_auth=${ownerToken}` });

        assert.equal(asked.status, 200);
        assert.equal(cookie(asked), "");
        assert.match(
            await asked.text(),
            /Switch account\?[\s\S]*signed in as [^<]+\. The link you opened signs it in as Gus/,
        );
        const post = (path: string, body: string, site: string) =>
            fetch(base + path, {
                method: "POST",
                redirect: "manual",
                body,
                headers: {
                    "content-type": "application/x-www-form-urlencoded",
                    "sec-fetch-site": site,
                },
            });
        const forged = await post("/login", `token=${guest.token}`, "cross-site");

        assert.equal(forged.status, 403);
        assert.equal(cookie(forged), "");
        const switched = await post("/login", `token=${guest.token}`, "same-origin");

        assert.equal(switched.status, 303);
        assert.match(
            cookie(switched),
            new RegExp(`pocket_auth=${encodeURIComponent(guest.token)}`),
        );
        assert.equal(
            cookie(
                await login(`token=${ownerToken}`, { cookie: `pocket_auth=${ownerToken}` }),
            ).includes("pocket_auth="),
            true,
            "the same person signs in without asking",
        );

        // Another site cannot spend an invite on this browser.
        const invite = (await (
            await fetch(`${base}/api/invite`, {
                method: "POST",
                body: "{}",
                headers: { authorization: `Bearer ${ownerToken}`, "x-pocket": "1" },
            })
        ).json()) as { code: string };

        assert.equal(
            (await post(`/join/${invite.code}`, "name=Mallory", "cross-site")).status,
            403,
        );
        assert.equal(
            (await fetch(`${base}/join/${invite.code}`)).status,
            200,
            "the invite still works",
        );

        // Unknown sessions stay 404; historical archives cannot accept uploads.
        const uploads = join(root, "data", "uploads");
        const missing = await fetch(`${base}/api/c/987654/upload?name=x.txt`, {
            method: "POST",
            body: "x",
            headers: { authorization: `Bearer ${ownerToken}`, "x-pocket": "1" },
        });

        assert.equal(missing.status, 404);
        assert.equal(existsSync(join(uploads, "987654")), false);
        const big = await fetch(`${base}/api/c/${id}/upload?name=big.bin`, {
            method: "POST",
            body: "x",
            headers: {
                authorization: `Bearer ${ownerToken}`,
                "x-pocket": "1",
                "content-length": "1",
            },
        });

        assert.equal(big.status, 409);
        assert.match(await big.text(), /read-only archive/);
        // Native byte limits, duplicate names and partial-upload cleanup are independently tested below.

        // People invited to one session see only the people who share it, without anyone's session limits.
        const seen = (await (
            await fetch(`${base}/api/users`, {
                headers: { authorization: `Bearer ${scoped.token}` },
            })
        ).json()) as { name: string; sessions?: number[] }[];

        assert.ok(
            seen.some((each) => each.name === "Gus") && seen.some((each) => each.name === "Sam"),
        );
        assert.ok(
            !seen.some((each) => each.name === "Eve"),
            "someone limited to another session stays hidden",
        );
        assert.ok(seen.every((each) => each.sessions === undefined));
        const all = (await (
            await fetch(`${base}/api/users`, { headers: { authorization: `Bearer ${ownerToken}` } })
        ).json()) as { name: string; sessions?: number[] }[];

        assert.deepEqual(all.find((each) => each.name === "Eve")?.sessions, [Number(other)]);
    } finally {
        for (const each of [guest, scoped, elsewhere]) {
            app.config.removeUser(each.user.id);
        }

        server.closeAllConnections();
        server.close();
    }
});

test("native HTTP uploads sanitize names, enforce limits, clean partial files, and persist", async () => {
    const { createServer, request: rawRequest } = await import("node:http");
    const { createHandler } = await import("../src/server/http.ts");
    const native = await openNativeApp();
    let closed = false;
    const member = native.config.users.find((user) => user.role === "owner")!;
    const server = createServer(
        createHandler({ app: native, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
        const id = (await native.commands.createSession(member, { backend: "rotom" })).id;
        const upload = await fetch(
            `http://127.0.0.1:${port}/api/c/${id}/upload?name=../bad<>name.png&unused=ignored`,
            {
                method: "POST",
                body: "native upload",
                headers: {
                    authorization: `Bearer ${native.config.ownerToken}`,
                    "x-pocket": "1",
                    "content-type": "image/png",
                },
            },
        );

        assert.equal(upload.status, 200);
        const attachment = (await upload.json()) as { path: string; name: string; size: number };

        assert.equal(attachment.name, "bad_name.png");
        assert.equal(attachment.size, 13);
        assert.equal(dirname(attachment.path), native.workspace.uploadDirectory(id));
        assert.equal(readFileSync(attachment.path, "utf8"), "native upload");
        const filesBefore = readdirSync(native.workspace.uploadDirectory(id));

        assert.equal(filesBefore.length, 1);
        const declared = await new Promise<number>((resolve) => {
            const request = rawRequest({
                port,
                method: "POST",
                path: `/api/c/${id}/upload?name=too-big.bin`,
                headers: {
                    authorization: `Bearer ${native.config.ownerToken}`,
                    "x-pocket": "1",
                    "content-length": String(50 * 1024 * 1024 + 1),
                },
            });

            request.on("response", (response) => resolve(response.statusCode ?? 0));
            request.on("error", () => resolve(-1));
            request.end();
        });

        assert.equal(declared, 413);
        assert.deepEqual(readdirSync(native.workspace.uploadDirectory(id)), filesBefore);
        await native.close();
        closed = true;
        const reopened = await openNativeApp();

        try {
            assert.equal(readFileSync(attachment.path, "utf8"), "native upload");
        } finally {
            await reopened.close();
        }
    } finally {
        server.closeAllConnections();
        server.close();

        if (!closed) {
            await native.close();
        }
    }
});

test("access holds: a refused tab hears nothing, narrowed access evicts, removal closes tabs, files stay in the session", async () => {
    const id = await newSession();
    const other = await newSession();
    const sam = app.config.addUser("Sam", "guest", [String(id)]).user;
    const vee = app.config.addUser("Vee", "viewer").user;
    const sneaky = fakeTab(other, sam);
    const samTab = fakeTab(id, sam);
    const veeTab = fakeTab(id, vee);
    let closed = 0;

    (veeTab.client as { close?: () => void }).close = () => closed++;

    try {
        // A tab pointed at a session Sam may not see gets "missing", then nothing about that session.
        await app.attach(sneaky.client);
        assert.equal(sneaky.client.conversationId, undefined);
        assert.equal(
            (await app.sessions()).some((session) => session.id === Number(other)),
            true,
        );
        app.notice("warning", "server-wide detail");
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.ok(
            !sneaky.events.some((each) => each.event === "notice"),
            "no notices from the other session or the server",
        );
        assert.ok(
            !(
                (await app.sessions(owner())).find((each) => each.id === Number(other))?.people ??
                []
            ).some((each) => each.id === sam.id),
        );

        // Narrowing Sam's access takes his tab out of the session at once.
        await app.attach(samTab.client);
        app.setAccess(owner(), sam.id, { sessions: [String(other)] });
        assert.match(String(samTab.last("missing")?.message), /no longer shared/);
        await assert.rejects(
            app.collab.postChat(id, owner(), { text: "after the change", requestId: "acc-1" }),
            /read-only archive/,
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.ok(
            !samTab.events.some(
                (each) =>
                    each.event === "chat" && JSON.stringify(each.data).includes("after the change"),
            ),
        );

        // Viewers load images only from the session's folder.
        const { writeFileSync } = await import("node:fs");
        const png = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAAABJRU5ErkJggg==",
            "base64",
        );

        writeFileSync(join(work, "inside.png"), png);
        writeFileSync(join(root, "outside.png"), png);
        assert.equal(
            await app.workspace.conversationFile(vee, id, "inside.png"),
            realpathSync(join(work, "inside.png")),
        );
        await assert.rejects(
            async () => await app.workspace.conversationFile(vee, id, join(root, "outside.png")),
            /not found/,
        );
        await assert.rejects(
            async () => await app.workspace.conversationFile(vee, id, "../outside.png"),
            /not found/,
        );
        assert.equal(
            await app.workspace.conversationFile(owner(), id, join(root, "outside.png")),
            join(root, "outside.png"),
        );

        // Removing Vee closes her tab.
        await app.attach(veeTab.client);
        app.removeUser(owner(), vee.id);
        assert.equal(closed, 1);
        assert.ok(veeTab.events.some((each) => each.event === "closing"));
    } finally {
        for (const tab of [sneaky, samTab, veeTab]) {
            app.detach(tab.client);
        }

        app.config.removeUser(sam.id);
        app.config.removeUser(vee.id);
    }
});

test("an invite stops working when its creator loses the right to invite", async () => {
    const { Auth } = await import("../src/server/auth.ts");
    const auth = new Auth(app.config);
    const guest = app.config.addUser("Gil", "guest").user;

    try {
        const { code } = auth.createInvite(guest, { role: "guest" });

        app.setAccess(owner(), guest.id, { role: "viewer" });
        assert.equal(auth.redeem(code, "Mallory"), undefined);
        assert.ok(!app.config.users.some((each) => each.name === "Mallory"));
        const fine = auth.createInvite(owner(), { role: "viewer" });
        const joined = auth.redeem(fine.code, "Okay");

        assert.equal(joined?.user.role, "viewer");
        app.config.removeUser(joined!.user.id);
    } finally {
        app.config.removeUser(guest.id);
    }
});

test("historical sessions survive closing and reopening storage", async () => {
    const id = await seedHistoricalSession();

    await appendHistoricalTurn(app, id, "saved historical question", "saved historical answer");
    const before = await (await app.harness.conversation(id, context))!.entries(
        {},
        100,
        undefined,
        context,
    );
    const exported = await app.transcripts.exportMarkdown(id, owner());

    assert.match(exported.markdown, /saved historical question/);

    await app.close();
    app = await open();
    const after = await (await app.harness.conversation(id, context))!.entries(
        {},
        100,
        undefined,
        context,
    );

    assert.deepEqual(after, before);
});
