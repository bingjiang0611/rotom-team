/** Opt-in application boundary: team authorizes and owns credentials; pinned rotom alone executes new native conversations. */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { ConversationId, ModelRef } from "@earendil-works/pi-durable";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import type { ConfigurationSnapshot } from "./team-profiles.ts";
import { accountContext } from "./team-accounts.ts";
import { HttpError } from "./errors.ts";
import { RotomExecutions } from "./rotom-executions.ts";
import type { KernelBinding, KernelReceipt } from "./rotom-journal.ts";
import { verifyRotomKernel } from "./rotom-kernel.ts";

export class TeamKernel {
    readonly executions: RotomExecutions;
    readonly #app: PocketApp;
    readonly #active = new Set<{ id: ConversationId; promise: Promise<KernelReceipt> }>();
    #closing = false;
    constructor(app: PocketApp) {
        this.#app = app;
        verifyRotomKernel();
        this.executions = new RotomExecutions(
            app.dataDir,
            async (binding, operation, sessionId) => {
                const id = this.#id(sessionId);
                const user = await this.#check(binding, id);

                if (operation === "refresh") {
                    throw new Error(
                        "Native OAuth refresh is disabled; the team credential store is the only writer",
                    );
                }

                if (operation === "inference") {
                    const auth = await app.accounts.kernelAuth(user, this.#ref(binding));

                    await this.#check(binding, id);

                    return auth;
                }
            },
            (binding, sessionId) => {
                const user = app.config.userById(binding.memberId)!;
                const model = app.accounts.kernelModel(user, this.#ref(binding));
                const snapshot = app.profiles.snapshot(this.#id(sessionId));

                if (!snapshot || snapshot.digest !== binding.configurationDigest) {
                    throw new HttpError(409, "Frozen configuration changed.");
                }

                // A broker HOME may not borrow an independently refreshable native grant, even if a prior prototype left one there.
                const authFile = join(binding.home, ".pi/agent/auth.json");

                // Native AuthStorage creates an empty file during normal use. Accept only that empty canonical file.
                if (
                    existsSync(authFile) &&
                    (!lstatSync(authFile).isFile() ||
                        realpathSync(authFile) !== authFile ||
                        lstatSync(authFile).size > 64 ||
                        readFileSync(authFile, "utf8").trim() !== "{}")
                ) {
                    throw new HttpError(
                        409,
                        "Use a fresh broker HOME; native credential migration is not supported.",
                    );
                }

                return {
                    modelDefinition: { ...model },
                    context: snapshot.context,
                    skills: snapshot.skills.map((skill) => skill.path),
                };
            },
        );
    }

    #id(value: string): ConversationId {
        const id = Number(value);

        if (!Number.isSafeInteger(id) || String(id) !== value) {
            throw new HttpError(403, "Unknown team conversation.");
        }

        return id as ConversationId;
    }
    #ref(binding: KernelBinding): ModelRef {
        // The complete personal alias includes the account generation; never parse/rekey a foreign credential.
        return { provider: binding.accountGeneration, modelId: binding.model };
    }
    async #check(binding: KernelBinding, id: ConversationId): Promise<User> {
        const app = this.#app;

        if (this.#closing || app.sessionMeta(id)?.backend !== "rotom") {
            throw new HttpError(409, "Native execution is unavailable.");
        }

        const user = app.config.userById(binding.memberId);

        if (!user) {
            throw new HttpError(403, "Membership ended.");
        }

        app.requireSee(user, id);
        await app.requireDriver(id, user, "rotom");

        if (app.sessionMeta(id)?.cwd !== binding.workspace) {
            throw new HttpError(409, "Execution workspace changed.");
        }

        if (user.budget !== undefined || app.sessionMeta(id)?.budget !== undefined) {
            throw new HttpError(
                409,
                "Native USD budget enforcement is not implemented; this execution is blocked, not exempted.",
            );
        }

        const model = app.accounts.kernelModel(user, this.#ref(binding));

        if (model.provider !== binding.provider) {
            throw new HttpError(409, "Personal provider binding changed.");
        }

        const configuration = app.profiles.snapshot(id);

        if (!configuration || configuration.digest !== binding.configurationDigest) {
            throw new HttpError(409, "Frozen configuration changed.");
        }

        await app.execution.accountIdle(user, String(id));

        return user;
    }

    bind(
        id: ConversationId,
        user: User,
        cwd: string,
        snapshot: ConfigurationSnapshot,
        ref: ModelRef,
        thinkingLevel: string,
    ): void {
        const model = this.#app.accounts.kernelModel(user, ref);
        const home = join(this.#app.dataDir, "kernel-homes", user.id);

        mkdirSync(home, { recursive: true, mode: 0o700 });
        this.executions.journal.bind(String(id), {
            memberId: user.id,
            kernelVersion: verifyRotomKernel().version,
            accountGeneration: ref.provider,
            provider: model.provider,
            model: model.id,
            thinkingLevel,
            configurationDigest: snapshot.digest,
            home,
            workspace: cwd,
        });
    }

    requireAccountIdle(user: User, exceptSession?: string): void {
        const pending = this.executions.journal.pending(user.id);

        if (pending && pending.sessionId !== exceptSession) {
            throw new HttpError(
                409,
                "A rotom execution is active or unknown. Reconcile it before using this account again.",
            );
        }
    }

    isRunning(id: ConversationId): boolean {
        return [...this.#active].some((run) => run.id === id);
    }

    snapshot(id: ConversationId, user: User) {
        this.#app.requireSee(user, id);

        if (this.#app.sessionMeta(id)?.backend !== "rotom") {
            throw new HttpError(409, "This conversation does not use rotom.");
        }

        const journal = this.executions.journal;
        const messages = journal
            .entries(String(id))
            .flatMap(({ entry }) =>
                entry.type === "message" && entry.message ? [entry.message] : [],
            );
        const publicMessages = accountContext({ messages } as TranscriptContext, "", "").messages;
        const binding = journal.session(String(id)).binding;

        return {
            backend: "rotom",
            memberId: binding.memberId,
            provider: binding.provider,
            model: binding.model,
            configurationDigest: binding.configurationDigest,
            thinkingLevel: binding.thinkingLevel,
            messages: publicMessages,
            receipts: journal
                .receipts(String(id))
                .map(({ id, requestId, status }) => ({ id, requestId, status })),
            receiptsLimit: 100,
            usage: journal.usage(String(id)),
            costStatus: "unknown",
            // Do not fold provisional output into the durable transcript or the old Durable spend counter.
            streaming: this.isRunning(id),
        };
    }

    async submit(id: ConversationId, user: User, requestId: string, text: string) {
        const binding = this.executions.journal.session(String(id)).binding;
        const current = this.#app.config.userById(user.id);

        if (!current || current.id !== binding.memberId) {
            throw new HttpError(
                403,
                "Cross-account native takeover is not enabled; another member's quota cannot be used.",
            );
        }

        if (
            typeof requestId !== "string" ||
            !requestId ||
            `${user.id}:${requestId}`.length > 128 ||
            typeof text !== "string"
        ) {
            throw new HttpError(400, "A stable requestId and text are required.");
        }

        if (!text.trim() || text.trimStart().startsWith("/")) {
            throw new HttpError(
                400,
                "Native submissions require ordinary text; slash commands are not supported.",
            );
        }

        await this.#check(binding, id);
        const run = {
            id,
            promise: this.executions.run(String(id), `${user.id}:${requestId}`, text),
        };

        this.#active.add(run);
        this.#app.kernelChanged();

        try {
            const receipt = await run.promise;

            return { id: receipt.id, requestId: receipt.requestId, status: receipt.status };
        } finally {
            this.#active.delete(run);
            this.#app.kernelChanged();
        }
    }

    async abort(id: ConversationId, user: User): Promise<void> {
        const current = this.#app.config.userById(user.id);

        if (!current) {
            throw new HttpError(403, "Membership ended.");
        }

        this.#app.requireSee(current, id);
        await this.#app.requireDriver(id, current, "rotom");
        await this.executions.abort(String(id));
    }

    async revoke(): Promise<void> {
        for (const id of new Set([...this.#active].map((run) => run.id))) {
            try {
                await this.#check(this.executions.journal.session(String(id)).binding, id);
            } catch {
                await this.executions.abort(String(id));
            }
        }
    }

    async close(): Promise<void> {
        this.#closing = true;

        for (const id of new Set([...this.#active].map((run) => run.id))) {
            await this.executions.abort(String(id));
        }

        await Promise.allSettled([...this.#active].map((run) => run.promise));
        this.executions.close();
    }
}
