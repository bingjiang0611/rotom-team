/** Refuse optional native prompt injections without source evidence; never inspect prompt text for authority. */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";
import { nativeConfigurationApi } from "./rotom-kernel.ts";
import { TeamResourcePolicyError } from "./rotom-resource-policy.ts";

/** Pinned native metadata readers, with no dependency/cache writes and no agent startup. */
async function nativeReaders() {
    const { bundledResourceRoot } = await nativeConfigurationApi();
    const root = join(bundledResourceRoot, "extensions/third-party/node_modules/pi-subagents/src");
    const jiti = createJiti(import.meta.url, { fsCache: false });
    const store = await jiti.import<Record<string, any>>(join(root, "shared/types.ts"));
    const refinements = await jiti.import<Record<string, any>>(
        join(root, "agents/agent-refinements.ts"),
    );

    return { store, refinements };
}

/** Owned asynchronous children persist this descriptor before spawning their CLI. Missing evidence is not empty evidence. */
export async function assertTeamSubagentInjections(args: string[]): Promise<void> {
    const id = process.env.PI_SUBAGENT_RUN_ID;
    const agent = process.env.PI_SUBAGENT_CHILD_AGENT;

    if (!id || !agent || !/^[A-Za-z0-9_-]+$/.test(id)) {
        throw new TeamResourcePolicyError("Native child launch lacks an owned resource descriptor");
    }

    const readers = await nativeReaders();
    const { store, refinements } = readers;
    const rootId = process.env.PI_SUBAGENT_PARENT_ROOT_RUN_ID;
    const paths = [join(store.DIRS.async, id, "recovery-descriptor.json")];

    if (rootId && /^[A-Za-z0-9_-]+$/.test(rootId)) {
        paths.push(
            join(
                store.TEMP_ROOT_DIR,
                "nested-subagent-runs",
                rootId,
                id,
                "recovery-descriptor.json",
            ),
        );
    }

    const path = paths.find((file) => existsSync(file));

    if (!path) {
        throw new TeamResourcePolicyError(
            "Native child has no attested injection descriptor; foreground workflow launches are unsupported",
        );
    }

    const descriptor = JSON.parse(readFileSync(path, "utf8"));
    const parsed = (await nativeConfigurationApi()).parseArgs(args);

    if (
        descriptor.version !== 1 ||
        descriptor.sourceRunId !== id ||
        descriptor.agent !== agent ||
        typeof descriptor.cwd !== "string" ||
        !descriptor.sessionFile ||
        !parsed.session ||
        resolve(descriptor.sessionFile) !== resolve(parsed.session)
    ) {
        throw new TeamResourcePolicyError(
            "Native child resource descriptor does not match this launch",
        );
    }

    // Native v1 writes skills only when resolveSkillsWithFallback produced locations. Names are not source attestations.
    if (
        descriptor.skills !== undefined &&
        (!Array.isArray(descriptor.skills) || descriptor.skills.length)
    ) {
        throw new TeamResourcePolicyError(
            "Optional subagent named-skill injection is unsupported without attested source paths; normal shared/project skill discovery remains available",
        );
    }

    if (descriptor.memory !== undefined) {
        throw new TeamResourcePolicyError(
            "Optional subagent memory injection is unsupported; private memory is preserved, not imported",
        );
    }

    // The native injector reads a selected role's refinement in runner cwd. Worktree execution can use another cwd.
    // Invalid refinement names are ignored by native itself; use that exact name constraint before its path reader.
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(agent) && !agent.includes("..")) {
        for (const cwd of new Set([realpathSync(descriptor.cwd), process.cwd()])) {
            if (existsSync(refinements.getAgentRefinementPath(cwd, agent))) {
                throw new TeamResourcePolicyError(
                    "Project subagent refinement injection is unsupported; move agent configuration to the shared profile",
                );
            }
        }
    }
}
