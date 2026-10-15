/** Load native global and project MCP configuration without opening other project agent resources. */
import { getAgentDir } from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/config.js";
import { loadMcpConfig } from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/config.js";
import { createMcpExtension } from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/index.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const nativeMcp = createMcpExtension({
    loadConfig: (ctx) =>
        loadMcpConfig({ agentDir: getAgentDir(), cwd: ctx.cwd, projectTrusted: true }),
});

export default function (pi) {
    const settings = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8"));

    if (settings.extensions?.includes("-builtin:mcp")) {
        return;
    }

    return nativeMcp(pi);
}
