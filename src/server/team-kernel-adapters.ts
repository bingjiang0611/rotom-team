import { join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { User } from "./config.ts";
import { HttpError } from "./errors.ts";
import { safeConfigurationPath } from "./rotom-resource-policy.ts";
import type { KernelEntry } from "./rotom-journal.ts";
import type { NativeLive } from "./team-kernel-docs.ts";
import { nativeConfigurationApi } from "./rotom-kernel.ts";
import { nativeCommandName, nativeCommandArgs } from "./rotom-executions/contracts.ts";
import type { SubmissionOwner } from "./team-kernel-submission.ts";
import type { NativeCommandCatalog } from "./team-kernel-docs.ts";
import type { McpSignIns } from "./mcp-sign-in.ts";

export type AdapterOwner = SubmissionOwner & {
    live: Map<ConversationId, NativeLive>;
    commands: Map<ConversationId, NativeCommandCatalog>;
    active: Set<unknown>;
    home: (memberId: string) => string;
    mcp: McpSignIns;
};

export function createAdapterDomain(owner: AdapterOwner) {
    return {
        async answerDialog(
            id: ConversationId,
            user: User,
            body: unknown,
        ): Promise<{ answered: true }> {
            const request = body as {
                id?: unknown;
                value?: unknown;
                confirmed?: unknown;
                cancelled?: unknown;
            } | null;
            const dialog = owner.live
                .get(id)
                ?.dialogs?.find(
                    (each) => typeof request?.id === "string" && each.id === request.id,
                );

            if (!request || typeof request !== "object" || typeof request.id !== "string") {
                throw new HttpError(400, "A dialog id is required.");
            }

            owner.app.requireSteer(user);

            if ((await owner.executions.journal.session(String(id))).binding.memberId !== user.id) {
                throw new HttpError(
                    403,
                    "Only the member this run is for can answer its questions.",
                );
            }

            if (!dialog) {
                throw new HttpError(409, "That question is no longer waiting.");
            }

            const response =
                request.cancelled === true
                    ? { cancelled: true as const }
                    : dialog.method === "confirm"
                      ? typeof request.confirmed === "boolean"
                          ? { confirmed: request.confirmed }
                          : undefined
                      : typeof request.value === "string" &&
                          (dialog.method !== "select" || dialog.options?.includes(request.value))
                        ? { value: request.value }
                        : undefined;

            if (!response) {
                throw new HttpError(400, "The answer does not fit this question.");
            }

            const live = owner.live.get(id)!;

            live.dialogs = live.dialogs!.filter((each) => each.id !== dialog.id);
            owner.app.kernelChanged();

            if (!owner.executions.answer(String(id), dialog.id, response)) {
                owner.app.roomChanged(id);

                throw new HttpError(409, "That question is no longer waiting.");
            }

            owner.app.roomChanged(id);

            return { answered: true };
        },

        async currentChoice(id: ConversationId, user: User) {
            const { binding } = await owner.executions.journal.session(String(id));

            return binding.memberId === user.id
                ? {
                      ...owner.ref(binding),
                      thinkingLevel: await owner.executions.thinkingLevel(String(id)),
                  }
                : owner.app.accounts.choice(user);
        },

        async agentInfo(
            id: ConversationId,
            readEntries?: (segmentId: string) => Promise<KernelEntry[]>,
        ) {
            const cwd = owner.app.sessionMeta(id)?.cwd ?? owner.app.defaultCwd;
            const session = await owner.executions.journal.sessionIfPresent(String(id));

            if (!session) {
                return { model: null, thinkingLevel: "off", cwd, available: false };
            }

            const { binding } = session;

            return {
                model: { provider: binding.accountGeneration, modelId: binding.model },
                modelName: binding.model,
                accountName: owner.app.config.userById(binding.memberId)?.name ?? "A former member",
                personalAccount: true,
                thinkingLevel: await owner.executions.thinkingLevel(String(id), readEntries),
                cwd: binding.workspace,
                available: true,
            };
        },

        async mcpCommand(id: ConversationId, user: User, text: string, requestId?: string) {
            if (nativeCommandName(text) !== "mcp") {
                return undefined;
            }

            const args = nativeCommandArgs(text);
            const [action, server, ...extra] = args.split(/\s+/);

            if (action && action !== "login" && action !== "logout") {
                return undefined;
            }

            if (extra.length) {
                throw new HttpError(400, "Use /mcp login <server> or /mcp logout <server>.");
            }

            await owner.requireDynamicAdapter(id, user, "mcp", requestId);

            if (!action || !server) {
                return { status: "handled" as const, interaction: { type: "mcp" } };
            }

            const result = await this.mcp(id, user, action, { server });

            return {
                status: "handled" as const,
                interaction: {
                    type: "mcp",
                    ...("status" in result && result.status === "open"
                        ? { signIn: { ...result, server } }
                        : {
                              message:
                                  "message" in result ? result.message : "MCP command completed.",
                          }),
                },
            };
        },

        async mcp(id: ConversationId, user: User, action: string, body?: unknown) {
            const current = owner.app.config.userById(user.id);

            if (!current) {
                throw new HttpError(403, "Membership ended.");
            }

            owner.app.requireSee(current, id);
            owner.app.requireSteer(current);
            owner.app.projects.require(
                current,
                owner.app.sessionMeta(owner.app.rootOf(id))?.projectId,
                "continue",
            );

            if (!(await owner.executions.journal.hasConversation(String(id)))) {
                throw new HttpError(409, "This session is still starting.");
            }

            const { workspace } = (await owner.executions.journal.session(String(id))).binding;
            const home = owner.home(current.id);
            const key = JSON.stringify([current.id, workspace]);
            const request = (body ?? {}) as { server?: unknown; url?: unknown };

            switch (action) {
                case "list":
                    return owner.mcp.list(home, workspace);
                case "login":
                    return owner.mcp.start(key, home, workspace, request.server);
                case "finish":
                    return owner.mcp.finish(key, request.url);
                case "logout":
                    return owner.mcp.logout(home, workspace, request.server);
                default:
                    throw new HttpError(404, "Unknown MCP action.");
            }
        },

        async nativeSettings(id: ConversationId, user: User, patch?: Record<string, unknown>) {
            owner.app.requireSee(user, id);
            owner.app.requireSteer(user);
            owner.app.projects.require(user, owner.app.sessionMeta(id)?.projectId, "continue");
            await owner.app.accounts.forUser(user);
            const api = await nativeConfigurationApi();

            safeConfigurationPath(join(owner.app.dataDir, "team-agent"), "settings.json");
            const manager = api.SettingsManager.create(
                owner.app.cwdOf(id),
                join(owner.app.dataDir, "team-agent"),
                { projectTrusted: false },
            );

            if (patch) {
                if (user.role !== "owner") {
                    throw new HttpError(403, "Only the owner can change shared agent settings.");
                }

                if (owner.active.size > 0) {
                    throw new HttpError(
                        409,
                        "Wait for active Team runs before changing shared settings.",
                    );
                }

                await owner.requireAccountIdle(user);
                const allowed = [
                    "steeringMode",
                    "followUpMode",
                    "imageAutoResize",
                    "blockImages",
                    "enableSkillCommands",
                    "enabledModels",
                ];

                if (Object.keys(patch).some((key) => !allowed.includes(key))) {
                    throw new HttpError(400, "Unknown native execution setting.");
                }

                for (const key of ["steeringMode", "followUpMode"]) {
                    if (
                        patch[key] !== undefined &&
                        !["all", "one-at-a-time"].includes(String(patch[key]))
                    ) {
                        throw new HttpError(400, "Queue mode must be all or one-at-a-time.");
                    }
                }

                for (const key of ["imageAutoResize", "blockImages", "enableSkillCommands"]) {
                    if (patch[key] !== undefined && typeof patch[key] !== "boolean") {
                        throw new HttpError(400, `${key} must be boolean.`);
                    }
                }

                if (
                    patch.enabledModels !== undefined &&
                    (!Array.isArray(patch.enabledModels) ||
                        !patch.enabledModels.every((item) => typeof item === "string"))
                ) {
                    throw new HttpError(
                        400,
                        "enabledModels must be a list of native model patterns.",
                    );
                }

                if (patch.steeringMode !== undefined) {
                    manager.setSteeringMode(patch.steeringMode);
                }

                if (patch.followUpMode !== undefined) {
                    manager.setFollowUpMode(patch.followUpMode);
                }

                if (patch.imageAutoResize !== undefined) {
                    manager.setImageAutoResize(patch.imageAutoResize);
                }

                if (patch.blockImages !== undefined) {
                    manager.setBlockImages(patch.blockImages);
                }

                if (patch.enableSkillCommands !== undefined) {
                    manager.setEnableSkillCommands(patch.enableSkillCommands);
                }

                if (patch.enabledModels !== undefined) {
                    manager.setEnabledModels(patch.enabledModels);
                }

                await manager.flush();

                for (const [sessionId, cached] of owner.commands) {
                    cached.invalidated = true;
                    owner.app.roomChanged(sessionId);
                }

                const errors = manager.drainErrors();

                if (errors.length) {
                    throw new HttpError(409, "Native settings could not be saved.");
                }
            }

            const available = owner.app.accounts.available(user);
            const nativeModels = available.map((model) =>
                owner.app.accounts.kernelModel(user, {
                    provider: model.provider,
                    modelId: model.id,
                }),
            );
            const scope = api.resolveModelScopeFromModels(
                manager.getEnabledModels() ?? [],
                nativeModels,
            ) as {
                scopedModels: Array<{
                    model: { provider: string; id: string };
                    thinkingLevel?: string;
                }>;
                diagnostics: Array<{ message: string }>;
            };

            return {
                steeringMode: manager.getSteeringMode(),
                followUpMode: manager.getFollowUpMode(),
                imageAutoResize: manager.getImageAutoResize(),
                blockImages: manager.getBlockImages(),
                enableSkillCommands: manager.getEnableSkillCommands(),
                enabledModels: manager.getEnabledModels() ?? [],
                autoRetry: manager.getRetryEnabled(),
                autoCompaction: manager.getCompactionEnabled(),
                scopeWarnings: scope.diagnostics.map((item) => item.message),
                models: available.map((model) => {
                    const native = owner.app.accounts.kernelModel(user, {
                        provider: model.provider,
                        modelId: model.id,
                    });

                    const scoped = scope.scopedModels.find(
                        (item) =>
                            item.model.provider === native.provider && item.model.id === native.id,
                    );

                    return {
                        provider: model.provider,
                        id: model.id,
                        name: model.name,
                        nativeName: `${native.provider}/${native.id}`,
                        selected: scoped !== undefined,
                        thinkingLevel: scoped?.thinkingLevel,
                    };
                }),
            };
        },
    };
}

export type AdapterDomain = ReturnType<typeof createAdapterDomain>;
