import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import type { PocketApp } from "./app.ts";
import type { RotomExecutions } from "./rotom-executions.ts";
import { NativeMirrorDoc, type NativeLive } from "./team-kernel-docs.ts";
import type { SubmissionOwner } from "./team-kernel-submission.ts";
import { AuthorsDoc, SessionsDoc } from "./docs.ts";
import { NATIVE_ENTRY } from "./entry-format.ts";
import { publicEntry } from "./team-kernel/projection.ts";
import { sendPhase, sendPhaseChannel } from "./send-trace.ts";
export type MirrorOwner = SubmissionOwner & {
    app: PocketApp;
    executions: RotomExecutions;
    live: Map<ConversationId, NativeLive>;
    mirrorHistoryLoaded: Set<ConversationId>;
    mirrorCursors: Map<ConversationId, { count: number; rowid: number }>;
    branchedHistory: Set<ConversationId>;
    mirrors: Map<ConversationId, Promise<void>>;
};

export function createMirrorDomain(owner: MirrorOwner) {
    return {
        mirror(id: ConversationId): Promise<void> {
            const next = (owner.mirrors.get(id) ?? Promise.resolve()).then(() =>
                this.mirrorNow(id),
            );

            owner.mirrors.set(
                id,
                next.catch((error: unknown) =>
                    owner.app.notice("warning", `Native transcript mirror failed: ${error}`),
                ),
            );

            return next;
        },

        async mirrorNow(id: ConversationId): Promise<void> {
            const app = owner.app;
            const mirrored =
                (await app.harness.snapshot(NativeMirrorDoc, id, BACKGROUND_CONTEXT))?.count ?? 0;
            const journal = owner.executions.journal;
            const cached = owner.mirrorCursors.get(id);
            const cursor =
                cached?.count === mirrored
                    ? cached.rowid
                    : await journal.entryCursor(String(id), mirrored);
            const skip = mirrored;
            const rows = await journal.entriesAfter(String(id), cursor);
            const count = skip + rows.length;

            if (
                (mirrored > 0 &&
                    !owner.mirrorHistoryLoaded.has(id) &&
                    (await journal.hasBranchedHistory(String(id)))) ||
                rows.some((row) => row.entry.customType === "team-kernel-branch")
            ) {
                owner.branchedHistory.add(id);
            }

            owner.mirrorHistoryLoaded.add(id);

            if (count > mirrored) {
                const prompts: string[] = [];

                await app.harness.commit(async (tx) => {
                    const doc = await tx.doc(NativeMirrorDoc, id);
                    const authors = await tx.doc(AuthorsDoc, id);

                    if (doc.count < skip) {
                        throw new Error("Native mirror prefix moved backwards");
                    }

                    for (const row of rows.slice(doc.count - skip)) {
                        // Imported history describes the source, not the newly named copy/fork. Only live
                        // prompt/command metadata may rename the destination; keep the audit entries intact.
                        if (
                            ["prompt", "command"].includes(row.operation) &&
                            row.entry.type === "session_info" &&
                            typeof row.entry.name === "string"
                        ) {
                            const meta = (await tx.doc(SessionsDoc)).items[String(id)];

                            if (meta) {
                                meta.title = row.entry.name;
                                meta.updatedAt = Date.now();
                            }
                        }

                        const message = row.entry.message as { role?: unknown } | undefined;
                        // A person's own prompt; inherited fork history and automatic continuations have no author. The
                        // supplied request id lets only the sending tab replace the optimistic row with this entry.
                        const ownPrompt =
                            ["prompt", "command"].includes(row.operation) &&
                            !row.requestId.includes("#resume") &&
                            row.entry.type === "message" &&
                            message?.role === "user";
                        const prefix = `${row.memberId}:`;
                        const requestId =
                            ownPrompt && row.requestId.startsWith(prefix)
                                ? row.requestId.slice(prefix.length)
                                : undefined;
                        const record = await tx.appendEntry(id, {
                            kind: NATIVE_ENTRY,
                            data: {
                                entry: publicEntry(row.entry),
                                ...(requestId === undefined ? {} : { requestId }),
                            } as unknown as JsonValue,
                        });

                        if (ownPrompt) {
                            authors.entries[String(record.id)] = row.memberId;

                            if (sendPhaseChannel.hasSubscribers) {
                                prompts.push(row.requestId);
                            }
                        }
                    }

                    doc.count = count;
                }, BACKGROUND_CONTEXT);

                // Publish only after the actual suffix committed, not after merely reading the native journal.
                for (const key of prompts) {
                    sendPhase(String(id), key, "mirrored");
                }
            }

            // Only a successful Durable commit consumes rows. A failed mirror must retry the same suffix.
            owner.mirrorCursors.set(id, { count, rowid: rows.at(-1)?.rowid ?? cursor });
            const live = owner.live.get(id);

            if (live?.generation?.ended) {
                delete live.generation;
                app.roomChanged(id);
            }
        },
    };
}

export type MirrorDomain = ReturnType<typeof createMirrorDomain>;
