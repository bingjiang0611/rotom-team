/** Compare all 45 attested terminal name/source pairs against actual isolated Team native discovery.
 * Pass the parent-produced inventory JSON explicitly. This never imports a personal settings file or executes skills. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { supportedTeamCommand, teamCommandCatalog } from "../src/server/team-command-policy.ts";
import {
    nativeBuiltinCommands,
    startRotomKernel,
    verifyRotomKernel,
} from "../src/server/rotom-kernel.ts";

const expectedNames = {
    builtin:
        "settings model tree thinking scoped-models export import share bug copy name session changelog hotkeys fork clone trust login logout new compact resume reload quit".split(
            " ",
        ),
    extension:
        "trace browser computer-use subagent-cost subagents-doctor subagents-guide subagents-detach subagents-stop subagents-models goal qoder-models qoder-credits context llama mcp".split(
            " ",
        ),
    skill: "skill:pi-subagents skill:design-loop skill:dws skill:mobile-use skill:ponytail-audit skill:yao-meta-skill".split(
        " ",
    ),
};
const source = process.argv[2];

assert.ok(
    source,
    "Pass the attested isolated terminal inventory JSON; never use personal settings as input",
);
const terminal = JSON.parse(readFileSync(source, "utf8")) as {
    version: string;
    commands: { name: string; source: string; sourceInfo?: { path?: string } }[];
};

assert.ok(
    terminal.version === "0.1.22" || terminal.version === verifyRotomKernel().version,
    "Only the original attestation or the current pinned inventory is supported",
);
const pairs = (commands: { name: string; source: string }[]) =>
    commands.map((command) => `${command.source}:${command.name}`).sort();

assert.deepEqual(
    pairs(terminal.commands),
    Object.entries(expectedNames)
        .flatMap(([source, names]) => names.map((name) => `${source}:${name}`))
        .sort(),
);
assert.equal(terminal.commands.length, 45);
process.umask(0o077);
const root = realpathSync(mkdtempSync(join(tmpdir(), "team-command-inventory-")));
const home = join(root, "home"),
    workspace = join(root, "workspace"),
    teamAgentDir = join(root, "team-agent");

for (const path of [home, workspace, teamAgentDir]) {
    mkdirSync(path, { mode: 0o700 });
}

const kernel = await startRotomKernel({
    home,
    workspace,
    teamAgentDir,
    provider: "openai",
    model: "gpt-4o",
});

try {
    const dynamic = (await kernel.request({ type: "get_commands" })) as {
        commands: { name: string; source: string; sourceInfo?: { path?: string } }[];
    };
    const actual = [
        ...(await nativeBuiltinCommands()).map((command) => ({
            ...command,
            source: "builtin",
            sourceInfo: { path: "core/slash-commands.js" },
        })),
        ...dynamic.commands,
    ];
    const missing = terminal.commands.filter(
        (command) =>
            !actual.some((item) => item.name === command.name && item.source === command.source),
    );

    assert.deepEqual(
        missing.map((command) => command.name).sort(),
        expectedNames.skill.filter((name) => name !== "skill:pi-subagents").sort(),
    );
    assert.equal(actual.length, 40);
    const allowed = teamCommandCatalog(actual);

    assert.equal(allowed.length, 27, "native catalog minus thirteen protected terminal builtins");
    const rows = terminal.commands.map((command) => {
        const observed = actual.find(
            (item) => item.name === command.name && item.source === command.source,
        );
        const excluded = !supportedTeamCommand(command);
        const pendingSkill = command.source === "skill" && command.name !== "skill:pi-subagents";

        return {
            name: command.name,
            source: command.source,
            terminalSourceFile: command.sourceInfo?.path ?? "core/slash-commands.js",
            teamSourceFile: observed?.sourceInfo?.path ?? null,
            presence: excluded ? "explicitly-excluded" : observed ? "registered" : "not-installed",
            supportedInteraction: excluded
                ? "rejected before native effects"
                : pendingSkill
                  ? "awaiting owner-curated portable shared source"
                  : command.source === "builtin"
                    ? "Team security/session adapter; see per-command compatibility table"
                    : command.source === "skill"
                      ? "native expansion on explicit submit, not suggestion click"
                      : "native RPC handler; command-specific effects require separate proof",
            parity: excluded
                ? "excluded"
                : pendingSkill
                  ? "pending-resource-provenance"
                  : "inventory-match-not-a-behavior-verdict",
        };
    });
    const state = (await kernel.request({ type: "get_state" })) as { messageCount: number };

    assert.equal(state.messageCount, 0);
    writeFileSync(
        join(root, "report.json"),
        JSON.stringify(
            {
                root,
                terminalInventory: source,
                version: verifyRotomKernel().version,
                terminalVersion: terminal.version,
                realAccounts: false,
                terminalRows: 45,
                registeredNativeRows: 40,
                allowedTeamCatalogEntries: allowed.length,
                explicitExclusions: terminal.commands
                    .filter((command) => !supportedTeamCommand(command))
                    .map((command) => command.name),
                messageCount: state.messageCount,
                all45Parity: false,
                rows,
            },
            null,
            2,
        ),
    );
    console.log(`All 45 name/source rows compared, not all behavior accepted: ${root}/report.json`);
} finally {
    await kernel.close();
}
