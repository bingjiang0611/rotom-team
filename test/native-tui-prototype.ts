/** Bounded feasibility experiment: actual pinned product TUI on an OS PTY, NOT a production execution backend. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeSessionManager, verifyRotomKernel } from "../src/server/rotom-kernel.ts";
import { prepareTeamResources } from "../src/server/rotom-resources.ts";
import { RotomJournal } from "../src/server/rotom-journal.ts";

process.umask(0o077);
const root = realpathSync(mkdtempSync(join(tmpdir(), "native-tui-prototype-")));
const home = join(root, "kernel-homes/synthetic-member"),
    workspace = join(root, "workspace"),
    shared = join(root, "team-agent");

for (const directory of [home, workspace, join(shared, "extensions")]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
}

const { executable, version } = verifyRotomKernel();
const journal = new RotomJournal(root);
const binding = {
    memberId: "synthetic-member",
    kernelVersion: version,
    accountGeneration: "no-real-account",
    provider: "openai",
    model: "gpt-4o",
    configurationDigest: "tui-prototype",
    home,
    workspace,
};

journal.bind("prototype", binding);
const receipt = journal.reserve("prototype", "tui-research", "/future-tui", "command");
const { SessionManager } = await nativeSessionManager();
const seed = SessionManager.create(workspace, join(home, ".pi/agent/sessions"));

seed.appendMessage({ role: "user", content: "Synthetic seed", timestamp: Date.now() });
seed.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Synthetic seed, not model inference" }],
    api: "openai-completions",
    provider: "openai",
    model: "gpt-4o",
    stopReason: "stop",
    usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
});
let gateAttempts = 0;
const gate = createServer((_request, response) => {
    gateAttempts++;
    response.writeHead(403, { "Content-Type": "application/json" });
    response.end(
        JSON.stringify({ error: "Prototype authorizes no inference or credential refresh" }),
    );
});

gate.listen(0, "127.0.0.1");
await once(gate, "listening");
const gateFile = join(root, "gate.json");

writeFileSync(
    gateFile,
    JSON.stringify({
        provider: binding.provider,
        model: binding.model,
        token: "synthetic-deny-only",
        url: `http://127.0.0.1:${(gate.address() as { port: number }).port}/authorize`,
    }),
);
writeFileSync(
    join(shared, "extensions/probe.ts"),
    `import { writeFileSync } from 'node:fs';
const save=(name,data)=>writeFileSync(${JSON.stringify(root)}+'/'+name,JSON.stringify(data));
export default function(pi) {
 pi.on('session_start', (_event,ctx)=>save('ready.json',{mode:ctx.mode, sessionId:ctx.sessionManager.getSessionId(), sessionFile:ctx.sessionManager.getSessionFile(),pid:process.pid}));
 pi.registerCommand('future-tui',{handler:async(args,ctx)=>{
  const result=await ctx.ui.custom((_tui,_theme,_keys,done)=>{
   save('custom-entered.json',{mode:ctx.mode,args});
   return {render:()=>['REAL NATIVE CUSTOM COMPONENT — press x'],invalidate(){},handleInput(data){if(data==='x'){done('ACTUAL_KEY_X')}}};
  });
  pi.appendEntry('tui-native-effect',{args,result}); save('custom-completed.json',{args,result,mode:ctx.mode});
 }});
 pi.registerCommand('future-tui-error',{handler:async(args)=>{pi.appendEntry('tui-native-error-effect',{args});save('error-effect.json',{args});throw new Error('ACTUAL_POST_EFFECT_ERROR');}});
}`,
);
await prepareTeamResources(home, shared, workspace);
const config = {
    root,
    workspace,
    argv: [
        executable,
        "--no-approve",
        "--no-skills",
        "--provider",
        binding.provider,
        "--model",
        binding.model,
        "--session",
        seed.getSessionFile(),
        "--session-dir",
        join(home, ".pi/agent/sessions"),
        "--extension",
        fileURLToPath(new URL("../src/server/rotom-policy.mjs", import.meta.url)),
    ],
    environment: {
        HOME: home,
        PI_CODING_AGENT_DIR: join(home, ".pi/agent"),
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        TERM: "xterm-256color",
        LANG: "en_US.UTF-8",
        ROTOM_OBSERVABILITY: "0",
        ROTOM_NODE: process.execPath,
        ROTOM_TEAM_KERNEL_GATE: gateFile,
        ROTOM_TEAM_AGENT_DIR: shared,
        PI_CU_SOCKET_PATH: join(root, "unused-helper.sock"),
    },
};

journal.attach(receipt.id, seed.getSessionFile(), seed.getSessionId());
const input = join(root, "prototype.json");

writeFileSync(input, JSON.stringify(config));

try {
    const process = spawn(
        "/usr/bin/python3",
        [fileURLToPath(new URL("./native-tui-prototype.py", import.meta.url)), input],
        { stdio: "inherit" },
    );
    const [code] = await once(process, "close");

    assert.equal(code, 0);
    const ready = JSON.parse(readFileSync(join(root, "ready.json"), "utf8"));

    assert.equal(ready.mode, "tui");
    assert.equal(ready.sessionFile, seed.getSessionFile());
    journal.attach(receipt.id, ready.sessionFile, ready.sessionId);
    const completed = JSON.parse(readFileSync(join(root, "custom-completed.json"), "utf8"));

    assert.deepEqual(completed, { args: "exact native args", result: "ACTUAL_KEY_X", mode: "tui" });
    const bytes = readFileSync(ready.sessionFile, "utf8");

    assert.ok(bytes.includes("tui-native-effect"));
    assert.ok(bytes.includes("tui-native-error-effect"));
    assert.equal(gateAttempts, 0);
    // Fixture markers can attest its own handler, but arbitrary commands expose no such completion marker.
    // Do not promote this research receipt to handled just because the TUI exited.
    const terminal = journal.fail(receipt.id, "unknown");

    assert.equal(terminal.status, "unknown");
    writeFileSync(
        join(root, "report.json"),
        JSON.stringify(
            {
                root,
                realAccounts: false,
                version,
                completed,
                sessionIdentityPreserved: true,
                nativeEffectAndErrorPersisted: true,
                gateAttempts,
                receipt: terminal,
                productionReady: false,
                blockers: [
                    "Public extension APIs expose no generic command-completion/error observation to a separate TUI transport",
                    "TUI exit or rendered notification is not authoritative command success",
                    "No browser terminal renderer/transport or automatic admission integration has been implemented",
                ],
            },
            null,
            2,
        ),
    );
    console.log(
        `Actual native PTY experiment passed (production transport remains blocked): ${root}`,
    );
} finally {
    gate.closeAllConnections();
    await new Promise<void>((resolve) => gate.close(() => resolve()));
    journal.close();
}
