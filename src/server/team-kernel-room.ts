import type { ConversationId } from "@earendil-works/pi-durable";
import type { User } from "./config.ts";
import type { KernelBinding, KernelEntry, KernelReceipt } from "./rotom-journal.ts";
import type { PocketApp } from "./app.ts";
import type { RotomExecutions } from "./rotom-executions.ts";
import {
    commandCatalogRevision,
    type NativeLive,
    type NativeCommandCatalog,
} from "./team-kernel-docs.ts";
import { projectLive, type ClientLive } from "./projection.ts";
import type { LiveState } from "@earendil-works/pi-durable";
import type { SubmissionOwner } from "./team-kernel-submission.ts";
import type { AdapterDomain } from "./team-kernel-adapters.ts";
export type RoomOwner = SubmissionOwner & {
    app: PocketApp;
    executions: RotomExecutions;
    live: Map<ConversationId, NativeLive>;
    commands: Map<ConversationId, NativeCommandCatalog>;
    ready: Set<ConversationId>;
    branchedHistory: Set<ConversationId>;
    mirrorHistoryLoaded: Set<ConversationId>;
    mirrorCursors: Map<ConversationId, { count: number; rowid: number }>;
    agentInfo: AdapterDomain["agentInfo"];
    commandSnapshot: (
        id: ConversationId,
        memberId: string,
        knownSession?: { segmentId: string; binding: KernelBinding },
    ) => NativeCommandCatalog | undefined | Promise<NativeCommandCatalog | undefined>;
    cutOff: (id: ConversationId, latest: KernelReceipt | undefined) => Promise<boolean>;
};

export function createRoomDomain(owner: RoomOwner) {
    return {
        async roomInfo(id: ConversationId) {
            const bySegment = new Map<string, Promise<KernelEntry[]>>();

            const readEntries = (segmentId: string) => {
                let entries = bySegment.get(segmentId);

                if (entries === undefined) {
                    entries = owner.executions.journal.segmentEntries(segmentId);
                    bySegment.set(segmentId, entries);
                }

                return entries;
            };

            // Goal used to be read before agentInfo; keep that error/live-state ordering.
            const goal = await owner.nativeGoal(id, readEntries);
            const agent = await owner.agentInfo(id, readEntries);

            return { goal, agent };
        },

        /** What the web app needs to drive a native conversation: the head it acts on, and who pays for it. */
        async roomState(id: ConversationId, viewer: User) {
            const journal = owner.executions.journal;

            const snapshot = await journal.roomSnapshot(String(id));

            if (!snapshot) {
                return { initializing: true };
            }

            const { binding, segmentId, pending, latest } = snapshot;

            return {
                initializing: !owner.ready.has(id),
                segmentId,
                memberId: binding.memberId,
                memberName: owner.app.config.userById(binding.memberId)?.name ?? "A former member",
                provider: binding.provider,
                model: binding.model,
                thinkingLevel: binding.thinkingLevel ?? "off",
                kernelVersion: binding.kernelVersion,
                yours: binding.memberId === viewer.id,
                commandsRevision: commandCatalogRevision(
                    await owner.commandSnapshot(id, viewer.id, { binding, segmentId }),
                ),
                hasBranchedHistory: owner.branchedHistory.has(id),
                dialogs: owner.live.get(id)?.dialogs ?? [],
                statuses: owner.live.get(id)?.statuses ?? {},
                widgets: owner.live.get(id)?.widgets ?? {},
                subagents: owner.live.get(id)?.subagents ?? 0,
                ...((await owner.cutOff(id, latest)) ? { cutOff: true } : {}),
                ...(pending
                    ? {
                          pending: {
                              id: pending.id,
                              status: pending.status,
                              operation: pending.operation,
                              memberId: pending.binding.memberId,
                              phase: pending.phase,
                              failure: pending.failure,
                          },
                      }
                    : {}),
            };
        },

        /** The last run was cut off by a server stop and did not continue by itself: a person may say Continue. */
        async cutOff(id: ConversationId, latest: KernelReceipt | undefined): Promise<boolean> {
            const journal = owner.executions.journal;

            if (
                !latest ||
                owner.isRunning(id) ||
                latest.status === "unknown" ||
                latest.phase === "finalization"
            ) {
                return false;
            }

            const plan = await journal.resume(latest.id);

            return latest.status === "interrupted"
                ? plan?.state !== "pending" && plan?.state !== "started"
                : plan?.state === "capped" || plan?.state === "skipped";
        },

        clientLive(id: ConversationId): ClientLive {
            const live = owner.live.get(id);

            if (!owner.isRunning(id)) {
                return { busy: false };
            }

            return projectLive({
                run: { taskId: 0, inputs: [] },
                ...(live?.generation || live?.retry
                    ? {
                          generation: {
                              attempt: 1,
                              ...(live.generation
                                  ? {
                                        message: {
                                            ...live.generation.message,
                                            content:
                                                live.generation.message.content.filter(Boolean),
                                        },
                                    }
                                  : {}),
                              ...(live.retry ? { retry: live.retry } : {}),
                          },
                      }
                    : {}),
                ...(live?.tools.length ? { tools: live.tools } : {}),
                ...(live?.compacting
                    ? { compactions: [{ reason: live.compacting, blocking: true, attempt: 1 }] }
                    : {}),
            } as unknown as LiveState);
        },
    };
}

export type RoomDomain = ReturnType<typeof createRoomDomain>;
