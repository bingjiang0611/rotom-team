/** The fixed benchmark inputs and synthetic transport profile. */
export const WORKLOAD = {
    seededTurns: 12,
    answerChars: 6000,
    streamChunks: 30,
    extraSessions: 12,
    changedFiles: 20,
    projectionTurns: 64,
    projectionTabs: 4,
    projectionAnswerChars: 120,
    imageEntries: 24,
    imageWidth: 1024,
    imageHeight: 640,
    imageParallel: 4,
    /** The pause between chunks of a paced answer, as a real model streams. */
    pacedChunkMs: 25,
    /** A long native history (seeded directly, no model), for opening it and reading all of it. */
    longTurns: 300,
    longAnswerChars: 1200,
    /** A native journal history for repeated roomInfo projections, seeded directly with no model. */
    nativeLongEntries: 600,
    nativeLongEntryChars: 1200,
    /** A separate synthetic RotomJournal fixture for the A1 query measurement. */
    journalConversations: 60,
    journalAttempts: 50,
    journalEntriesPerAttempt: 12,
    journalEntryChars: 2000,
    /** The newest entries a tab asks for first, as the web app does (`TRANSCRIPT_TAIL` in web/store.js). */
    longTail: 240,
    /** The explicit static bundle is a transport workload, not a full browser navigation. */
    staticAssetBundle:
        "root web/*.js and *.css, known VENDOR modules, and all synthetic public assets",
} as const;

/**
 * The model's pause before the first chunk of a send timed in phases (`web.send.*`), so the sender's own message is
 * pushed before the reply. Outside `WORKLOAD`, whose equality `perf:compare` checks: older reports stay comparable.
 */
export const SPLIT_FIRST_OUTPUT_MS = 1000;

/** Chromium response latency and per-direction throughput for new send-network scenarios, not a physical RTT. */
export const SEND_NETWORK = { latencyMs: 150, bytesPerSecond: 500_000 } as const;
