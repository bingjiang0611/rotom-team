import { PocketApp } from "../../src/server/app.ts";
import { AuthorsDoc } from "../../src/server/docs.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NativeMirrorDoc } from "../../src/server/team-kernel.ts";
import { NATIVE_ENTRY } from "../../src/server/entry-format.ts";
import { RotomJournal } from "../../src/server/rotom-journal.ts";

const { dataDir, cwd, id } = JSON.parse(process.argv[2]!) as {
    dataDir: string;
    cwd: string;
    id: number;
};

const originalEntries = RotomJournal.prototype.entries;

RotomJournal.prototype.entries = () => {
    throw new Error("Startup mirror must not parse the historical prefix");
};

try {
    const app = await PocketApp.open({
        dataDir,
        defaultCwd: cwd,
        supervised: false,
        kernel: true,
        browser: null,
        log: () => {},
    });

    try {
        await app.kernel!.mirror(id as never);
        RotomJournal.prototype.entries = originalEntries;
        const room = await app.room(id as never);
        const native = room
            .value!.entries.filter((entry) => entry.kind === NATIVE_ENTRY)
            .map((entry) => ({ id: entry.id, data: entry.data }));
        const mirror = await app.harness.snapshot(NativeMirrorDoc, id as never, BACKGROUND_CONTEXT);
        const authors = await app.harness.snapshot(AuthorsDoc, id as never, BACKGROUND_CONTEXT);
        const user = app.config.users.find((each) => each.role === "owner")!;
        const state = await app.kernel!.roomState(id as never, user);

        if (!("hasBranchedHistory" in state)) {
            throw new Error("Native mirror fixture reopened a missing conversation");
        }

        process.send!({
            mirror,
            authors,
            native,
            branch: state.hasBranchedHistory,
        });
    } finally {
        await app.close();
    }
} catch (error) {
    process.send?.({ error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
} finally {
    RotomJournal.prototype.entries = originalEntries;
}
