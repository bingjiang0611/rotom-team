/** Read-only child validation; the shell retains native ownership descriptors and performs the final exec. */
// Only the light policy module: not `rotom-resources.ts` or `rotom-kernel.ts`, which every subagent start would load.
import { assertTeamResourceSources, sharedContextPaths } from "./rotom-resource-policy.ts";

const home = process.env.HOME!;
const shared = process.env.ROTOM_TEAM_AGENT_DIR!;

await assertTeamResourceSources(home, shared, process.cwd());

if (process.env.ROTOM_TEAM_FROZEN_CONTEXT) {
    // Native global context selection returns at most one file, using its own AGENTS/CLAUDE precedence.
    process.stdout.write((await sharedContextPaths(shared))[0] ?? "");
}
