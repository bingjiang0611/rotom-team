import { createJournalLargeFixture, measureJournalLarge } from "./journal-large.ts";
import { createStaticAssetsProbe } from "./static-assets.ts";
import type { ScenarioContext } from "./scenario-context.ts";
import { WORKLOAD } from "./workload.ts";

/** Measure the isolated journal fixture before native-long readback, as in the original runner. */
export async function runJournalScenario(context: ScenarioContext): Promise<void> {
    const { root, scenario } = context;
    // The synthetic journal is deliberately isolated from the app journal and seeded before this measured window.
    const journalLarge = createJournalLargeFixture(root, {
        conversations: WORKLOAD.journalConversations,
        attempts: WORKLOAD.journalAttempts,
        entriesPerAttempt: WORKLOAD.journalEntriesPerAttempt,
        entryChars: WORKLOAD.journalEntryChars,
    });
    let journalLargeTimings: ReturnType<typeof measureJournalLarge> | undefined;

    try {
        await scenario(
            "journal.large",
            async () => {
                journalLargeTimings = measureJournalLarge(journalLarge);
            },
            () => journalLargeTimings ?? {},
        );
    } finally {
        journalLarge.close();
    }
}

/** Run the asset probe only after native-long readback, not together with the earlier journal window. */
export async function runAssetScenarios(context: ScenarioContext): Promise<void> {
    const { base, scenario } = context;

    // Append the named static bundle workload after every existing scenario. It is an explicit asset transport probe,
    // not a claim about full browser navigation or browser-side module execution.
    const staticAssets = createStaticAssetsProbe(base);

    await scenario("assets.first", () => staticAssets.first());
    await scenario("assets.validated", () => staticAssets.validated());
}
