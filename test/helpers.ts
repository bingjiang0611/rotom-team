// What the server tests share: an isolated Pi install and data folder, a scripted model, and small helpers. Import
// this before anything from src/: it points Pi's config at a temporary folder first.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, type ConversationId, UsageDoc } from "@earendil-works/pi-durable";
import type { Attachment } from "../src/server/commands.ts";
import type { User } from "../src/server/config.ts";
import { SessionsDoc } from "../src/server/docs.ts";
import { ConfigurationDoc } from "../src/server/team-profiles.ts";
import type { Client } from "../src/server/room.ts";
import type { Runtime as ModelRuntime } from "../src/server/team-accounts.ts";

export const context = BACKGROUND_CONTEXT;

export const root = mkdtempSync(join(tmpdir(), "pi-pocket-test-"));
// Isolate from the real Pi install: its auth, settings, skills, and Lancet Guard.
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.PI_POCKET_GUARD = "off";
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
/** The folder test sessions work in. */
export const work = join(root, "work");
mkdirSync(work);

const { PocketApp } = await import("../src/server/app.ts");

export type App = Awaited<ReturnType<typeof PocketApp.open>>;

/** The text of the newest message a model request carries, and who sent it. */
export function lastText(context: { messages: readonly { role: string; content: unknown }[] }): {
    role: string;
    text: string;
} {
    const last = context.messages.findLast((message) => message.role !== "system")!;
    const content =
        typeof last.content === "string"
            ? [{ type: "text", text: last.content }]
            : (last.content as { type: string; text?: string }[]);

    return {
        role: last.role,
        text: content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join(""),
    };
}

/** Echoes the last message: enough for tests that do not care what Pi says. */
export const echo: FauxResponseStep = (context) =>
    fauxAssistantMessage([fauxText(`echo: ${lastText(context as never).text}`)]);

/** A scripted provider, "faux", that answers every request with `route`. */
export function scriptedModel(route: FauxResponseStep = echo) {
    const faux = fauxProvider({
        tokensPerSecond: 2000,
        models: [
            { id: "faux-1" },
            { id: "faux-2" },
            { id: "faux-vision", input: ["text", "image"] },
        ],
    });

    faux.setResponses(Array.from({ length: 200 }, () => route));

    return faux;
}

/** Open the app on `dataDir` with the scripted model. Opening the same folder again is a restart; `now` moves its clock. */
export async function openApp(
    model: ReturnType<typeof scriptedModel>,
    dataDir = join(root, "data"),
    now?: () => number,
): Promise<App> {
    const app = await PocketApp.open({
        dataDir,
        defaultCwd: work,
        supervised: false,
        log: () => {},
        configureModels: (models) => models.registerNativeProvider(model.provider),
        ...(now === undefined ? {} : { now }),
    });

    return app;
}

/** Open the app with the genuine native kernel enabled for positive mutation tests. */
export async function openNativeApp(
    model: ReturnType<typeof scriptedModel>,
    dataDir = join(root, "native-data"),
    now?: () => number,
): Promise<App> {
    const nativeProvider = {
        ...model.provider,
        id: "openai",
        name: "Synthetic native fixture",
        getModels: () =>
            model.provider.getModels().map((each) => ({
                ...each,
                provider: "openai",
                api: "openai-completions",
                baseUrl: "http://127.0.0.1:1/v1",
            })),
    };
    const app = await PocketApp.open({
        dataDir,
        defaultCwd: realpathSync(work),
        supervised: false,
        kernel: true,
        configureUserModels: (models) => models.registerNativeProvider(nativeProvider),
        ...(now === undefined ? {} : { now }),
    });

    return app;
}

/** Wait until `check` holds, polling. */
export async function until(
    check: () => Promise<boolean> | boolean,
    what: string,
    timeoutMs = 10_000,
): Promise<void> {
    const started = Date.now();

    while (!(await check())) {
        if (Date.now() - started > timeoutMs) {
            throw new Error(`Timed out waiting for ${what}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

/** Record `dollars` more of model usage in a conversation, the way a model response does: the scripted model costs nothing. */
export async function recordCost(app: App, id: ConversationId, dollars: number): Promise<void> {
    await app.harness.commit(async (tx) => {
        const usage = await tx.doc(UsageDoc, id);

        usage.models["faux/faux-1"] ??= {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        usage.models["faux/faux-1"].cost.output += dollars;
        usage.models["faux/faux-1"].cost.total += dollars;
    }, context);
}

export const owner = (app: App) => app.config.users.find((user) => user.role === "owner")!;

/** Seed a historical Durable conversation without invoking commands, submit, or any legacy callback. */
export async function seedHistoricalSession(app: App, cwd = work): Promise<ConversationId> {
    const conversation = await app.harness.createConversation(
        {
            ownership: { kind: "ownerless" },
            agent: {
                cwd,
                model: { provider: "faux", modelId: "faux-1" },
                thinkingLevel: "off",
            },
            init: async (tx, id) => {
                const sessions = await tx.doc(SessionsDoc);
                const now = Date.now();

                sessions.items[String(id)] = {
                    cwd,
                    createdAt: now,
                    updatedAt: now,
                    title: "Historical test session",
                };
                await tx.doc(ConfigurationDoc, id);
                await tx.doc(AgentDoc, id);
            },
        },
        context,
    );

    return conversation.id;
}

/** Append captured historical transcript data without dispatching a model or task. */
export async function appendHistoricalTurn(
    app: App,
    id: ConversationId,
    input: string,
    answer: string,
): Promise<void> {
    await app.harness.commit(async (tx) => {
        await tx.appendEntry(id, {
            kind: "pi.user",
            model: [{ role: "user", content: input, timestamp: Date.now() }],
        });
        await tx.appendEntry(id, {
            kind: "pi.assistant",
            model: [fauxAssistantMessage([fauxText(answer)])],
        });
    }, context);
}

/** Send a message as the owner and wait for Pi's answer. Legacy archive tests must not call this. */
export async function say(
    app: App,
    id: ConversationId,
    text: string,
    attachments?: Attachment[],
): Promise<void> {
    const { submissionId } = await app.commands.submit(id, owner(app), {
        text,
        requestId: crypto.randomUUID(),
        ...(attachments === undefined ? {} : { attachments }),
    });

    await (await app.harness.submission(submissionId, context))!.wait(context);
}

/** The texts of a conversation's entries as the model sees them, oldest first. */
export async function modelTexts(app: App, id: ConversationId): Promise<string[]> {
    const view = await (await app.harness.conversation(id, context))!.context(context);

    return view.messages.map((message) => JSON.stringify(message.content));
}

/** A browser tab as the app sees it, recording every event it is sent. Attach it with `app.attach(tab.client)`. */
export function fakeTab(id: ConversationId | undefined, user: User) {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const client: Client = {
        id: `tab-${crypto.randomUUID()}`,
        connection: `connection-${crypto.randomUUID()}`,
        user,
        conversationId: id,
        sentEntries: new Set<number>(),
        orderKey: "",
        send: (event: string, data: unknown) =>
            events.push({ event, data: data as Record<string, unknown> }),
    };
    const last = (event: string) => events.findLast((each) => each.event === event)?.data;
    /** A view field as a browser has it: updates leave out the fields that did not change. */
    const field = (name: string) =>
        events.findLast((each) => each.event === "view" && name in each.data)?.data[name];

    return { client, events, last, field };
}

/** Remove the temporary folder: call from `after`, once the app is closed. */
export function cleanUp(): void {
    rmSync(root, { recursive: true, force: true });
}

/** A user model account that may not run anything: kernel sessions can be made, and any inference fails. */
export const noInferenceModels = (models: ModelRuntime) =>
    models.registerNativeProvider({
        id: "openai",
        name: "No-inference image fixture",
        auth: {
            apiKey: {
                name: "Synthetic",
                resolve: async () => ({
                    auth: { apiKey: "fixture" },
                    source: "test",
                }),
            },
        },
        getModels: () => [
            {
                id: "image-fixture",
                name: "image-fixture",
                provider: "openai",
                api: "openai-completions",
                baseUrl: "http://127.0.0.1:1/v1",
                reasoning: false,
                input: ["text"],
                contextWindow: 32000,
                maxTokens: 1024,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
        ],
        stream: () => {
            throw new Error("No inference permitted");
        },
        streamSimple: () => {
            throw new Error("No inference permitted");
        },
    });
