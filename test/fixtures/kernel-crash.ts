// Controlled fixture only: an actual descendant deliberately outlives its journal-owning parent.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { RotomJournal } from "../../src/server/rotom-journal.ts";

// Fixture-only lifetime bounds prevent a failed test runner from leaking its controlled processes.
setTimeout(() => process.exit(2), 35000).unref();
const { data, binding } = JSON.parse(process.argv[2]!);
const journal = new RotomJournal(data);

journal.bind("crash-conversation", binding);
const receipt = journal.reserve("crash-conversation", "crash-request", "not a real inference");
const tool = spawn(
    process.execPath,
    [
        "-e",
        "process.on('disconnect',()=>{});setInterval(()=>{},1000);setTimeout(()=>process.exit(2),30000);process.send({ready:true});",
    ],
    {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
);

await once(tool, "message");
process.send!({ toolPid: tool.pid, attemptId: receipt.id });
setInterval(() => {}, 1000);
