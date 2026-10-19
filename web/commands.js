// Native slash commands from the pinned rotom runtime. Pocket does not maintain a second command registry.
import { actions, canSteer, store } from "./store.js";

const COMMANDS_FOR_MS = 30_000;
const discovering = new Map();
const unknownDiscovery = new Set();
const failedDiscovery = new Set();
let menuInput;
const discoveryScope = () =>
    `${store.state.me?.id}:${store.state.conversationId}:${store.state.view.kernel?.segmentId}`;

/** Fetch the command registry for this conversation while someone is typing a slash command. */
export function loadTemplates(text) {
    menuInput = { conversationId: store.state.conversationId, text };
    const id = store.state.conversationId;
    const scope = discoveryScope();
    const cached = store.state.templates;

    if (
        !text.startsWith("/") ||
        id === null ||
        (cached?.scope === scope && Date.now() - cached.at < COMMANDS_FOR_MS)
    ) {
        return;
    }

    store.set({
        templates: {
            ...(cached?.scope === scope ? cached : {}),
            conversationId: id,
            scope,
            at: Date.now(),
            list: cached?.scope === scope ? cached.list : [],
        },
    });
    actions.prompts().then(
        async (result) => {
            if (discoveryScope() !== scope || store.state.templates?.conversationId !== id) {
                return;
            }

            store.set({
                templates: {
                    ...store.state.templates,
                    list: Array.isArray(result) ? result : result.commands,
                    dynamicReady: Array.isArray(result) ? true : result.dynamicReady,
                    capturedAt: result.capturedAt,
                    revision: result.revision,
                    freshness: result.freshness,
                },
            });

            // This function is called by composer input, not by room subscription or GET.
            // Opening slash suggestions is an explicit member discovery action; it never authorizes inference.
            if (
                store.state.view.kernel &&
                canSteer() &&
                menuInput?.conversationId === id &&
                menuInput.text.startsWith("/") &&
                !parseCommand(menuInput.text) &&
                !result.discoveryBlocked &&
                !unknownDiscovery.has(discoveryScope()) &&
                !failedDiscovery.has(discoveryScope()) &&
                (!result.dynamicReady || result.freshness === "configuration-changed") &&
                !store.state.view.live?.busy &&
                !discovering.has(scope)
            ) {
                try {
                    await discoverCommands();
                } catch (error) {
                    if (
                        discoveryScope() === scope &&
                        store.state.templates?.conversationId === id
                    ) {
                        store.set({
                            templates: { ...store.state.templates, discoveryError: error.message },
                        });
                    }
                }
            }
        },
        (error) => {
            if (discoveryScope() === scope && store.state.templates?.conversationId === id) {
                store.set({
                    templates: {
                        ...store.state.templates,
                        freshness: "unavailable",
                        discoveryError: error.message,
                    },
                });
            }
        },
    );
}

/** Only an explicit member action may load trusted Team extensions for command discovery. */
export async function discoverCommands() {
    const id = store.state.conversationId;
    const scope = discoveryScope();

    if (unknownDiscovery.has(scope)) {
        throw new Error("Reconcile unknown discovery before refreshing this session.");
    }

    if (!discovering.has(scope)) {
        discovering.set(scope, actions.discoverCommands());
    }

    try {
        const result = await discovering.get(scope);

        if (result.receipt.status === "unknown") {
            unknownDiscovery.add(scope);
        }

        if (result.receipt.status !== "handled") {
            throw new Error(
                `Native discovery ended ${result.receipt.status}; do not replay an unknown operation.`,
            );
        }

        failedDiscovery.delete(scope);

        if (discoveryScope() === scope) {
            store.set({
                templates: {
                    conversationId: id,
                    scope,
                    at: Date.now(),
                    list: result.commands,
                    dynamicReady: result.dynamicReady,
                    capturedAt: result.capturedAt,
                    revision: result.revision,
                    freshness: result.freshness,
                },
            });
        }
    } catch (error) {
        failedDiscovery.add(scope);

        throw error;
    } finally {
        discovering.delete(scope);
    }
}

function commands() {
    const cached = store.state.templates;

    if (cached?.scope !== discoveryScope()) {
        return [];
    }

    return cached.list.map((command) => ({
        name: command.name,
        args: command.web?.args ?? command.argumentHint ?? "",
        description: command.description ?? "",
        native: true,
        source: command.source,
        web: command.web,
    }));
}

/** The native command in a complete `/name [arguments]` message, or null for ordinary text. */
export function parseCommand(text) {
    const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());

    if (!match) {
        return null;
    }

    const command = commands().find((each) => each.name === match[1]);

    return command ? { command, arg: (match[2] ?? "").trim() } : null;
}

/** Commands to offer while someone types a command name. */
export function suggestCommands(text) {
    const match = /^\/([^\s]*)$/.exec(text);

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
