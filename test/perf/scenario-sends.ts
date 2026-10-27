import { join } from "node:path";
import { measureSend } from "./send-phases.ts";
import { WORKLOAD } from "./workload.ts";
import type { ScenarioContext } from "./scenario-context.ts";

/** Run the established loopback phased sends in their original order. */
export async function runEstablishedSends(context: ScenarioContext): Promise<void> {
    const { history, ownerToken, quiet, root, token } = context;

    // Last, so nothing above changes: a send from the composer to the History session, timed in phases, over long polling
    // and then over the event stream. Each answer is the next turn of that history.
    for (const [index, transport] of (["poll", "stream"] as const).entries()) {
        const turn = WORKLOAD.seededTurns + 2 + index;
        const sent = await measureSend({
            base: context.base,
            ownerToken,
            token,
            sessionId: history,
            transport,
            ready: `END-OF-ANSWER-${turn - 1}`,
            done: `END-OF-ANSWER-${turn}`,
            quiet,
            profile: join(root, `perf-browser-send-${transport}`),
        });

        context.results.push(
            "unavailable" in sent
                ? { scenario: `web.send.${transport}`, unavailable: sent.unavailable }
                : { scenario: `web.send.${transport}`, ...sent },
        );
    }
}

/** Run the synthetic network-profile phased sends after every other workload. */
export async function runNetworkSends(context: ScenarioContext): Promise<void> {
    const { history, ownerToken, quiet, root, token } = context;

    // New network profiles come last so they cannot alter any established scenario's history or counters.
    for (const [index, transport] of (["poll", "stream"] as const).entries()) {
        const turn = WORKLOAD.seededTurns + 4 + index;
        const sent = await measureSend({
            base: context.base,
            ownerToken,
            token,
            sessionId: history,
            transport,
            network: true,
            ready: `END-OF-ANSWER-${turn - 1}`,
            done: `END-OF-ANSWER-${turn}`,
            quiet,
            profile: join(root, `perf-browser-send-${transport}-network`),
        });

        context.results.push(
            "unavailable" in sent
                ? { scenario: `web.send.${transport}.network`, unavailable: sent.unavailable }
                : { scenario: `web.send.${transport}.network`, ...sent },
        );
    }
}
