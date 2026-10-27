import { createServer } from "node:http";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { KernelRunSignal } from "../perf-channels.ts";
import type { KernelBinding, KernelEntry, KernelReceipt } from "../rotom-journal.ts";
import type { RotomRpc, RpcRecord } from "../rotom-rpc.ts";
import { materializeSeed } from "./seed.ts";

export type QoderRequestAuth = {
    credential: {
        accessToken: string;
        fingerprint: string;
        expiresAt: number;
        uid: string | number;
        org: string | number;
        machineId: string;
    };
    catalog: { scope: string; checkedAt: number; metadata: unknown };
};

export type KernelRequestAuth = {
    qoder?: QoderRequestAuth;
    apiKey?: string;
    baseUrl?: string;
    headers?: Record<string, string | null>;
};
export type KernelLaunchContext = {
    modelDefinition: {
        id: string;
        name: string;
        api: string;
        baseUrl: string;
        [key: string]: unknown;
    };
    /** A legacy frozen snapshot; absent: rotom loads the project's and the member's own layers natively. */
    frozen?: { context: string; skills: string[] };
};

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

/** Observers of one prompt: none may change its outcome, and a failing observer cannot authorize work. */
export type RunHooks = {
    /** The intent is durably committed: the request can no longer be lost, only end unknown. */
    onReserved?: (receipt: KernelReceipt) => void | Promise<void>;
    /** A dynamic slash passed live registry validation; the consumer may still refuse before dispatch. */
    onCommandAdmitted?: (command: {
        name: string;
        source?: unknown;
        args?: string;
    }) => void | Promise<void>;
    /** Every kernel event, for provisional display only. */
    onEvent?: (event: RpcRecord) => void | Promise<unknown>;
    /** The registry captured from this authorized kernel process. */
    onCommands?: (commands: Array<Record<string, unknown>>) => void | Promise<void>;
    /** Canonical Goal state read from the current native branch after a handled barrier. */
    onNativeGoalState?: (state: unknown) => void;
    /** Team title after reservation; native handoff seeds do not carry session metadata. */
    sessionName?: () => string | undefined;
    onSessionName?: (name: string) => Promise<void>;
    /** Result from a structured native command adapter. */
    onNativeResult?: (result: unknown) => void | Promise<void>;
    /** New persisted entries were journaled mid-run. */
    onProgress?: () => void | Promise<unknown>;
};

export type Running = {
    aborted: boolean;
    attemptId?: string;
    kernel?: RotomRpc;
    snapshot?: () => Promise<{ entries: KernelEntry[]; leafId: string | null }>;
    thinkingChange?: Promise<void>;
    seed?: ReturnType<typeof materializeSeed>;
    closureUnknown?: boolean;
    /** Its prompt was dispatched: messages may join it. */
    prompting?: boolean;
    /** Where a prompt run's time goes; kept only while the performance journal listens (`perf-channels.ts`). */
    timing?: PromptTiming;
};

export type PromptTiming = {
    process?: "started" | "reused";
    dispatchedAt?: number;
    firstOutputAt?: number;
    /** Tools running now, since when, and the time so far with at least one running. */
    toolsRunning: number;
    toolsSince: number;
    toolMs: number;
    tools: number;
    detach?: () => void;
};

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

export type ActiveAttempt = {
    receipt: KernelReceipt;
    operation: "prompt" | "compact" | "discover" | "command";
    running: Running;
    inferenceAdmitted: boolean;
    usageWrites: Promise<void>;
};

/** What a native launch made so far, for its caller to close should the launch fail. */
export type Owned = {
    gate?: ReturnType<typeof createServer>;
    gateFile?: string;
    contextFile?: string;
    kernel?: RotomRpc;
};

export type PersistentKernel = {
    rebind: (binding: Readonly<KernelBinding>, prepared: KernelLaunchContext | undefined) => void;
    modelApi: string | undefined;
    needsReload: boolean;
    revision: string;
    kernel: RotomRpc;
    gate: ReturnType<typeof createServer>;
    gateFile: string;
    contextFile?: string;
    gateState: { active?: ActiveAttempt };
    state: { sessionFile: string; sessionId: string; sessionName?: string; thinkingLevel: string };
};

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

/** Public-history JSON UTF-8 bytes. Avoid worker startup for small seeds; 10 MiB already causes long parent stalls. */
export const SEED_WORKER_MIN_BYTES = 8 * 1024 * 1024;
