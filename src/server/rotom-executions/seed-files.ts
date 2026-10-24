/** Public-history seed files; the execution owner remains responsible for attach, authorization and finish. */
import {
    constants,
    mkdirSync,
    realpathSync,
    lstatSync,
    chmodSync,
    openSync,
    fsyncSync,
    closeSync,
} from "node:fs";
import { join } from "node:path";
import type { KernelBinding } from "../rotom-journal.ts";
import type { nativeSessionManager } from "../rotom-kernel.ts";
import type { publicNativeHistory } from "../rotom-history.ts";
import { seedPhases } from "../perf-channels.ts";
import { readNativeEntries } from "./native-tail.ts";

type SessionManager = Awaited<ReturnType<typeof nativeSessionManager>>["SessionManager"];

export function prepareSeed(
    binding: Pick<KernelBinding, "home" | "workspace">,
    SessionManager: SessionManager,
) {
    const mark = seedPhases();
    // Native Pi may create its sessions container as 0755 inside the private HOME.
    // Own a private seed subdirectory rather than changing or trusting that container's mode.
    const folder = join(binding.home, ".pi/agent/sessions/team-seeds");

    mkdirSync(folder, { recursive: true, mode: 0o700 });

    if (realpathSync(folder) !== folder || lstatSync(folder).mode & 0o077) {
        throw new Error("Native seed directory must be canonical and private");
    }

    const session = SessionManager.create(binding.workspace, folder);

    mark("prepare");

    return { session, folder };
}

export function persistSeed(
    session: ReturnType<SessionManager["create"]>,
    folder: string,
    workspace: string,
    messages: ReturnType<typeof publicNativeHistory>,
) {
    const mark = seedPhases();

    for (const message of messages) {
        session.appendMessage(message);
    }

    mark("append");
    const path = session.getSessionFile();

    chmodSync(path, 0o600);

    for (const pathToSync of [path, folder]) {
        const fd = openSync(pathToSync, constants.O_RDONLY | constants.O_NOFOLLOW);

        try {
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
    }

    mark("persist");
    const entries = readNativeEntries(path, session.getSessionId(), workspace);

    mark("readback");
    const persisted = entries
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.message);

    if (JSON.stringify(persisted) !== JSON.stringify(messages)) {
        throw new Error("Native seed readback mismatch");
    }

    mark("compare");

    return entries;
}
