/**
 * Rows for the browser's native /tree selector. Text follows the pinned terminal TreeSelectorComponent
 * (getEntryDisplayText, getSearchableText, formatToolCall); full tool payloads never leave the server.
 */
import type { KernelEntry } from "./rotom-journal.ts";

/** A run of text and the terminal theme color it is drawn in. */
type Part = [tone: string, text: string];

export type NativeTreeNode = {
    id: string;
    parentId: string | null;
    timestamp: string;
    type: string;
    role?: string;
    label?: string;
    labelTimestamp?: string;
    parts: Part[];
    search: string;
    /** An assistant message with only tool calls, which the terminal hides unless it is the leaf. */
    toolOnly?: true;
};

type Message = {
    role?: string;
    content?: unknown;
    stopReason?: string;
    errorMessage?: string;
    toolCallId?: string;
    toolName?: string;
    command?: string;
};

type ToolCall = { name: string; arguments: Record<string, unknown> };

const normalize = (text: string) => text.replace(/[\n\t]/g, " ").trim();

function fullText(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }

    if (!Array.isArray(content)) {
        return "";
    }

    return content
        .filter((block) => block?.type === "text")
        .map((block) => String(block.text))
        .join("");
}

const extract = (content: unknown) => fullText(content).slice(0, 200);

function hasText(content: unknown): boolean {
    if (typeof content === "string") {
        return content.trim().length > 0;
    }

    return (
        Array.isArray(content) &&
        content.some((block) => block?.type === "text" && String(block.text ?? "").trim())
    );
}

function shortenPath(path: string): string {
    const home = process.env.HOME || process.env.USERPROFILE || "";

    return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function formatToolCall(name: string, args: Record<string, unknown>): string {
    const path = (fallback: string) => shortenPath(String(args.path || args.file_path || fallback));

    switch (name) {
        case "read": {
            let display = path("");

            if (args.offset !== undefined || args.limit !== undefined) {
                const start = (args.offset as number | undefined) ?? 1;
                const end = args.limit !== undefined ? start + (args.limit as number) - 1 : "";

                display += `:${start}${end ? `-${end}` : ""}`;
            }

            return `[read: ${display}]`;
        }

        case "write":
            return `[write: ${path("")}]`;

        case "edit":
            return `[edit: ${path("")}]`;

        case "bash": {
            const raw = String(args.command || "");

            return `[bash: ${normalize(raw).slice(0, 50)}${raw.length > 50 ? "..." : ""}]`;
        }

        case "grep":
            return `[grep: /${String(args.pattern || "")}/ in ${shortenPath(String(args.path || "."))}]`;

        case "find":
            return `[find: ${String(args.pattern || "")} in ${shortenPath(String(args.path || "."))}]`;

        case "ls":
            return `[ls: ${shortenPath(String(args.path || "."))}]`;

        default: {
            const json = JSON.stringify(args);

            return `[${name}: ${json.slice(0, 40)}${json.length > 40 ? "..." : ""}]`;
        }
    }
}

function display(entry: KernelEntry, toolCalls: Map<string, ToolCall>): Part[] {
    const message = entry.message as Message | undefined;

    switch (entry.type) {
        case "message": {
            const role = message!.role!;

            if (role === "user") {
                return [
                    ["accent", "user: "],
                    ["", normalize(extract(message!.content))],
                ];
            }

            if (role === "assistant") {
                const text = normalize(extract(message!.content));

                if (text) {
                    return [
                        ["success", "assistant: "],
                        ["", text],
                    ];
                }

                if (message!.stopReason === "aborted") {
                    return [
                        ["success", "assistant: "],
                        ["muted", "(aborted)"],
                    ];
                }

                if (message!.errorMessage) {
                    return [
                        ["success", "assistant: "],
                        ["error", normalize(message!.errorMessage).slice(0, 80)],
                    ];
                }

                return [
                    ["success", "assistant: "],
                    ["muted", "(no content)"],
                ];
            }

            if (role === "toolResult") {
                const call = message!.toolCallId ? toolCalls.get(message!.toolCallId) : undefined;

                return [
                    [
                        "muted",
                        call
                            ? formatToolCall(call.name, call.arguments)
                            : `[${message!.toolName ?? "tool"}]`,
                    ],
                ];
            }

            if (role === "bashExecution") {
                return [["dim", `[bash]: ${normalize(message!.command ?? "")}`]];
            }

            return [["dim", `[${role}]`]];
        }

        case "custom_message":
            return [
                ["customMessageLabel", `[${String(entry.customType)}]: `],
                ["", normalize(fullText(entry.content))],
            ];

        case "compaction":
            return [
                [
                    "borderAccent",
                    `[compaction: ${Math.round(Number(entry.tokensBefore) / 1000)}k tokens]`,
                ],
            ];

        case "branch_summary":
            return [
                ["warning", "[branch summary]: "],
                ["", normalize(String(entry.summary))],
            ];

        case "model_change":
            return [["dim", `[model: ${String(entry.modelId)}]`]];

        case "thinking_level_change":
            return [["dim", `[thinking: ${String(entry.thinkingLevel)}]`]];

        case "custom":
            return [["dim", `[custom: ${String(entry.customType)}]`]];

        case "context_edit":
            return [
                [
                    "dim",
                    `[context ${entry.replacement === null ? "omit" : "replace"}: ${String(entry.targetId)}]`,
                ],
            ];

        case "label":
            return [["dim", `[label: ${(entry.label as string | undefined) ?? "(cleared)"}]`]];

        case "session_info":
            return entry.name
                ? [["dim", `[title: ${String(entry.name)}]`]]
                : [
                      ["dim", "[title: "],
                      ["dim italic", "empty"],
                      ["dim", "]"],
                  ];

        default:
            return [];
    }
}

function searchable(entry: KernelEntry, label: string | undefined): string {
    const message = entry.message as Message | undefined;
    const parts: string[] = label ? [label] : [];

    switch (entry.type) {
        case "message":
            parts.push(message!.role!);

            if (message!.content) {
                parts.push(extract(message!.content));
            }

            if (message!.role === "bashExecution" && message!.command) {
                parts.push(message!.command);
            }

            break;

        case "custom_message":
            parts.push(String(entry.customType), extract(entry.content));
            break;

        case "compaction":
            parts.push("compaction");
            break;

        case "branch_summary":
            parts.push("branch summary", String(entry.summary));
            break;

        case "session_info":
            parts.push("title");

            if (entry.name) {
                parts.push(String(entry.name));
            }

            break;

        case "model_change":
            parts.push("model", String(entry.modelId));
            break;

        case "thinking_level_change":
            parts.push("thinking", String(entry.thinkingLevel));
            break;

        case "custom":
            parts.push("custom", String(entry.customType));
            break;

        case "context_edit":
            parts.push(
                "context edit",
                entry.replacement === null ? "omit" : "replace",
                String(entry.targetId),
            );
            break;

        case "label":
            parts.push("label", (entry.label as string | undefined) ?? "");
            break;
    }

    return parts.join(" ");
}

/** Every entry of a native segment as a tree row, and the leaf the selector starts on. */
export function nativeTreeNodes(entries: KernelEntry[]): {
    nodes: NativeTreeNode[];
    leafId: string | null;
} {
    const sessionEntries = entries.filter((entry) => entry.type !== "session");
    const labels = new Map<string, { label: string; timestamp: string }>();
    const toolCalls = new Map<string, ToolCall>();

    for (const entry of sessionEntries) {
        if (entry.type === "label") {
            if (entry.label) {
                labels.set(String(entry.targetId), {
                    label: String(entry.label),
                    timestamp: String(entry.timestamp),
                });
            } else {
                labels.delete(String(entry.targetId));
            }
        }

        const message = entry.message as Message | undefined;

        if (entry.type === "message" && message?.role === "assistant") {
            for (const block of Array.isArray(message.content) ? message.content : []) {
                if (block?.type === "toolCall") {
                    toolCalls.set(block.id, { name: block.name, arguments: block.arguments });
                }
            }
        }
    }

    const nodes = sessionEntries.map((entry): NativeTreeNode => {
        const message = entry.message as Message | undefined;
        const label = labels.get(entry.id!);
        const node: NativeTreeNode = {
            id: entry.id!,
            parentId: typeof entry.parentId === "string" ? entry.parentId : null,
            timestamp: String(entry.timestamp),
            type: entry.type,
            parts: display(entry, toolCalls),
            search: searchable(entry, label?.label),
        };

        if (entry.type === "message") {
            node.role = message!.role;
        }

        if (label) {
            node.label = label.label;
            node.labelTimestamp = label.timestamp;
        }

        if (
            message?.role === "assistant" &&
            !hasText(message.content) &&
            !(
                message.stopReason &&
                message.stopReason !== "stop" &&
                message.stopReason !== "toolUse"
            )
        ) {
            node.toolOnly = true;
        }

        return node;
    });

    return { nodes, leafId: sessionEntries.at(-1)?.id ?? null };
}
