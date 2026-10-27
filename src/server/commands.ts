/** Native session creation/shared metadata and refusal boundaries for retired Durable commands. */
import { basename, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { clampThinkingLevel, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ConversationId, ModelRef, SubmissionId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import {
    NativeCreationsDoc,
    NativeForksDoc,
    NativeSetupDoc,
    type NativeCreation,
    type NativeForkPlan,
} from "./team-kernel.ts";
import type { User } from "./config.ts";
import { type Schedule, SessionsDoc } from "./docs.ts";
import { ARCHIVE_COPY } from "./constants/copy.ts";
import { describe, HttpError, optionalText } from "./errors.ts";
import { createWorktree, discardWorktree, type Worktree } from "./worktrees.ts";

const context = BACKGROUND_CONTEXT;

export type Attachment = { path: string; name: string; mime: string; size: number };

export interface SubmitRequest {
    text: string;
    attachments?: Attachment[];
    /** `steer` joins the running work after its current tool round; anything else queues a follow-up while busy. */
    mode?: "steer" | "followUp";
    /** Client-generated, so a retried POST does not submit twice. */
    requestId: string;
    /** Send the files the message mentions with `@` along with it, so Pi need not read them first. */
    inlineFiles?: boolean;
}

export const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MAX_TITLE = 120;

/** Where a new session works: a folder, and the worktree it is in when the session has one of its own. */
type Place = { cwd: string; worktree?: Worktree; skipped: string[] };

export class Commands {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** Start a session in a folder; with `worktree`, in a git worktree of its own made from that folder. */
    async createSession(
        user: User,
        request: { cwd?: string; title?: string; worktree?: unknown; backend?: unknown },
        fork?: NativeForkPlan,
        creation?: NativeCreation,
    ): Promise<{ id: ConversationId }> {
        const app = this.#app;

        app.requireSteer(user);

        if (user.sessions !== undefined) {
            throw new HttpError(403, "You were invited to one session and cannot start new ones.");
        }

        if (
            request.backend !== undefined &&
            request.backend !== "durable" &&
            request.backend !== "rotom"
        ) {
            throw new HttpError(400, "Unknown execution backend.");
        }

        const native =
            request.backend === "rotom" ||
            (request.backend === undefined && app.kernel !== undefined);

        if (!native) {
            throw new HttpError(409, ARCHIVE_COPY.readOnly);
        }

        if (!app.kernel) {
            throw new HttpError(409, "The rotom backend is not enabled on this server.");
        }

        const title = optionalText(request.title, "title")?.trim().slice(0, MAX_TITLE) || undefined;
        const folder = app.workspace.checkDirectory(
            optionalText(request.cwd, "cwd") ?? app.defaultCwd,
        );

        const projectId = fork
            ? app.sessionMeta(fork.sourceId)?.projectId
            : app.projects.forFolder(folder)?.id;

        if (fork) {
            this.requireForkable(fork.sourceId, user, "rotom");

            if (request.worktree || folder !== app.sessionMeta(fork.sourceId)?.cwd) {
                throw new HttpError(
                    400,
                    "Native fork must preserve its source workspace and backend.",
                );
            }
        } else {
            app.projects.require(user, projectId, "continue");
        }

        await app.accounts.forUser(user);
        const initial = this.defaultModel(user);

        if (!initial.model) {
            throw new HttpError(409, "Connect and select your own model account first.");
        }

        app.accounts.kernelModel(user, initial.model);

        const now = Date.now();

        return this.#inPlace(
            folder,
            request.worktree === true,
            title ?? basename(folder),
            async ({ cwd, worktree }) => {
                const conversation = await app.harness.createConversation(
                    {
                        ownership: { kind: "ownerless" },
                        agent: {
                            cwd,
                            ...(initial.model === undefined ? {} : { model: initial.model }),
                            ...(initial.thinkingLevel === undefined
                                ? {}
                                : { thinkingLevel: initial.thinkingLevel }),
                        },
                        init: async (tx, id) => {
                            if (creation) {
                                app.requireSee(user, creation.sourceId);
                                const creations = await tx.doc(
                                    NativeCreationsDoc,
                                    creation.sourceId,
                                );

                                if (creations.items[creation.requestId]) {
                                    throw new HttpError(
                                        409,
                                        "Native creation request already allocated.",
                                    );
                                }

                                creations.items[creation.requestId] = {
                                    id,
                                    identity: creation.identity,
                                };

                                if (creation.seed) {
                                    (await tx.doc(NativeSetupDoc, id)).seed = {
                                        requestId: creation.requestId,
                                    };
                                }
                            }

                            if (fork) {
                                this.requireForkable(fork.sourceId, user, "rotom");
                                const requests = await tx.doc(NativeForksDoc, fork.sourceId);

                                if (requests.items[fork.requestId]) {
                                    throw new HttpError(
                                        409,
                                        "Fork request already allocated; read its existing target.",
                                    );
                                }

                                requests.items[fork.requestId] = {
                                    id,
                                    expectedHead: fork.expectedHead,
                                    ...(fork.entryId ? { entryId: fork.entryId } : {}),
                                    ...(fork.clone ? { clone: true } : {}),
                                };
                                (await tx.doc(NativeSetupDoc, id)).seed = fork;
                            }

                            (await tx.doc(NativeSetupDoc, id)).binding = app.kernel!.binding(
                                user,
                                cwd,
                                initial.model!,
                                initial.thinkingLevel ?? "off",
                            );

                            const sessions = await tx.doc(SessionsDoc);

                            sessions.items[String(id)] = {
                                cwd,
                                backend: "rotom",
                                ...(fork ? { forkedFrom: { id: Number(fork.sourceId) } } : {}),
                                ...(projectId ? { projectId } : {}),
                                createdAt: now,
                                updatedAt: now,
                                createdBy: user.id,
                                ...(title === undefined ? {} : { title }),
                                ...(worktree === undefined ? {} : { worktree }),
                            };
                        },
                    },
                    context,
                );

                await app.kernel!.ensureBound(conversation.id);

                return { id: conversation.id };
            },
        );
    }

    /**
     * Run `create` with the folder a new session works in: `cwd` itself, or, when `isolated`, the matching folder in a
     * new git worktree made from it, named after `label`. A worktree whose session `create` did not make is discarded.
     */
    async #inPlace<T>(
        cwd: string,
        isolated: boolean,
        label: string,
        create: (place: Place) => Promise<T>,
    ): Promise<T> {
        if (!isolated) {
            return create({ cwd, skipped: [] });
        }

        const made = await createWorktree(cwd, join(this.#app.dataDir, "worktrees"), label);

        try {
            return await create(made);
        } catch (error) {
            await discardWorktree(made.worktree).catch((cleanup: unknown) =>
                this.#app.log(`worktree ${made.worktree.path} left behind: ${describe(cleanup)}`),
            );

            throw error;
        }
    }

    /** Worktree removal belonged to the retired Durable executor. */
    async removeWorktree(id: ConversationId, user: User, _force: unknown): Promise<void> {
        this.#app.requireSee(user, id);

        if (this.#app.sessionBackend(id) !== "durable") {
            throw new HttpError(
                409,
                "This operation is not supported by this conversation's execution backend.",
            );
        }

        await this.#app.requireDriver(id, user);

        throw new HttpError(409, ARCHIVE_COPY.readOnly);
    }

    /** The model a new session starts with: the one last chosen here, else Pi's default, else any available one. */
    defaultModel(user: User): { model?: ModelRef; thinkingLevel?: ModelThinkingLevel } {
        const { accounts, settings } = this.#app;
        const available = accounts.available(user);
        const pick = (provider: string | undefined, id: string | undefined) =>
            provider === undefined || id === undefined
                ? undefined
                : available.find((model) => model.provider === provider && model.id === id);
        const last = accounts.choice(user);
        const model =
            pick(last?.provider, last?.modelId) ??
            pick(settings.getDefaultProvider(), settings.getDefaultModel()) ??
            available[0];

        if (model === undefined) {
            return {};
        }

        const level = (last?.thinkingLevel ??
            settings.getDefaultThinkingLevel() ??
            "off") as ModelThinkingLevel;

        return {
            model: { provider: model.provider, modelId: model.id },
            thinkingLevel: clampThinkingLevel(model, level),
        };
    }

    async updateSession(
        id: ConversationId,
        user: User,
        patch: { title?: string; archived?: boolean },
    ): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        app.requireArchiveWriteAllowed(id);
        app.requireSteer(user);
        optionalText(patch.title, "title");

        if (patch.archived !== undefined && typeof patch.archived !== "boolean") {
            throw new HttpError(400, "archived must be true or false");
        }

        const before = app.sessionMeta(id);

        await app.harness.commit(async (tx) => {
            const sessions = await tx.doc(SessionsDoc);
            const meta = sessions.items[String(id)];

            if (meta === undefined) {
                throw new HttpError(404, "Not a session");
            }

            // A rename moves the session up the list. Archiving does not: brought back, or undone, it returns to where it was.
            if (patch.title !== undefined) {
                meta.title = patch.title.trim().slice(0, MAX_TITLE) || undefined;
                meta.updatedAt = Date.now();
            }

            if (patch.archived !== undefined) {
                meta.archived = patch.archived;
            }
        }, context);
        const title = patch.title?.trim().slice(0, MAX_TITLE);

        if (title !== undefined && title !== "" && title !== before?.title) {
            await app.collab.activity(id, user, `renamed the session to “${title}”`);
        }

        if (patch.archived !== undefined && patch.archived !== (before?.archived === true)) {
            await app.collab.activity(
                id,
                user,
                patch.archived
                    ? "archived the session"
                    : "brought the session back from the archive",
            );
        }
    }

    async submit(
        id: ConversationId,
        user: User,
        _request: SubmitRequest,
    ): Promise<{ submissionId: SubmissionId }> {
        this.#app.requireSee(user, id);
        await this.#app.requireDriver(id, user);

        throw new HttpError(409, ARCHIVE_COPY.readOnly);
    }

    /** Retired passive write command; native shared storage uses its own paths. */
    async note(id: ConversationId, _user: User, _text: string): Promise<void> {
        this.#app.requireArchiveWriteAllowed(id);

        throw new HttpError(409, ARCHIVE_COPY.executionRetired);
    }

    /** Retired Durable run control. */
    async abort(id: ConversationId, user: User): Promise<void> {
        this.#app.requireSee(user, id);
        this.#app.requireArchiveWriteAllowed(id);
        this.#app.requireSteer(user);

        throw new HttpError(409, ARCHIVE_COPY.readOnly);
    }

    /** Retired Durable queue control. */
    async withdraw(id: ConversationId, user: User, _submissionId: number): Promise<string> {
        this.#app.requireSee(user, id);
        this.#app.requireArchiveWriteAllowed(id);
        this.#app.requireSteer(user);

        throw new HttpError(409, ARCHIVE_COPY.readOnly);
    }

    async configure(
        id: ConversationId,
        user: User,
        _request: {
            model?: { provider: string; modelId: string };
            thinkingLevel?: string;
            cwd?: string;
        },
    ): Promise<void> {
        this.#app.requireSee(user, id);
        await this.#app.requireDriver(id, user);

        throw new HttpError(409, ARCHIVE_COPY.readOnly);
    }

    async applyProfile(id: ConversationId, user: User): Promise<void> {
        this.#app.requireSee(user, id);
        await this.#app.requireDriver(id, user);

        throw new HttpError(409, ARCHIVE_COPY.readOnly);
    }

    /** Retired Durable context reset. */
    async reset(id: ConversationId, user: User, _note: unknown): Promise<void> {
        this.#app.requireSee(user, id);
        await this.#app.requireDriver(id, user);

        throw new HttpError(409, ARCHIVE_COPY.readOnly);
    }

    /** Retired Durable instruction update. */
    async setInstructions(id: ConversationId, user: User, _text: unknown): Promise<void> {
        this.#app.requireSee(user, id);
        await this.#app.requireDriver(id, user);

        throw new HttpError(409, ARCHIVE_COPY.readOnly);
    }

    /** Retired Durable plan mode. */
    async setPlan(id: ConversationId, user: User, _on: unknown): Promise<void> {
        this.#app.requireSee(user, id);
        await this.#app.requireDriver(id, user);

        throw new HttpError(409, ARCHIVE_COPY.readOnly);
    }

    async approvePlan(id: ConversationId, user: User): Promise<{ submissionId: SubmissionId }> {
        this.#app.requireSee(user, id);
        await this.#app.requireDriver(id, user);

        throw new HttpError(409, ARCHIVE_COPY.readOnly);
    }

    /** Retired Durable schedule creation. */
    async schedule(
        id: ConversationId,
        user: User,
        _request: { when?: unknown; zone?: unknown },
    ): Promise<Schedule> {
        this.#app.requireSee(user, id);
        await this.#app.requireDriver(id, user);

        throw new HttpError(409, ARCHIVE_COPY.readOnly);
    }

    async cancelSchedule(id: ConversationId, user: User, _scheduleId: string): Promise<void> {
        this.#app.requireSee(user, id);
        await this.#app.requireDriver(id, user);

        throw new HttpError(409, ARCHIVE_COPY.readOnly);
    }

    /** Retired Durable goal creation. */
    async setGoal(id: ConversationId, user: User, _command: unknown): Promise<void> {
        this.#app.requireSee(user, id);
        await this.#app.requireDriver(id, user);

        throw new HttpError(409, ARCHIVE_COPY.readOnly);
    }

    async clearGoal(id: ConversationId, user: User): Promise<void> {
        this.#app.requireSee(user, id);
        this.#app.requireArchiveWriteAllowed(id);
        this.#app.requireSteer(user);

        throw new HttpError(409, ARCHIVE_COPY.readOnly);
    }

    /** Retired Durable fork. Native forks use TeamKernel. */
    async fork(
        id: ConversationId,
        user: User,
        _request: { entryId?: unknown; worktree?: unknown },
    ): Promise<{ id: ConversationId }> {
        this.#requireForkable(id, user);

        throw new HttpError(409, ARCHIVE_COPY.readOnly);
    }

    /** Retired Durable resend. Native forks use TeamKernel. */
    async resend(
        id: ConversationId,
        user: User,
        _request: { entryId?: unknown; text?: unknown; model?: unknown; worktree?: unknown },
    ): Promise<{ id: ConversationId }> {
        this.#requireForkable(id, user);

        throw new HttpError(409, ARCHIVE_COPY.readOnly);
    }

    /** Forks are new sessions: who may start one may fork, from a session they can see. */
    #requireForkable(id: ConversationId, user: User): void {
        this.requireForkable(id, user, "durable");
    }

    requireForkable(id: ConversationId, user: User, backend: "durable" | "rotom"): void {
        const app = this.#app;

        if (app.sessionBackend(id) !== backend) {
            throw new HttpError(
                409,
                "Fork must preserve the source execution backend; no fallback is allowed.",
            );
        }

        app.requireSee(user, id);

        if (backend === "durable") {
            app.requireArchiveWriteAllowed(id);
        }

        app.requireSteer(user);
        app.projects.require(user, app.sessionMeta(app.rootOf(id))?.projectId, "fork");

        if (user.sessions !== undefined) {
            throw new HttpError(403, "You were invited to one session and cannot start new ones.");
        }

        if (app.sessionMeta(id) === undefined) {
            throw new HttpError(400, "Only sessions can be forked");
        }
    }

    async compact(
        id: ConversationId,
        user: User,
        _instructions: string | undefined,
    ): Promise<void> {
        this.#app.requireSee(user, id);
        await this.#app.requireDriver(id, user);

        throw new HttpError(409, ARCHIVE_COPY.readOnly);
    }
}
