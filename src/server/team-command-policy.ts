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

/** Presentation, not another registry: unknown trusted extensions remain discoverable and explicitly unverified. */
export type CommandWebInfo = { label: string; hint: string; args?: string; unavailable?: boolean };

const NATIVE_WEB_COMMANDS: Record<string, CommandWebInfo> = {
    llama: {
        label: "Terminal only",
        unavailable: true,
        hint: "/llama only works in the local terminal. Web cannot manage llama.cpp models.",
    },
    mcp: {
        label: "Web · partial",
        args: "[login|logout|reconnect] [server]",
        hint: "Web manages your MCP sign-ins. Use login/logout/reconnect; server definitions, enable/disable and exposure are owner-managed configuration.",
    },
    context: {
        label: "Web · read-only",
        args: "[usage|injections]",
        hint: "Inspect usage or injections without inference. Context configuration belongs to the owner-managed shared profile.",
    },
    goal: {
        label: "Web · partial",
        args: "[objective|status|pause|resume|clear|edit]",
        hint: "Opens the Web Goal manager. Starting or resuming can run your model; terminal safety-settings UI is not available.",
    },
    browser: {
        label: "Service machine",
        args: "[status|install|task]",
        hint: "Controls the service machine, not this device. Only exact status/install are controls; other text runs your model as a task. Install changes its browser integration and requires confirmation.",
    },
    "computer-use": {
        label: "Configuration report",
        hint: "Reports native computer-use configuration on the service machine, not a desktop action. Arguments are ignored.",
    },
    trace: {
        label: "Trace status",
        hint: "Reports the current runtime's trace metadata, not trace contents. Arguments are ignored.",
    },
    "qoder-models": {
        label: "Your account",
        hint: "Refreshes your own Qoder model catalog through Team's private account bridge. Arguments are ignored.",
    },
    "qoder-credits": {
        label: "Your account",
        hint: "Queries your own Qoder quota, not a bill or a per-request debit. Unknown stays unknown. Arguments are ignored.",
    },
    "subagent-cost": {
        label: "Usage report",
        hint: "Reports recorded subagent usage; missing costs are not zero. Arguments are ignored.",
    },
    "subagents-doctor": {
        label: "Diagnostics",
        hint: "Checks the native subagent setup; this does not launch a subagent or prove a task succeeded.",
    },
    "subagents-guide": {
        label: "Text help",
        args: "[topic]",
        hint: "Shows native subagent help for an optional single topic; it does not start work.",
    },
    "subagents-models": {
        label: "Model report",
        args: "[agent]",
        hint: "Reports native role model defaults for an optional agent, not a change to your execution's model or payer.",
    },
    "subagents-stop": {
        label: "Run control",
        args: "<run-id>",
        hint: "Requires an explicit run id from this session. A stop request is not proof that the child has closed.",
    },
    "subagents-detach": {
        label: "Limited in Team",
        args: "[run-id]",
        hint: "Only detaches an existing foreground single run. Team normally starts async work; this does not daemonize or complete it.",
    },
};

export function teamCommandWebInfo(command: {
    name: string;
    source?: unknown;
}): CommandWebInfo | undefined {
    if (command.source === "skill" || command.source === "prompt") {
        return {
            label: "Runs your model",
            hint:
                command.name === "skill:pi-subagents"
                    ? "Expands the native subagent skill and can run your model. Team supports owned async children, not programmable workflows or refinement generation."
                    : "Expands native instructions and can run inference and tools on your account. Skill-specific CLIs and access need setup on the service machine.",
        };
    }

    if (command.source !== "extension") {
        return undefined;
    }

    return Object.hasOwn(NATIVE_WEB_COMMANDS, command.name)
        ? NATIVE_WEB_COMMANDS[command.name]
        : {
              label: "Unverified extension",
              hint: "Discovered from trusted native code; Web interaction and side effects have not been verified. Review its instructions before running.",
          };
}

/** Refuse known no-op/unsupported paths before effects, and recheck at live registry admission. */
export function teamCommandInputError(
    command: { name: string; source?: unknown },
    args = "",
): string | undefined {
    if (command.source !== "extension") {
        return undefined;
    }

    const web = teamCommandWebInfo(command);

    if (web?.unavailable) {
        return web.hint;
    }

    if (command.name === "subagents-stop" && !args.trim()) {
        return "Use /subagents-stop <run-id> from this session. The terminal run selector is not available in Web.";
    }

    if (command.name === "mcp" && args.trim()) {
        const [action, , ...extra] = args.trim().split(/\s+/);

        if (!["login", "logout", "reconnect"].includes(action ?? "") || extra.length > 0) {
            return "Use /mcp [login|logout|reconnect] [server]. Server definitions, enable/disable and exposure belong to the owner-managed configuration.";
        }
    }

    return undefined;
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
