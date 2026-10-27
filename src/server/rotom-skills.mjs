/** Keep automatic skills shared/project-scoped while native trust loads all project resources. */
import { readFileSync } from "node:fs";
import { getAgentDir } from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/config.js";
import { DefaultPackageManager } from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/core/package-manager.js";
import { SettingsManager } from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js";
import { prepareTeamResources } from "./rotom-resources.ts";
import { assertTeamResourceSources } from "./rotom-resource-policy.ts";

export default function (pi) {
    // The native subagent plugin re-reads roles while the parent is alive, including through deferred tools.
    pi.on("tool_call", async (event, ctx) => {
        if (!event.toolName.startsWith("subagent")) {
            return;
        }

        if (typeof event.input?.workflowScript === "string") {
            return {
                block: true,
                reason: "User-provided workflowScript is unsupported: native scoped ownership refuses synchronous controllers and async workflow result delivery is not bridged. Ordinary async structured single-child execution remains supported.",
            };
        }

        try {
            await assertTeamResourceSources(
                process.env.HOME,
                process.env.ROTOM_TEAM_AGENT_DIR,
                ctx.cwd,
            );
        } catch (error) {
            console.error("Team subagent resource policy:", error);

            return {
                block: true,
                reason: "Team resource policy blocked member agent customization. Use the shared profile or trusted project configuration.",
            };
        }
    });
    pi.on("session_shutdown", async ({ reason }, ctx) => {
        if (reason === "reload") {
            const { provider, model } = JSON.parse(
                readFileSync(process.env.ROTOM_TEAM_KERNEL_GATE, "utf8"),
            );

            await prepareTeamResources(
                process.env.HOME,
                process.env.ROTOM_TEAM_AGENT_DIR,
                ctx.cwd,
                { provider, model },
            );
        }
    });
    pi.on("resources_discover", async ({ cwd }) => {
        if (process.env.PI_SUBAGENT_INHERIT_SKILLS === "0") {
            return {};
        }

        const frozenSkills = process.env.ROTOM_TEAM_FROZEN_CONTEXT
            ? JSON.parse(process.env.ROTOM_TEAM_FROZEN_SKILLS)
            : undefined;
        const settingsManager = SettingsManager.create(cwd, getAgentDir(), {
            projectTrusted: !frozenSkills,
        });
        const sharedSkills = settingsManager.getGlobalSettings().skills ?? [];
        const resources = await new DefaultPackageManager({
            cwd,
            agentDir: getAgentDir(),
            settingsManager,
        }).resolve(async () => "error");

        return {
            skillPaths: [
                ...(frozenSkills ?? []),
                ...resources.skills
                    .filter(
                        (resource) =>
                            resource.enabled &&
                            ((resource.metadata.scope === "project" && !frozenSkills) ||
                                sharedSkills.includes(resource.path)),
                    )
                    .map((resource) => resource.path),
            ],
        };
    });
}
