import { defineDoc, type ConversationId } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import type { ConfigurationSnapshot } from "./team-profiles.ts";
import type { KernelBinding } from "./rotom-journal.ts";
export type NativeCreation = {
    sourceId: ConversationId;
    requestId: string;
    identity: string;
    seed?: boolean;
};
export const NativeCreationsDoc = defineDoc<{
    items: Record<string, { id: ConversationId; identity: string }>;
}>({
    kind: "rotom-team.native-creations",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ items: {} }),
});
export type NativeForkPlan = {
    sourceId: ConversationId;
    requestId: string;
    expectedHead: string;
    entryId?: string;
    clone?: boolean;
};
export const NativeForksDoc = defineDoc<{
    items: Record<
        string,
        { id: ConversationId; expectedHead: string; entryId?: string; clone?: boolean }
    >;
}>({
    kind: "rotom-team.native-forks",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ items: {} }),
});
export const NativeSetupDoc = defineDoc<{
    binding?: KernelBinding;
    bound?: true;
    seed?: NativeForkPlan | { requestId: string };
}>({
    kind: "rotom-team.native-setup",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({}),
});
export const NativeMirrorDoc = defineDoc<{ count: number }>({
    kind: "rotom-team.native-mirror",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ count: 0 }),
});
export type NativeCommandCatalog = {
    memberId: string;
    segmentId: string;
    binding: string;
    capturedAt: number;
    resourceRevision: string;
    invalidated?: boolean;
    commands: Array<{
        name: string;
        description: string;
        argumentHint?: string;
        source?: string;
        sourceInfo?: JsonValue;
    }>;
};

export function commandCatalogRevision(catalog: NativeCommandCatalog | undefined): string | null {
    return catalog ? `${catalog.capturedAt}:${catalog.invalidated ? "stale" : "known"}` : null;
}

export const NativeCommandCatalogDoc = defineDoc<{ catalog?: NativeCommandCatalog }>({
    kind: "rotom-team.native-command-catalog",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({}),
});
export const NativeCommandResultsDoc = defineDoc<{ items: Record<string, JsonValue> }>({
    kind: "rotom-team.native-command-results",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ items: {} }),
});
export type NativeLive = {
    generation?: { message: { content: Record<string, unknown>[] }; ended: boolean };
    retry?: { at: number; error: string };
    tools: { callId: string; name: string; status: "running"; output?: string }[];
    compacting?: string;
    dialogs?: NativeDialog[];
    subagents?: number;
    statuses?: Record<string, string>;
    widgets?: Record<string, { lines: string[]; placement: string }>;
};
export type NativeDialog = {
    id: string;
    method: "select" | "confirm" | "input" | "editor";
    title: string;
    message?: string;
    options?: string[];
    placeholder?: string;
    prefill?: string;
};
export const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
export type NativeConfigurations = {
    snapshots: Record<string, ConfigurationSnapshot>;
    requests: Record<string, { expectedHead: string; binding: KernelBinding }>;
};
export const NativeConfigurationsDoc = defineDoc<NativeConfigurations>({
    kind: "rotom-team.native-configurations",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ snapshots: {}, requests: {} }),
});
export const NATIVE_LAYERS = "native-layers-v1";
