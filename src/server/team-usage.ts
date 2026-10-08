import { defineDoc } from "@earendil-works/pi-durable";
export type RecordedUsage = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};
export type TeamUsage = {
    people: Record<
        string,
        { models: Record<string, RecordedUsage>; tools: Record<string, RecordedUsage> }
    >;
};
/** Same document contract as the hash-bound pi-durable recordUsage patch. */
export const TeamUsageDoc = defineDoc<TeamUsage>({
    kind: "rotom-team.usage-ledger",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ people: {} }),
    checkpointWhen: () => true,
});
export const TeamCountedDoc = defineDoc<{ people: Record<string, number> }>({
    kind: "rotom-team.usage-counted",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ people: {} }),
});
