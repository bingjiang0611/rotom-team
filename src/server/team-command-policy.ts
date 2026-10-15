/** Team's supported native command surface; discovery still owns names, metadata and execution. */
export const TEAM_BUILTIN_COMMANDS = new Set([
    "settings",
    "model",
    "thinking",
    "tree",
    "fork",
    "clone",
    "compact",
    "reload",
]);
const EXTENSIONS = new Set(["goal", "browser", "computer-use", "mcp", "qoder-credits"]);

export function supportedTeamCommand(command: { name: string; source?: unknown }): boolean {
    return (
        !command.name.startsWith("team-kernel-") &&
        (TEAM_BUILTIN_COMMANDS.has(command.name) ||
            EXTENSIONS.has(command.name) ||
            command.source === "skill" ||
            command.source === "prompt")
    );
}

/** Resolve native precedence before filtering: a hidden extension must not reappear as a same-name template. */
export function teamCommandCatalog<T extends { name: string; source?: string }>(
    commands: T[],
): T[] {
    const names = new Set<string>();

    return commands.filter((command) => {
        if (names.has(command.name)) {
            return false;
        }

        names.add(command.name);

        return supportedTeamCommand(command);
    });
}

/** Builtins use Team adapters even while busy; a bare Goal opens the web manager, not a queued prompt. */
export function teamCommandUsesAdapter(text: unknown): boolean {
    // Leave malformed HTTP input to the kernel's existing validation, rather than throwing in routing.
    if (typeof text !== "string") {
        return false;
    }

    const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());

    return Boolean(
        match && (TEAM_BUILTIN_COMMANDS.has(match[1]!) || (match[1] === "goal" && !match[2])),
    );
}
