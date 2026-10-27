/**
 * Scripted end-to-end demo of rotom-team v1, over its HTTP API, with a loopback model and synthetic accounts only.
 * The owner starts a rotom session, Bob continues it, Carol forks it and has a subagent review it, and a server restart
 * cuts the owner's next run off and continues it by itself. The model server tells who paid by the request credential it
 * receives.
 *
 *   node test/team-kernel-demo.ts           run the story, print each step, exit
 *   node test/team-kernel-demo.ts --serve   then keep the server for a look in the browser (Ctrl-C ends it)
 */
import { cleanUp, owner, root, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PocketApp } from "../src/server/app.ts";
import { createHandler } from "../src/server/http.ts";
import type { Runtime } from "../src/server/team-accounts.ts";
import type { User } from "../src/server/config.ts";

const serve = process.argv.includes("--serve");
const secret = `demo-${process.pid}`;
const payers: string[] = [];

/** An OpenAI-compatible loopback model: it answers with whose credential it was called, slowly when asked. */
const model = createServer(async (req, res) => {
    let body = "";

    for await (const chunk of req) {
        body += chunk;
    }

    const input = JSON.parse(body) as {
        messages: { role: string; content: unknown; tool_call_id?: string }[];
    };
    const payer = String(req.headers.authorization).replace(`Bearer ${secret}:`, "");
    const last = JSON.stringify(input.messages.findLast((m) => m.role === "user")?.content);
    const emit = (delta: object, finish: string | null = null) =>
        res.write(
            `data: ${JSON.stringify({ id: "demo", object: "chat.completion.chunk", created: 1, model: "demo", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );

    payers.push(payer);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    emit({ role: "assistant" });

    const toolCall = (id: string, name: string, args: object) => {
        emit({
            tool_calls: [
                {
                    index: 0,
                    id,
                    type: "function",
                    function: { name, arguments: JSON.stringify(args) },
                },
            ],
        });
        emit({}, "tool_calls");
        res.end("data: [DONE]\n\n");
    };

    const answered = (id: string) => input.messages.some((m) => m.tool_call_id === id);

    // DELEGATE: the parent loads the subagent tool and starts a reviewer. The reviewer answers in its own process, and
    // its result comes back to the parent as a new turn.
    if (last.includes("REVIEW_TASK")) {
        if (last.includes("SLOW")) {
            await new Promise((resolve) => setTimeout(resolve, 8000));
        }

        emit({ content: `Reviewed by a subagent on the account of ${names.get(payer) ?? payer}.` });
        emit({}, "stop");
        res.end("data: [DONE]\n\n");

        return;
    }

    if (last.includes("Background task completed")) {
        emit({ content: "The reviewer's report is back: nothing to change." });
        emit({}, "stop");
        res.end("data: [DONE]\n\n");

        return;
    }

    if (last.includes("DELEGATE")) {
        const round = String(input.messages.filter((m) => m.role === "user").length);

        if (!answered(`search-${round}`)) {
            toolCall(`search-${round}`, "search_tools", { query: "subagent", limit: 3 });

            return;
        }

        if (!answered(`spawn-${round}`)) {
            toolCall(`spawn-${round}`, "subagent", {
                agent: "reviewer",
                task: `REVIEW_TASK${last.includes("SLOW") ? " SLOW" : ""}: review the summary`,
                extensions: [],
            });

            return;
        }

        emit({ content: "A reviewer is on it; its result follows." });
        emit({}, "stop");
        res.end("data: [DONE]\n\n");

        return;
    }

    if (last.includes("SLOW")) {
        emit({ content: "Working on it… " });
        await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    emit({ content: `Answered on the account of ${names.get(payer) ?? payer}.` });
    emit({}, "stop");
    res.end("data: [DONE]\n\n");
});

model.listen(0, "127.0.0.1");
await once(model, "listening");
const baseUrl = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;
const names = new Map<string, string>();
const configureUserModels = (models: Runtime, user: User) =>
    models.registerNativeProvider({
        id: "openai",
        name: "Scripted demo model",
        auth: {
            apiKey: {
                name: "Synthetic demo key",
                resolve: async () => ({
                    auth: { apiKey: `${secret}:${user.id}` },
                    source: "demo",
                }),
            },
        },
        getModels: () => [
            {
                id: "demo",
                name: "demo",
                api: "openai-completions",
                provider: "openai",
                baseUrl,
                reasoning: false,
                input: ["text"],
                contextWindow: 32000,
                maxTokens: 1024,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
        ],
        stream: () => {
            throw new Error("rotom sessions never run on the Durable path");
        },
        streamSimple: () => {
            throw new Error("rotom sessions never run on the Durable path");
        },
    });
const data = join(realpathSync(root), "kernel-demo");
const workspace = join(realpathSync(work), "kernel-demo-project");

mkdirSync(join(workspace, ".agents", "skills", "house-style"), { recursive: true });
writeFileSync(join(workspace, "AGENTS.md"), "Project rule: answer briefly.\n");
writeFileSync(
    join(workspace, ".agents", "skills", "house-style", "SKILL.md"),
    "---\nname: house-style\ndescription: The project's shared writing style.\n---\nBe brief.\n",
);
const open = () =>
    PocketApp.open({
        dataDir: data,
        defaultCwd: workspace,
        supervised: false,
        kernel: true,
        browser: null,
        log: () => {},
        configureUserModels,
    });
let app = await open();
let handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });
const server = createServer((req, res) => handler(req, res));

server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const call = async (token: string, path: string, method = "GET", body?: object) => {
    const response = await fetch(`${base}/api/${path}`, {
        method,
        headers: {
            authorization: `Bearer ${token}`,
            "x-pocket": "1",
            "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });

    assert.equal(response.status, 200, `${method} ${path}: ${await response.clone().text()}`);

    return response.json();
};

const step = (text: string) => console.log(`\n▶ ${text}`);
const lastPayer = () => names.get(payers.at(-1)!);

const alice = owner(app);
const aliceToken = app.config.addDevice(alice.id).token;
const bob = app.config.addUser("Bob", "guest");
const carol = app.config.addUser("Carol", "guest");

for (const user of [alice, bob.user, carol.user]) {
    names.set(user.id, user.name);
    await app.hello(user);
}

step("The owner creates a rotom session and sends a message");
const session = (await call(aliceToken, "sessions", "POST", {
    title: "Demo: one task, three members",
    backend: "rotom",
})) as { id: number };
const first = await call(aliceToken, `c/${session.id}/submit`, "POST", {
    text: "Summarise the project rules.",
    requestId: "alice-1",
});

assert.equal(first.status, "settled");
assert.equal(lastPayer(), alice.name);
console.log(`  settled; the model was paid by ${lastPayer()}`);

step("Bob continues the owner's session: his message runs on his own account");
const second = await call(bob.token, `c/${session.id}/submit`, "POST", {
    text: "Add one more point.",
    requestId: "bob-1",
});

assert.equal(second.status, "settled");
assert.equal(lastPayer(), bob.user.name);
assert.equal(
    ((await app.kernel!.roomState(session.id as never, bob.user)) as { memberName: string })
        .memberName,
    bob.user.name,
);
console.log(`  settled; paid by ${lastPayer()}; the session now runs as ${bob.user.name}`);

step("Carol forks the session and continues the fork on her account");
const head = (
    (await app.kernel!.roomState(session.id as never, carol.user)) as { segmentId: string }
).segmentId;
const fork = (await call(carol.token, `c/${session.id}/fork`, "POST", {
    requestId: "carol-fork",
    expectedHead: head,
})) as { id: number };
const third = await call(carol.token, `c/${fork.id}/submit`, "POST", {
    text: "Go on from here.",
    requestId: "carol-1",
});

assert.equal(third.status, "settled");
assert.equal(lastPayer(), carol.user.name);
console.log(`  fork ${fork.id} settled; paid by ${lastPayer()}`);

step("Carol has a subagent review her fork; the run waits for its result");
const beforeReview = payers.length;
const review = await call(carol.token, `c/${fork.id}/submit`, "POST", {
    text: "DELEGATE: have a reviewer check this.",
    requestId: "carol-review",
});

assert.equal(review.status, "settled");
// search, spawn, the parent's reply, the reviewer, and the parent's turn on the reviewer's result.
assert.deepEqual(
    payers.slice(beforeReview).map((id) => names.get(id)),
    Array(5).fill(carol.user.name),
);
console.log(`  settled after the reviewer's result was back; all 5 calls paid by ${lastPayer()}`);

step("The owner starts a long run; the server restarts in the middle of it");
await call(aliceToken, `c/${session.id}/submit`, "POST", {
    text: "SLOW: write the full report.",
    requestId: "alice-2",
    wait: false,
});

while (!JSON.stringify(app.kernel!.clientLive(session.id as never)).includes("Working on it")) {
    await new Promise((resolve) => setTimeout(resolve, 25));
}

const beforeRestart = payers.length;

await app.close();
app = await open();
handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });

const journal = app.kernel!.executions.journal;

for (let tries = 0; ; tries++) {
    const latest = await journal.latest(String(session.id));

    if (latest?.requestId.includes("#resume") && latest.status === "settled") {
        break;
    }

    assert.ok(tries < 800, "the cut-off run continued after the restart");
    await new Promise((resolve) => setTimeout(resolve, 25));
}

assert.ok(payers.length > beforeRestart);
assert.equal(lastPayer(), alice.name);
console.log(`  after the restart the run continued by itself, still paid by ${lastPayer()}`);

console.log(
    `\n✔ Demo finished. Model calls by payer: ${JSON.stringify(payers.map((id) => names.get(id)))}`,
);

const stop = async () => {
    server.closeAllConnections();
    server.close();
    model.close();
    await app.close();
    cleanUp();
    process.exit(0);
};

if (serve) {
    console.log(`\nOpen the sessions in your browser (temporary data, synthetic accounts):`);
    console.log(`  Owner: ${base}/login?token=${app.config.ownerToken}`);
    console.log(`  Bob:   ${base}/login?token=${bob.token}`);
    console.log(`  Carol: ${base}/login?token=${carol.token}`);
    process.on("SIGINT", () => void stop());
    process.on("SIGTERM", () => void stop());
} else {
    await stop();
}
