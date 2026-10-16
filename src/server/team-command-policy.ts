/** Builtins implemented by Team instead of dispatching the terminal command directly. */
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

/**
 * Terminal-only builtins that would mutate credentials/session lifecycle, upload data, or require a TUI. Dynamic
 * extension, skill and prompt commands are admitted from the live native registry instead of a second Team allowlist.
 */
const PROTECTED_NATIVE_BUILTINS = new Set([
    "scoped-models",
    "export",
    "import",
    "share",
    "bug",
    "changelog",
    "hotkeys",
    "trust",
    "login",
    "logout",
    "new",
    "resume",
    "quit",
]);

export function supportedTeamCommand(command: { name: string; source?: unknown }): boolean {
    return !command.name.startsWith("team-kernel-") && !PROTECTED_NATIVE_BUILTINS.has(command.name);
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
        match &&
        (TEAM_BUILTIN_COMMANDS.has(match[1]!) ||
            match[1] === "context" ||
            (match[1] === "goal" && !match[2])),
    );
}
