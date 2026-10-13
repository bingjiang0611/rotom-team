/** Load only project skills after --no-skills disables automatic personal and project discovery. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/config.js";
import { DefaultPackageManager } from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/core/package-manager.js";
import { SettingsManager } from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js";

export default function (pi) {
    pi.on("resources_discover", async ({ cwd }) => {
        if (process.env.PI_SUBAGENT_INHERIT_SKILLS === "0") {
            return {};
        }

        const file = join(cwd, ".pi/settings.json");
        const settingsManager = SettingsManager.fromStorage({
            // Read-only project settings. Personal resource settings never participate in discovery.
            withLock: (scope, read) =>
                read(scope === "project" && existsSync(file) ? readFileSync(file, "utf8") : "{}"),
        });
        const resources = await new DefaultPackageManager({
            cwd,
            agentDir: getAgentDir(),
            settingsManager,
        }).resolve();

        return {
            skillPaths: resources.skills
                .filter((resource) => resource.enabled && resource.metadata.scope === "project")
                .map((resource) => resource.path),
        };
    });
}
