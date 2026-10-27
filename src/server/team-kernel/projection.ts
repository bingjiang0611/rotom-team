import type { KernelEntry } from "../rotom-journal.ts";
import type { RpcRecord } from "../rotom-rpc.ts";

/**
 * What everyone in the room may see of a native entry: an answer's text and tool calls, without reasoning or provider
 * signatures, as handoff does. The complete entry stays in the kernel journal.
 */
function publicEntry(entry: KernelEntry): KernelEntry {
    const message = entry.message as
        { role?: unknown; content?: { type?: unknown; [key: string]: unknown }[] } | undefined;

    if (
        entry.type !== "message" ||
        message?.role !== "assistant" ||
        !Array.isArray(message.content)
    ) {
        return entry;
    }

    return {
        ...entry,
        message: {
            ...message,
            content: message.content.flatMap((part): Record<string, unknown>[] =>
                part.type === "text"
                    ? [{ type: "text", text: part.text }]
                    : part.type === "toolCall"
                      ? [
                            {
                                type: "toolCall",
                                id: part.id,
                                name: part.name,
                                arguments: part.arguments,
                            },
                        ]
                      : [],
            ),
        },
    };
}

/**
 * Apply one streamed delta to the in-flight answer. Rotom's RPC sends deltas, not the whole partial message. Reasoning
 * is not shown live, as it is not shown once persisted. Returns whether anything visible changed.
 */
function applyUpdate(message: { content: Record<string, unknown>[] }, event: RpcRecord): boolean {
    const update = event.assistantMessageEvent as
        | {
              type?: string;
              contentIndex?: number;
              delta?: string;
              content?: string;
              id?: string;
              toolName?: string;
              toolCall?: Record<string, unknown>;
          }
        | undefined;
    const index = update?.contentIndex;

    if (!update || typeof index !== "number" || !Number.isInteger(index) || index < 0) {
        return false;
    }

    const content = message.content;
    const text = typeof content[index]?.text === "string" ? (content[index].text as string) : "";

    switch (update.type) {
        case "text_start":
            content[index] = { type: "text", text: "" };

            return true;

        case "text_delta":
            content[index] = { type: "text", text: text + String(update.delta ?? "") };

            return true;

        case "text_end":
            content[index] = { type: "text", text: String(update.content ?? text) };

            return true;

        case "toolcall_start":
            content[index] = {
                type: "toolCall",
                id: String(update.id ?? ""),
                name: String(update.toolName ?? ""),
                arguments: {},
            };

            return true;

        case "toolcall_end":
            if (!update.toolCall) {
                return false;
            }

            content[index] = update.toolCall;

            return true;

        default:
            return false;
    }
}

export { publicEntry, applyUpdate };
