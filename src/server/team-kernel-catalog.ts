import type { ConversationId } from "@earendil-works/pi-durable";
import type { User } from "./config.ts";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PocketApp } from "./app.ts";
import { HttpError } from "./errors.ts";
import { nativeBuiltinCommands } from "./rotom-kernel.ts";
import {
    nativeCommandName,
    nativeCommandArgs,
    currentBranchGoalState,
} from "./rotom-executions/contracts.ts";
import { teamResourceRevision } from "./rotom-resources.ts";
import {
    NativeCommandCatalogDoc,
    commandCatalogRevision,
    type NativeCommandCatalog,
    type NativeLive,
} from "./team-kernel-docs.ts";
import type { KernelBinding } from "./rotom-journal.ts";
import { RpcFailure } from "./rotom-rpc.ts";
import {
    supportedTeamCommand,
    teamCommandCatalog,
    teamCommandInputError,
    teamCommandWebInfo,
} from "./team-command-policy.ts";
import type { SubmissionOwner } from "./team-kernel-submission.ts";

export type CatalogOwner = SubmissionOwner & {
    app: PocketApp;
    commands: Map<ConversationId, NativeCommandCatalog>;
    live: Map<ConversationId, NativeLive>;
    nativeGoals: Map<ConversationId, unknown>;
    historicalGoals: Map<string, { rowid: number; version: string; value: unknown }>;
    ready: Set<ConversationId>;
};

export function createCatalogDomain(owner: CatalogOwner) {
    return {
        async discoverCommands(id: ConversationId, user: User, requestId: string) {
            return owner.operation(id, user, requestId, "discover", {}, async () => {
                owner.app.requireSteer(user);
                await owner.app.requireDriver(id, user, "rotom");

                if (owner.isRunning(id)) {
                    throw new HttpError(
                        409,
                        "Wait for this run before refreshing native commands.",
                    );
                }

                const prior = await owner.executions.journal.request(
                    String(id),
                    owner.request(id, user, requestId),
                );

                if (prior) {
                    if (prior.operation !== "discover") {
                        throw new HttpError(409, "Request belongs to another operation.");
                    }

                    return {
                        receipt: await owner.receipt(prior),
                        ...(await this.nativeCommands(id, user)),
                    };
                }

                if (
                    (await owner.executions.journal.pendingConversation(String(id)))?.status ===
                    "unknown"
                ) {
                    throw new HttpError(
                        409,
                        "Reconcile the unknown operation before refreshing native commands.",
                    );
                }

                const source = await owner.upgradeKernel(id, user);

                if (source.binding.memberId !== user.id) {
                    const takeover = await owner.handoff(
                        id,
                        user,
                        `discover-handoff-${createHash("sha256").update(requestId).digest("hex").slice(0, 40)}`,
                        source.segmentId,
                    );

                    if (takeover.status !== "settled") {
                        throw new HttpError(
                            409,
                            `Discovery handoff ended ${takeover.status}; no startup was replayed.`,
                        );
                    }
                }

                const binding = (await owner.executions.journal.session(String(id))).binding;
                const receipt = await owner.track(
                    id,
                    binding,
                    owner.executions.discover(
                        String(id),
                        owner.request(id, user, requestId),
                        owner.hooks(id),
                    ),
                );

                return { receipt, ...(await this.nativeCommands(id, user)) };
            });
        },

        async requireDynamicAdapter(
            id: ConversationId,
            user: User,
            name: string,
            requestId?: string,
        ) {
            if (!owner.isRunning(id)) {
                if (!requestId) {
                    throw new HttpError(
                        409,
                        "The run finished; submit this command again while idle.",
                    );
                }

                const discovery = await this.discoverCommands(
                    id,
                    user,
                    `registry-${createHash("sha256").update(requestId).digest("hex").slice(0, 40)}`,
                );

                if (discovery.receipt.status !== "handled") {
                    throw new HttpError(
                        409,
                        `Native command discovery ended ${discovery.receipt.status}.`,
                    );
                }
            }

            const registry = await this.nativeCommands(id, user);

            if (
                !registry.dynamicReady ||
                !registry.commands.some((command) => command.name === name)
            ) {
                throw new HttpError(
                    400,
                    `Native command /${name} is not registered for your selected runtime.`,
                );
            }
        },

        async commandSnapshot(
            id: ConversationId,
            memberId: string,
            knownSession?: { segmentId: string; binding: KernelBinding },
        ) {
            const cached = owner.commands.get(id);

            if (!cached) {
                return undefined;
            }

            // A standalone catalog read must prove the session still exists. A caller that already read the
            // session passes it here to avoid a duplicate journal read.
            if (
                knownSession === undefined &&
                !(await owner.executions.journal.hasConversation(String(id)))
            ) {
                return undefined;
            }

            const session = knownSession ?? (await owner.executions.journal.session(String(id)));

            if (
                cached?.memberId === memberId &&
                cached.segmentId === session.segmentId &&
                cached.binding === JSON.stringify(session.binding)
            ) {
                return cached;
            }
        },

        /** Recheck the live native registry: a cached template may now be shadowed by an extension. */
        admitNativeCommand(command: { name: string; source?: unknown; args?: string }) {
            if (!supportedTeamCommand(command)) {
                throw new RpcFailure("rejected", `/${command.name} is not supported in Team.`);
            }

            const error = teamCommandInputError(command, command.args);

            if (error) {
                throw new RpcFailure("rejected", error);
            }
        },

        /** Reject hidden commands before native startup, handoff or inference. Skills/templates still need discovery. */
        async requireSupportedCommand(
            id: ConversationId,
            user: User,
            text: string,
            requestId?: string,
        ) {
            const name = nativeCommandName(text);

            if (!name) {
                return;
            }

            const catalog = await this.nativeCommands(id, user);
            const observed = catalog.commands.find((command) => command.name === name);
            const error = observed && teamCommandInputError(observed, nativeCommandArgs(text));

            if (error) {
                throw new HttpError(400, error);
            }

            if (supportedTeamCommand({ name })) {
                return;
            }

            if (name.startsWith("skill:") && !catalog.dynamicReady) {
                await this.requireDynamicAdapter(id, user, name, requestId);

                return;
            }

            if (!catalog.commands.some((command) => command.name === name)) {
                throw new HttpError(
                    400,
                    `/${name} is not supported in Team. Open / to see available commands.`,
                );
            }
        },

        /** Read-only snapshots; another member's native command descriptions are never returned. */
        async nativeCommands(id: ConversationId, user: User) {
            owner.app.requireSee(user, id);

            const builtins = await nativeBuiltinCommands();

            if (!owner.commands.has(id)) {
                const saved = (
                    await owner.app.harness.snapshot(
                        NativeCommandCatalogDoc,
                        id,
                        BACKGROUND_CONTEXT,
                    )
                )?.catalog;

                if (saved) {
                    owner.commands.set(id, saved);
                }
            }

            const cached = await this.commandSnapshot(id, user.id);
            const dynamic = cached?.commands ?? [];

            return {
                commands: teamCommandCatalog([...builtins, ...dynamic]).map((command) => ({
                    ...command,
                    web: teamCommandWebInfo(command),
                })),
                dynamicReady: Boolean(cached),
                discoveryBlocked:
                    (await owner.executions.journal.pendingConversation(String(id)))?.status ===
                    "unknown",
                revision: commandCatalogRevision(cached),
                freshness: !cached
                    ? "undiscovered"
                    : cached.invalidated ||
                        cached.resourceRevision !==
                            teamResourceRevision(
                                join(owner.app.dataDir, "team-agent"),
                                owner.app.cwdOf(id),
                            )
                      ? "configuration-changed"
                      : owner.isRunning(id)
                        ? "live"
                        : "last-known",
                capturedAt: cached?.capturedAt ?? null,
            };
        },

        /** Canonical Goal snapshot captured after the native command barrier, if one has been observed. */
        async nativeGoal(
            id: ConversationId,
            readEntries = (segmentId: string) => owner.executions.journal.segmentEntries(segmentId),
        ): Promise<unknown> {
            if (owner.nativeGoals.has(id)) {
                return owner.nativeGoals.get(id);
            }

            const journal = owner.executions.journal;
            const session = await journal.sessionIfPresent(String(id));

            if (!session) {
                return undefined;
            }

            const { segmentId, binding } = session;
            const rowid = await journal.segmentRevision(segmentId);
            const cached = owner.historicalGoals.get(segmentId);

            if (cached?.rowid === rowid && cached.version === binding.kernelVersion) {
                return cached.value;
            }

            const entries = await readEntries(segmentId);
            const value = currentBranchGoalState({ entries, leafId: entries.at(-1)?.id });

            owner.historicalGoals.delete(segmentId);
            owner.historicalGoals.set(segmentId, { rowid, version: binding.kernelVersion, value });

            if (owner.historicalGoals.size > 128) {
                owner.historicalGoals.delete(owner.historicalGoals.keys().next().value!);
            }

            return value;
        },

        /** Room-wide public readback; share complete history only within this async projection. */
    };
}

export type CatalogDomain = ReturnType<typeof createCatalogDomain>;
