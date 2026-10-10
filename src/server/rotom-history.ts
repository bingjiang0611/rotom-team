/** Cross-account native history is an allowlisted context projection, never a copied session tree. */
import type { Message, TextContent, ImageContent, ToolCall, Usage } from "@earendil-works/pi-ai";

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Invalid native history record");
    }

    return value as Record<string, unknown>;
}

function text(value: unknown): string {
    if (typeof value !== "string") {
        throw new Error("Invalid native history text");
    }

    return value;
}

function number(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error("Invalid native history number");
    }

    return value;
}

function content(value: unknown): (TextContent | ImageContent)[] {
    if (typeof value === "string") {
        return [{ type: "text", text: value }];
    }

    if (!Array.isArray(value)) {
        throw new Error("Invalid native history content");
    }

    return value.flatMap<TextContent | ImageContent>((value) => {
        const part = record(value);

        if (part.type === "text") {
            return [{ type: "text", text: text(part.text) }];
        }

        if (part.type === "image") {
            return [{ type: "image", data: text(part.data), mimeType: text(part.mimeType) }];
        }

        // Thinking, signatures and extension-specific content are not public context.
        return [];
    });
}

function usage(value: unknown): Usage {
    const source = record(value);
    const cost = record(source.cost);

    return {
        input: number(source.input),
        output: number(source.output),
        cacheRead: number(source.cacheRead),
        cacheWrite: number(source.cacheWrite),
        totalTokens: number(source.totalTokens),
        ...(source.reasoning !== undefined ? { reasoning: number(source.reasoning) } : {}),
        ...(source.cacheWrite1h !== undefined ? { cacheWrite1h: number(source.cacheWrite1h) } : {}),
        cost: {
            input: number(cost.input),
            output: number(cost.output),
            cacheRead: number(cost.cacheRead),
            cacheWrite: number(cost.cacheWrite),
            total: number(cost.total),
        },
    };
}

/** Input must be the pinned SessionManager's active projection, not getEntries()/the full tree.
 * Historical usage remains historical: the journal seed operation must exclude it from new-payer billing.
 * Incomplete tool pairs require reconciliation; inventing a tool result could authorize an unsafe replay.
 */
export function publicNativeHistory(messages: readonly unknown[]): Message[] {
    const output: Message[] = [];
    const pending = new Map<string, { id: string; name: string }>();
    let toolIndex = 0;

    const requirePaired = () => {
        if (pending.size) {
            throw new Error(
                "Unpaired native tool history; reconcile outcomes before handoff or fork",
            );
        }
    };

    for (const value of messages) {
        const message = record(value);
        const role = message.role;

        // Never inherit system/tool definitions, arbitrary custom state or private native metadata.
        if (
            !["user", "assistant", "toolResult", "compactionSummary", "branchSummary"].includes(
                String(role),
            )
        ) {
            continue;
        }

        const timestamp = number(message.timestamp);

        if (role !== "toolResult") {
            requirePaired();
        }

        if (role === "user") {
            output.push({ role: "user", content: content(message.content), timestamp });
        } else if (role === "assistant") {
            if (
                !Array.isArray(message.content) ||
                !["stop", "length", "toolUse", "error", "aborted"].includes(
                    String(message.stopReason),
                )
            ) {
                throw new Error("Unsettled or invalid native assistant history");
            }

            const parts = message.content.flatMap<TextContent | ToolCall>((value) => {
                const part = record(value);

                if (part.type === "text") {
                    return [{ type: "text", text: text(part.text) }];
                }

                if (part.type !== "toolCall") {
                    return [];
                }

                const sourceId = text(part.id);
                const name = text(part.name);

                if (pending.has(sourceId)) {
                    throw new Error("Duplicate native tool call identity");
                }

                // Pair both sides with a provider-neutral ID; do not carry a Responses item ID or account marker.
                const id = `team_tool_${++toolIndex}`;

                pending.set(sourceId, { id, name });

                return [
                    {
                        type: "toolCall",
                        id,
                        name,
                        arguments: structuredClone(record(part.arguments)) as ToolCall["arguments"],
                    },
                ];
            });

            if (parts.length) {
                output.push({
                    role: "assistant",
                    content: parts,
                    api: text(message.api),
                    provider: "team-public-history",
                    model: text(message.model),
                    usage: usage(message.usage),
                    stopReason: message.stopReason as
                        "stop" | "length" | "toolUse" | "error" | "aborted",
                    timestamp,
                });
            }
        } else if (role === "toolResult") {
            const call = pending.get(text(message.toolCallId));

            if (!call || call.name !== message.toolName || typeof message.isError !== "boolean") {
                throw new Error(
                    "Unpaired native tool result; reconcile outcomes before handoff or fork",
                );
            }

            pending.delete(text(message.toolCallId));
            output.push({
                role: "toolResult",
                toolCallId: call.id,
                toolName: call.name,
                content: content(message.content),
                isError: message.isError,
                timestamp,
                ...(message.usage !== undefined ? { usage: usage(message.usage) } : {}),
            });
        } else {
            output.push({
                role: "user",
                content: `Prior conversation summary:\n${text(message.summary)}`,
                timestamp,
            });
        }
    }

    requirePaired();

    return output;
}
