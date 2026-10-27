/** Shared native execution data. Mutable run/gate latches are passed by reference. */
import type { createServer } from "node:http";
import type { KernelBinding, KernelEntry, KernelReceipt } from "../rotom-journal.ts";
import type { RotomRpc, RpcRecord } from "../rotom-rpc.ts";
import type { materializeSeed } from "./seed.ts";

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
    revision: string;
    kernel: RotomRpc;
    gate: ReturnType<typeof createServer>;
    gateFile: string;
    contextFile?: string;
    gateState: { active?: ActiveAttempt };
    state: { sessionFile: string; sessionId: string; sessionName?: string; thinkingLevel: string };
};

export type Authorize = (
    binding: Readonly<KernelBinding>,
    operation: "admission" | "inference" | "refresh" | "fork",
    sessionId: string,
) => Promise<KernelRequestAuth | void>;
export type Prepare = (binding: Readonly<KernelBinding>, sessionId: string) => KernelLaunchContext;
