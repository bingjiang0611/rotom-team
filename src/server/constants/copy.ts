export const SUBSCRIPTION_COPY = {
    invalidRequest: "Invalid session subscription.",
    unavailable: "Event connection is no longer available.",
    invalidAck: "Invalid event acknowledgement.",
};

/** Central copy for the legacy Durable archive boundary. Keep this consistent across HTTP and direct API callers. */
export const ARCHIVE_COPY = {
    executionRetired: "Legacy Durable execution is retired; use the native backend.",
    guardUnavailable:
        "Lancet Guard is unavailable in Team; native Agent Extensions run outside this legacy hook.",
    extensionsUnavailable:
        "Team supports Agent Extensions only. Configure team-agent or the project's .pi directory.",
    sessionMissing: "No such session",
    cliMode:
        "--no-rotom-kernel opens read-only archives; it does not enable legacy execution.\nLegacy service extension modules are not shipped. Data-folder drop-in source and enabled/disabled records are preserved, not loaded. Use native Agent Extensions.",
    kernelUnavailable: (reason: string) =>
        `The pinned rotom runtime is not ready (${reason}). Run \`npm run install:kernel\`, or use --no-rotom-kernel for read-only archive access only.`,
    readOnly:
        "This legacy Durable session is a read-only archive. Open, read, export, and access grants remain available; execution and mutation are disabled.",
    taskAbortReason:
        "Legacy Durable execution was stopped when this session became a read-only archive.",
    archiveNoteName: "Pi",
    stateAborted:
        "This legacy Durable session is now a read-only archive. Pending plans, goals, and scheduled messages were stopped; unfinished work may have unconfirmed external effects.",
    planAborted:
        "Plan mode was stopped because this legacy Durable session is now a read-only archive.",
    goalAborted:
        "This goal was stopped because this legacy Durable session is now a read-only archive.",
    scheduleAborted:
        "This scheduled message was stopped because this legacy Durable session is now a read-only archive.",
    tasksAborted: (count: number) =>
        `This legacy Durable session is now a read-only archive. ${count} unfinished execution record${count === 1 ? " was" : "s were"} stopped; unfinished work may have unconfirmed external effects.`,
};
