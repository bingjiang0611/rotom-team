// Only SessionManager and a read-only RPC fixture: never starts an agent or a provider.
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import { nativeSessionManager } from "../../src/server/rotom-kernel.ts";

const [file, mode] = process.argv.slice(2);
const { SessionManager } = await nativeSessionManager();
const entries = existsSync(file)
    ? readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
    : [
          {
              type: "session",
              version: 3,
              id: "snapshot-session",
              cwd: dirname(file),
              timestamp: new Date().toISOString(),
          },
      ];
const manager = SessionManager.inMemory(dirname(file), undefined, entries);

if (mode === "branch") {
    manager.branch("root-goal");
}

if (mode === "memory") {
    manager.appendCustomEntry("goal-state", { goal: { status: "active", objective: "unflushed" } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
    const command = JSON.parse(line);

    if (command.type !== "get_entries") {
        throw new Error("Fixture accepts only read-only get_entries");
    }

    let selected = manager.getEntries();

    if (command.since !== undefined) {
        const index = selected.findIndex((entry) => entry.id === command.since);

        if (index === -1) {
            throw new Error("Unknown snapshot anchor");
        }

        selected = selected.slice(index + 1);
    }

    process.stdout.write(
        JSON.stringify({
            type: "response",
            id: command.id,
            command: "get_entries",
            success: true,
            data: { entries: selected, leafId: manager.getLeafId() },
        }) + "\n",
    );
});
