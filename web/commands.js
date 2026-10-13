// Native slash commands from the pinned rotom runtime. Pocket does not maintain a second command registry.
import { actions, store } from "./store.js";

const COMMANDS_FOR_MS = 30_000;

/** Fetch the command registry for this conversation while someone is typing a slash command. */
export function loadTemplates() {
    const id = store.state.conversationId;
    const cached = store.state.templates;

    if (
        id === null ||
        (cached?.conversationId === id && Date.now() - cached.at < COMMANDS_FOR_MS)
    ) {
        return;
    }

    store.set({
        templates: {
            conversationId: id,
            at: Date.now(),
            list: cached?.conversationId === id ? cached.list : [],
        },
    });
    actions.prompts().then(
        (result) =>
            store.state.templates?.conversationId === id &&
            store.set({
                templates: {
                    ...store.state.templates,
                    list: Array.isArray(result) ? result : result.commands,
                    dynamicReady: Array.isArray(result) ? true : result.dynamicReady,
                    capturedAt: result.capturedAt,
                },
            }),
        () => {},
    );
}

/** Only an explicit member action may load trusted project code for command discovery. */
export async function discoverCommands() {
    const id = store.state.conversationId;
    const result = await actions.discoverCommands();

    if (result.receipt.status !== "handled") {
        throw new Error(
            `Native discovery ended ${result.receipt.status}; do not replay an unknown operation.`,
        );
    }

    if (store.state.conversationId === id) {
        store.set({
            templates: {
                conversationId: id,
                at: Date.now(),
                list: result.commands,
                dynamicReady: result.dynamicReady,
                capturedAt: result.capturedAt,
            },
        });
    }
}

function commands() {
    const cached = store.state.templates;

    if (cached?.conversationId !== store.state.conversationId) {
        return [];
    }

    return cached.list.map((command) => ({
        name: command.name,
        args: command.argumentHint ?? "",
        description: command.description ?? "",
        native: true,
        source: command.source,
    }));
}

/** The native command in a complete `/name [arguments]` message, or null for ordinary text. */
export function parseCommand(text) {
    const match = /^\/([a-z][\w:-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());

    if (!match) {
        return null;
    }

    const command = commands().find((each) => each.name === match[1]);

    return command ? { command, arg: (match[2] ?? "").trim() } : null;
}

/** Commands to offer while someone types a command name. */
export function suggestCommands(text) {
    const match = /^\/([\w:-]*)$/.exec(text);

    if (!match) {
        return [];
    }

    const prefix = match[1].toLowerCase();
    const own = commands();
    const starts = own.filter((each) => each.name.toLowerCase().startsWith(prefix));
    const contains =
        prefix.length < 2
            ? []
            : own.filter(
                  (each) =>
                      !each.name.toLowerCase().startsWith(prefix) &&
                      each.name.toLowerCase().includes(prefix),
              );

    return [...starts, ...contains];
}

// These extension availability checks still control ordinary web bars and menu actions. They are
// not slash-command entries.
export const planAvailable = () => store.state.server?.extensions?.includes("pocket-plan") === true;
export const schedulesAvailable = () =>
    store.state.view.conversation?.kind === "session" &&
    store.state.server?.extensions?.includes("pocket-schedules") === true;
