// A tool call in one line, as transcripts and peek tiles show it.

const short = (text, max = 90) => {
    const flat = String(text ?? "")
        .replace(/\s+/g, " ")
        .trim();

    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** A tool call in one line: an icon, a label, and what it acts on. Peek tiles describe calls this way too. */
export function describeCall(call) {
    const args = call.args ?? {};

    switch (call.name) {
        case "read": {
            const range = args.offset ? `:${args.offset}${args.limit ? `+${args.limit}` : ""}` : "";

            return { icon: "▤", label: "Read", subject: `${args.path ?? ""}${range}`, mono: true };
        }

        case "write":
            return { icon: "✎", label: "Write", subject: args.path ?? "", mono: true };
        case "edit":
            return { icon: "✎", label: "Edit", subject: args.path ?? "", mono: true };
        case "bash":
            return { icon: ">_", label: "", subject: short(args.command, 140), mono: true };
        case "artifact":
            return {
                icon: "✦",
                label: "Artifact",
                subject: args.title ?? args.id ?? "",
                mono: false,
            };

        case "codemode": {
            // The first line that does something: not the options line, a comment, or blank.
            const line = String(args.code ?? "")
                .split("\n")
                .map((each) => each.trim())
                .find((each) => each !== "" && !each.startsWith("//"));

            return { icon: "{}", label: "Codemode", subject: short(line ?? "", 140), mono: true };
        }

        case "browser": {
            const firstLine = String(args.script ?? "")
                .split("\n")
                .find((each) => each.trim() !== "");
            const what =
                args.url ??
                (args.ref ? `[${String(args.ref).replace(/^\[|\]$/g, "")}]` : undefined) ??
                args.selector ??
                (args.label ? `“${args.label}”` : undefined) ??
                args.key ??
                args.viewport ??
                firstLine ??
                (args.text !== undefined ? `“${args.text}”` : "");
            const typed =
                args.action === "type" && args.text !== undefined && what !== `“${args.text}”`
                    ? ` ← “${args.text}”`
                    : "";

            return {
                icon: "◎",
                label: `Browser ${args.action ?? ""}`,
                subject: short(`${what}${typed}`, 120),
                mono: true,
            };
        }

        case "subagent":
            return {
                icon: "⧉",
                label: `Subagent ${args.action ?? ""}`,
                subject: [args.name, args.message && short(args.message, 60)]
                    .filter(Boolean)
                    .join(" · "),
                mono: true,
            };
        default:
            return {
                icon: "⚙",
                label: call.name,
                subject: short(JSON.stringify(args), 100),
                mono: true,
            };
    }
}

/** Successful file writes in the shared audit history, not a disk index or saved file versions. */
export function writtenFiles(entries) {
    const calls = new Map();
    const files = new Map();

    const add = (name, path, entryId) => {
        const action = String(name).toLowerCase();

        if (
            !["write", "edit"].includes(action) ||
            typeof path !== "string" ||
            !path.trim() ||
            /[\u0000\r\n]/.test(path)
        ) {
            return;
        }

        files.delete(path);
        files.set(path, { path, action, entryId });
    };

    for (const entry of entries) {
        if (entry.kind === "assistant") {
            for (const block of entry.blocks ?? []) {
                if (block.type === "toolCall") {
                    calls.set(block.id, block);
                }
            }
        } else if (entry.kind === "toolResult") {
            const call = calls.get(entry.callId);

            if (!call) {
                continue;
            }

            const pathKey = typeof call.args?.path === "string" ? "path" : "file_path";

            if (!entry.isError && !call.clipped?.[pathKey]) {
                add(call.name, call.args?.[pathKey], entry.id);
            }

            if (call.name === "codemode" && Array.isArray(entry.details?.calls)) {
                for (const child of entry.details.calls) {
                    if (child.status === "ok") {
                        add(child.name, child.path, entry.id);
                    }
                }
            }
        }
    }

    return [...files.values()].reverse();
}
