/** Native input identity, Goal branch state and prompt phase accounting. */
import type { ImageContent } from "@earendil-works/pi-ai";
import { KernelRequestConflict } from "../rotom-journal.ts";
import type { KernelRunSignal } from "../perf-channels.ts";
import type { RpcRecord } from "../rotom-rpc.ts";
import type { PromptTiming, Running } from "./contracts.ts";

/**
 * Text a member may send to Pi: ordinary words, or `/skill:name …`, which the kernel expands into that skill's
 * instructions. Other slash commands run in the kernel instead of reaching the model, outside the run's journal.
 */
export function nativeCommandName(text: string): string | undefined {
    return /^\/([^\s]+)(?:\s|$)/.exec(text.trimStart())?.[1];
}

/** Native extension dispatch requires `/` at byte zero and a literal space before arguments. */
export function normalizeNativePrompt(text: string): string {
    return text.trimStart().startsWith("/") ? text.trimStart().replace(/^(\/\S+)\s+/, "$1 ") : text;
}

export function nativeCommandArgs(text: string): string {
    const normalized = normalizeNativePrompt(text);
    const name = nativeCommandName(normalized);

    return name === undefined ? "" : normalized.slice(name.length + 1).trim();
}

export function isKnownNativeCommand(
    text: string,
    commands: ReadonlyArray<{ name?: unknown }>,
): boolean {
    if (!text.trimStart().startsWith("/")) {
        return true;
    }

    const name = nativeCommandName(text);

    return (
        name !== undefined &&
        commands.some((command) => command.name === name && !name.startsWith("team-kernel-"))
    );
}

export function isTeamPrompt(text: string): boolean {
    const trimmed = text.trim();

    // Native commands are admitted here and validated against the runtime registry after the
    // team journal has reserved the attempt. This keeps an unknown slash from becoming model text.
    return trimmed !== "" && (!trimmed.startsWith("/") || nativeCommandName(trimmed) !== undefined);
}

/** Slash handlers are not restartable prompts until native discovery proves a prompt/skill expansion. */
export function nativePromptOperation(text: string): "prompt" | "command" {
    return text.trimStart().startsWith("/") ? "command" : "prompt";
}

/** Text-only receipts keep their existing identity; image bytes are part of request identity. */
export function nativePromptIdentity(text: string, images: ImageContent[] = []): string {
    return images.length === 0 ? text : JSON.stringify({ text, images });
}

/** Fold one native event into a prompt run's timing. Only events after the prompt's dispatch count. */
export function timePromptEvent(timing: PromptTiming, event: RpcRecord): void {
    if (timing.dispatchedAt === undefined) {
        return;
    }

    const now = performance.now();

    if (event.type === "message_update") {
        timing.firstOutputAt ??= now;
    } else if (event.type === "tool_execution_start") {
        timing.tools++;

        if (timing.toolsRunning++ === 0) {
            timing.toolsSince = now;
        }
    } else if (event.type === "tool_execution_end" && timing.toolsRunning > 0) {
        if (--timing.toolsRunning === 0) {
            timing.toolMs += now - timing.toolsSince;
        }
    }
}

export function promptPhases(
    timing: PromptTiming | undefined,
    startedAt: number,
    endedAt: number,
): Pick<KernelRunSignal, "prompt"> {
    if (timing?.process === undefined || timing.dispatchedAt === undefined) {
        return {};
    }

    return {
        prompt: {
            process: timing.process,
            dispatchMs: timing.dispatchedAt - startedAt,
            firstOutputMs:
                timing.firstOutputAt === undefined
                    ? null
                    : timing.firstOutputAt - timing.dispatchedAt,
            // A run that ended with a tool still running (an error, a stop) counts it to the end.
            toolMs: timing.toolMs + (timing.toolsRunning > 0 ? endedAt - timing.toolsSince : 0),
            tools: timing.tools,
        },
    };
}

export function goalIsActive(value: unknown): boolean {
    if (!value || typeof value !== "object") {
        return false;
    }

    const goal = (value as { goal?: unknown }).goal;

    return (
        goal !== null &&
        typeof goal === "object" &&
        ["active", "queued"].includes(String((goal as { status?: unknown }).status))
    );
}

export function currentBranchGoalState(value: unknown): unknown {
    if (!value || typeof value !== "object") {
        return undefined;
    }

    const data = value as { entries?: unknown; leafId?: unknown };

    if (!Array.isArray(data.entries) || typeof data.leafId !== "string") {
        return undefined;
    }

    const byId = new Map<
        string,
        { id?: unknown; parentId?: unknown; customType?: unknown; data?: unknown }
    >();

    for (const entry of data.entries) {
        if (entry && typeof entry === "object") {
            const item = entry as {
                id?: unknown;
                parentId?: unknown;
                customType?: unknown;
                data?: unknown;
            };

            if (typeof item.id === "string") {
                byId.set(item.id, item);
            }
        }
    }

    const branch: Array<{
        id?: unknown;
        parentId?: unknown;
        customType?: unknown;
        data?: unknown;
    }> = [];
    let id: string | undefined = data.leafId;

    while (id !== undefined) {
        const entry = byId.get(id);

        if (!entry) {
            break;
        }

        branch.push(entry);
        id = typeof entry.parentId === "string" ? entry.parentId : undefined;
    }

    return branch.find((entry) => entry.customType === "goal-state")?.data;
}

export function assertNotStopped(running: Running): void {
    if (running.aborted) {
        throw new KernelRequestConflict("Stopped before native dispatch or materialization");
    }
}
