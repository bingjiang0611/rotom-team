/** Opt-in application boundary: team authorizes and owns credentials; pinned rotom alone executes new native conversations. */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { defineDoc, type ConversationId, type ModelRef } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import type { ConfigurationSnapshot } from "./team-profiles.ts";
import { accountContext } from "./team-accounts.ts";
import { HttpError } from "./errors.ts";
import { RotomExecutions } from "./rotom-executions.ts";
import type { KernelBinding, KernelReceipt } from "./rotom-journal.ts";
import { verifyRotomKernel } from "./rotom-kernel.ts";

/** App-side creation intent. Never copied from a source conversation or rebuilt from today's account settings. */
export type NativeForkPlan = { sourceId: ConversationId; requestId: string; expectedHead: string };
export const NativeForksDoc = defineDoc<{
    items: Record<string, { id: ConversationId; expectedHead: string }>;
}>({
    kind: "rotom-team.native-forks",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ items: {} }),
});
export const NativeSetupDoc = defineDoc<{
    binding?: KernelBinding;
    bound?: true;
    seed?: NativeForkPlan;
}>({
    kind: "rotom-team.native-setup",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({}),
});

type NativeConfigurations = {
    snapshots: Record<string, ConfigurationSnapshot>;
    requests: Record<string, { expectedHead: string; binding: KernelBinding }>;
};
export const NativeConfigurationsDoc = defineDoc<NativeConfigurations>({
    kind: "rotom-team.native-configurations",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ snapshots: {}, requests: {} }),
});

export class TeamKernel {
    readonly executions: RotomExecutions;
    readonly #app: PocketApp;
    readonly #active = new Set<{
        id: ConversationId;
        binding: KernelBinding;
        promise: Promise<KernelReceipt>;
    }>();
    #closing = false;
    readonly #ready = new Set<ConversationId>();
    readonly #configurations = new Map<ConversationId, NativeConfigurations>();
    readonly #operations = new Map<
        string,
        { operation: string; identity: string; promise: Promise<unknown> }
    >();
    constructor(app: PocketApp) {
        this.#app = app;
        verifyRotomKernel();
        this.executions = new RotomExecutions(
            app.dataDir,
            async (binding, operation, sessionId) => {
                const id = this.#id(sessionId);

                if (operation === "fork") {
                    if (this.#closing) {
                        throw new HttpError(409, "Native execution is unavailable.");
                    }

                    const member = app.config.userById(binding.memberId);

                    if (!member) {
                        throw new HttpError(403, "Membership ended.");
                    }

                    app.commands.requireForkable(id, member, "rotom");

                    return;
                }

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
                const snapshot = this.#snapshot(binding, this.#id(sessionId));

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
    configuration(id: ConversationId): ConfigurationSnapshot | undefined {
        return this.#snapshot(this.executions.journal.session(String(id)).binding, id);
    }

    #snapshot(binding: KernelBinding, id: ConversationId): ConfigurationSnapshot | undefined {
        const snapshot = this.#configurations.get(id)?.snapshots[binding.configurationDigest];

        if (snapshot) {
            this.#app.profiles.verify(snapshot);

            return snapshot;
        }

        const initial = this.#app.profiles.snapshot(id);

        if (!initial || initial.digest !== binding.configurationDigest) {
            throw new HttpError(
                409,
                "Frozen native configuration is unavailable; restore its verified snapshot.",
            );
        }

        return initial;
    }

    async #check(
        binding: KernelBinding,
        id: ConversationId,
        staged?: ConfigurationSnapshot,
    ): Promise<User> {
        const app = this.#app;

        if (this.#closing || !this.#ready.has(id) || app.sessionMeta(id)?.backend !== "rotom") {
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

        const configuration = staged ?? this.#snapshot(binding, id);

        if (staged) {
            app.profiles.verify(staged);
        }

        if (!configuration || configuration.digest !== binding.configurationDigest) {
            throw new HttpError(409, "Frozen configuration changed.");
        }

        await app.execution.accountIdle(user, String(id));

        return user;
    }

    binding(
        user: User,
        cwd: string,
        snapshot: ConfigurationSnapshot,
        ref: ModelRef,
        thinkingLevel: string,
    ): KernelBinding {
        const model = this.#app.accounts.kernelModel(user, ref);
        const home = this.#home(user.id);

        return {
            memberId: user.id,
            kernelVersion: verifyRotomKernel().version,
            accountGeneration: ref.provider,
            provider: model.provider,
            model: model.id,
            thinkingLevel,
            configurationDigest: snapshot.digest,
            home,
            workspace: cwd,
        };
    }

    #home(memberId: string): string {
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(memberId)) {
            throw new Error("Invalid native member identity");
        }

        const parent = join(this.#app.dataDir, "kernel-homes");

        for (const path of [parent, join(parent, memberId)]) {
            mkdirSync(path, { recursive: true, mode: 0o700 });

            if (
                realpathSync(path) !== path ||
                !lstatSync(path).isDirectory() ||
                lstatSync(path).mode & 0o077
            ) {
                throw new Error("Native HOME must be canonical and private");
            }
        }

        return join(parent, memberId);
    }

    /** Reconcile only binding metadata. No provider request or history seed is resumed here. */
    async ensureBound(id: ConversationId): Promise<void> {
        const app = this.#app;

        if (app.sessionMeta(id)?.backend !== "rotom") {
            throw new Error("Native setup requires committed native session metadata");
        }

        const journal = this.executions.journal;
        const exists = journal.hasConversation(String(id));
        const setup = await app.harness.snapshot(NativeSetupDoc, id, BACKGROUND_CONTEXT);
        // Pre-setup-document deployments are recoverable only from their original immutable journal binding.
        const binding =
            setup?.binding ?? (exists ? journal.segment(String(id)).binding : undefined);

        if (!binding || (!exists && setup?.bound)) {
            throw new Error(
                "Native execution journal is missing; restore/reconcile it, never reconstruct prior execution from current settings",
            );
        }

        if (
            binding.home !== join(app.dataDir, "kernel-homes", binding.memberId) ||
            binding.workspace !== app.sessionMeta(id)?.cwd
        ) {
            throw new Error("Native setup identity does not match application metadata");
        }

        this.#home(binding.memberId);
        journal.bind(String(id), binding);

        if (!setup?.bound) {
            await app.harness.commit(async (tx) => {
                Object.assign(await tx.doc(NativeSetupDoc, id), { binding, bound: true });
            }, BACKGROUND_CONTEXT);
        }

        if (
            !setup?.seed ||
            journal.request(String(id), setup.seed.requestId)?.status === "settled"
        ) {
            this.#ready.add(id);
        }
    }

    async reconcile(ids: readonly ConversationId[]): Promise<void> {
        const native = ids.filter((id) => this.#app.sessionMeta(id)?.backend === "rotom");

        this.executions.journal.reconcileOrphans(new Set(native.map(String)));

        for (const id of native) {
            const configurations = await this.#app.harness.snapshot(
                NativeConfigurationsDoc,
                id,
                BACKGROUND_CONTEXT,
            );

            if (configurations) {
                this.#configurations.set(id, configurations);
            }

            await this.ensureBound(id);
        }
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

        if (!this.executions.journal.hasConversation(String(id))) {
            throw new HttpError(
                409,
                "Native initialization is incomplete; reconcile setup before execution.",
            );
        }

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
        const { binding, segmentId } = journal.session(String(id));

        return {
            backend: "rotom",
            initializing: !this.#ready.has(id),
            segmentId,
            memberId: binding.memberId,
            provider: binding.provider,
            model: binding.model,
            configurationDigest: binding.configurationDigest,
            thinkingLevel: binding.thinkingLevel,
            messages: publicMessages,
            receipts: journal.receipts(String(id)).map((receipt) => ({
                ...this.#receipt(receipt),
                memberId: receipt.binding.memberId,
            })),
            receiptsLimit: 100,
            usage: journal.usage(String(id)),
            credits: journal.credits(String(id)),
            costStatus: "unknown",
            // Do not fold provisional output into the durable transcript or the old Durable spend counter.
            streaming: this.isRunning(id),
        };
    }

    #operation<T>(
        id: ConversationId,
        user: User,
        requestId: string,
        operation: string,
        payload: unknown,
        action: () => Promise<T>,
    ): Promise<T> {
        const key = this.#request(id, user, requestId, true, operation);
        const scope = JSON.stringify([id, key]);
        const identity = JSON.stringify(payload);
        const existing = this.#operations.get(scope);

        if (existing) {
            if (existing.operation !== operation || existing.identity !== identity) {
                throw new HttpError(
                    409,
                    "Request identity is already being allocated to another operation.",
                );
            }

            return existing.promise as Promise<T>;
        }

        // Claim identity synchronously, before any authorization/document await. Distinct requests are never queued.
        const promise = Promise.resolve()
            .then(async () => {
                await this.#forkIdentity(id, key, operation);

                return action();
            })
            .finally(() => this.#operations.delete(scope));

        this.#operations.set(scope, { operation, identity, promise });

        return promise;
    }

    submit(id: ConversationId, user: User, requestId: string, text: string) {
        return this.#operation(id, user, requestId, "submit", { text }, () =>
            this.#submit(id, user, requestId, text),
        );
    }
    compact(id: ConversationId, user: User, requestId: string, instructions: string) {
        return this.#operation(id, user, requestId, "compact", { instructions }, () =>
            this.#compact(id, user, requestId, instructions),
        );
    }
    handoff(id: ConversationId, user: User, requestId: string, expectedHead: string) {
        return this.#operation(id, user, requestId, "handoff", { expectedHead }, () =>
            this.#handoff(id, user, requestId, expectedHead),
        );
    }
    fork(id: ConversationId, user: User, requestId: string, expectedHead: string) {
        return this.#operation(id, user, requestId, "fork", { expectedHead }, () =>
            this.#fork(id, user, requestId, expectedHead),
        );
    }
    configure(id: ConversationId, user: User, requestId: string, expectedHead: string) {
        return this.#operation(id, user, requestId, "configuration", { expectedHead }, () =>
            this.#configure(id, user, requestId, expectedHead),
        );
    }

    async #submit(id: ConversationId, user: User, requestId: string, text: string) {
        const key = this.#request(id, user, requestId);

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

        const previous = this.executions.journal.existing(String(id), key, text);

        if (previous) {
            return this.#receipt(previous);
        }

        const binding = this.executions.journal.session(String(id)).binding;

        if (binding.memberId !== user.id) {
            throw new HttpError(
                403,
                "Explicitly take over with your own account before sending; another member's quota cannot be used.",
            );
        }

        return this.#track(id, binding, this.executions.run(String(id), key, text));
    }

    #request(
        id: ConversationId,
        user: User,
        requestId: string,
        requireReady = true,
        operation = "submit",
    ): string {
        const current = this.#app.config.userById(user.id);

        if (!current) {
            throw new HttpError(403, "Membership ended.");
        }

        this.#app.requireSee(current, id);

        if (requireReady && !this.#ready.has(id)) {
            throw new HttpError(
                409,
                "Native initialization is incomplete; reconcile setup before execution.",
            );
        }

        if (typeof requestId !== "string" || !requestId || `${user.id}:${requestId}`.length > 128) {
            throw new HttpError(400, "A stable requestId is required.");
        }

        const key = `${user.id}:${requestId}`;

        if (operation !== "configuration" && this.#configurations.get(id)?.requests[key]) {
            throw new HttpError(409, "Request belongs to configuration activation.");
        }

        return key;
    }

    async #forkIdentity(id: ConversationId, key: string, operation: string): Promise<void> {
        // Fork receipts live on the target, but their request identity belongs to the source.
        const plan = (await this.#app.harness.snapshot(NativeForksDoc, id, BACKGROUND_CONTEXT))
            ?.items[key];

        if (plan && operation !== "fork") {
            throw new HttpError(409, "Request belongs to a fork allocation.");
        }

        if (operation === "fork" && this.executions.journal.request(String(id), key)) {
            throw new HttpError(409, "Request belongs to another operation.");
        }
    }

    async lookup(id: ConversationId, user: User, requestId: string, operation: string) {
        const key = this.#request(id, user, requestId, false, operation);

        if (!["submit", "handoff", "compact", "fork", "configuration"].includes(operation)) {
            throw new HttpError(400, "Unknown native operation.");
        }

        await this.#forkIdentity(id, key, operation);
        let targetId: ConversationId | null = id;

        if (operation === "fork") {
            targetId =
                (await this.#app.harness.snapshot(NativeForksDoc, id, BACKGROUND_CONTEXT))?.items[
                    key
                ]?.id ?? null;

            if (targetId !== null) {
                this.#app.requireSee(user, targetId);
            }
        }

        if (operation === "configuration" && !this.#configurations.get(id)?.requests[key]) {
            targetId = null;
        }

        const receipt =
            targetId === null ? undefined : this.executions.journal.request(String(targetId), key);

        if (
            receipt &&
            receipt.operation !==
                (operation === "submit"
                    ? "prompt"
                    : operation === "configuration"
                      ? "handoff"
                      : operation)
        ) {
            throw new HttpError(409, "Request belongs to another operation.");
        }

        const preparedOnly =
            ["fork", "configuration"].includes(operation) &&
            targetId !== null &&
            !receipt &&
            !this.#operations.has(JSON.stringify([id, key]));

        return {
            targetId,
            receipt: receipt ? this.#receipt(receipt) : null,
            ...(preparedOnly ? { preparedOnly: true } : {}),
        };
    }

    async #configure(id: ConversationId, user: User, requestId: string, expectedHead: string) {
        const key = this.#request(id, user, requestId, true, "configuration");

        if (typeof expectedHead !== "string" || !expectedHead || expectedHead.length > 128) {
            throw new HttpError(400, "The observed segmentId is required.");
        }

        const app = this.#app;

        return app.execution.exclusive(id, async () => {
            const prior = this.#configurations.get(id)?.requests[key];

            if (prior) {
                if (prior.expectedHead !== expectedHead) {
                    throw new HttpError(409, "Configuration request identity changed.");
                }

                const receipt = this.executions.journal.request(String(id), key);

                return { receipt: receipt ? this.#receipt(receipt) : null };
            }

            const journal = this.executions.journal;
            const source = journal.session(String(id));

            if (journal.request(String(id), key)) {
                throw new HttpError(409, "Request belongs to another operation.");
            }

            if (source.binding.memberId !== user.id) {
                throw new HttpError(
                    403,
                    "Take over with your own account before activating a profile.",
                );
            }

            if (source.segmentId !== expectedHead || journal.pendingConversation(String(id))) {
                throw new HttpError(
                    409,
                    "Source changed or is active/unknown; reconcile before activation.",
                );
            }

            const current = app.config.userById(user.id);

            if (!current) {
                throw new HttpError(403, "Membership ended.");
            }

            app.requireSee(current, id);
            await app.requireDriver(id, current, "rotom");
            const captured = app.profiles.capture(
                current,
                source.binding.workspace,
                app.settings.getSkillPaths(),
            );
            const initial = app.profiles.snapshot(id);
            const snapshot =
                this.#configurations.get(id)?.snapshots[captured.digest] ??
                (initial?.digest === captured.digest ? initial : captured);
            const binding = { ...source.binding, configurationDigest: snapshot.digest };

            await this.#check(binding, id, snapshot);
            await app.harness.commit(async (tx) => {
                const configurations = await tx.doc(NativeConfigurationsDoc, id);

                configurations.snapshots[snapshot.digest] ??= snapshot;
                configurations.requests[key] = { expectedHead, binding };
            }, BACKGROUND_CONTEXT);
            this.#configurations.set(
                id,
                (await app.harness.snapshot(NativeConfigurationsDoc, id, BACKGROUND_CONTEXT))!,
            );
            // A recorded plan is never automatically retried, even if a crash preceded the journal intent.
            const receipt = await this.#track(
                id,
                binding,
                this.executions.handoff(String(id), key, expectedHead, binding),
            );

            return { receipt };
        });
    }

    async #compact(id: ConversationId, user: User, requestId: string, instructions: string) {
        const key = this.#request(id, user, requestId);

        if (typeof instructions !== "string") {
            throw new HttpError(400, "Compaction instructions must be text.");
        }

        const previous = this.executions.journal.existing(String(id), key, instructions, "compact");

        if (previous) {
            return this.#receipt(previous);
        }

        const binding = this.executions.journal.session(String(id)).binding;

        if (binding.memberId !== user.id) {
            throw new HttpError(403, "Take over with your own account before compacting.");
        }

        return this.#track(id, binding, this.executions.compact(String(id), key, instructions));
    }

    async #fork(id: ConversationId, user: User, requestId: string, expectedHead: string) {
        const key = this.#request(id, user, requestId);

        if (typeof expectedHead !== "string" || !expectedHead) {
            throw new HttpError(400, "The observed source head is required.");
        }

        const app = this.#app;

        return app.execution.exclusive(id, async () => {
            const current = app.config.userById(user.id);

            if (!current) {
                throw new HttpError(403, "Membership ended.");
            }

            app.commands.requireForkable(id, current, "rotom");
            const prior = (await app.harness.snapshot(NativeForksDoc, id, BACKGROUND_CONTEXT))
                ?.items[key];

            if (prior) {
                if (prior.expectedHead !== expectedHead) {
                    throw new HttpError(409, "Fork request identity changed.");
                }

                app.requireSee(current, prior.id);
                const receipt = this.executions.journal.request(String(prior.id), key);

                return { id: prior.id, receipt: receipt ? this.#receipt(receipt) : null };
            }

            const journal = this.executions.journal;

            if (
                journal.session(String(id)).segmentId !== expectedHead ||
                journal.pendingConversation(String(id))
            ) {
                throw new HttpError(
                    409,
                    "Source changed or has an active/unknown operation; refresh and reconcile before fork.",
                );
            }

            const meta = app.sessionMeta(id)!;
            const target = await app.commands.createSession(
                current,
                { backend: "rotom", cwd: meta.cwd, title: `${meta.title ?? "New session"} · Fork` },
                { sourceId: id, requestId: key, expectedHead },
            );
            const binding = journal.session(String(target.id)).binding;
            const receipt = await this.#track(
                target.id,
                binding,
                this.executions.fork(String(id), String(target.id), key, expectedHead),
            );

            if (receipt.status === "settled") {
                this.#ready.add(target.id);
            }

            app.kernelChanged();

            return { id: target.id, receipt };
        });
    }

    async #handoff(id: ConversationId, user: User, requestId: string, expectedHead: string) {
        const key = this.#request(id, user, requestId);

        if (typeof expectedHead !== "string" || !expectedHead || expectedHead.length > 128) {
            throw new HttpError(400, "The observed segmentId is required.");
        }

        const journal = this.executions.journal;
        const previous = journal.request(String(id), key);

        if (previous) {
            journal.existing(
                String(id),
                key,
                JSON.stringify({ expectedHead, binding: previous.binding }),
                "handoff",
            );

            return this.#receipt(previous);
        }

        this.#app.requireSteer(user);
        const source = journal.session(String(id));

        if (source.segmentId !== expectedHead) {
            throw new HttpError(409, "Conversation head changed; refresh before handoff.");
        }

        if (journal.pendingConversation(String(id))) {
            throw new HttpError(
                409,
                "A native operation is active or unknown; reconcile it before handoff.",
            );
        }

        await this.#app.requireDriver(id, user, "rotom");
        await this.#app.execution.accountIdle(user);
        await this.#app.accounts.forUser(user);
        const { model: choice, thinkingLevel } = this.#app.commands.defaultModel(user);

        if (!choice) {
            throw new HttpError(409, "Choose a model from your own connected account first.");
        }

        const model = this.#app.accounts.kernelModel(user, choice);
        const home = join(this.#app.dataDir, "kernel-homes", user.id);

        mkdirSync(home, { recursive: true, mode: 0o700 });
        const binding: KernelBinding = {
            ...source.binding,
            memberId: user.id,
            home,
            accountGeneration: choice.provider,
            provider: model.provider,
            model: model.id,
            thinkingLevel,
        };

        return this.#track(
            id,
            binding,
            this.executions.handoff(String(id), key, expectedHead, binding),
        );
    }

    #receipt(receipt: KernelReceipt) {
        const configuration = this.#configurations.get(this.#id(receipt.sessionId))?.requests[
            receipt.requestId
        ];

        if (configuration) {
            if (
                Object.entries(receipt.binding).some(
                    ([key, value]) => configuration.binding[key as keyof KernelBinding] !== value,
                )
            ) {
                throw new HttpError(409, "Configuration receipt binding changed.");
            }

            this.executions.journal.existing(
                receipt.sessionId,
                receipt.requestId,
                JSON.stringify({
                    expectedHead: configuration.expectedHead,
                    binding: receipt.binding,
                }),
                "handoff",
            );
        }

        return {
            id: receipt.id,
            requestId: receipt.requestId,
            status: receipt.status,
            operation: configuration ? "configuration" : receipt.operation,
        };
    }

    async #track(id: ConversationId, binding: KernelBinding, promise: Promise<KernelReceipt>) {
        const run = { id, binding, promise };

        this.#active.add(run);
        this.#app.kernelChanged();

        try {
            const receipt = await run.promise;

            return this.#receipt(receipt);
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
        for (const { id, binding } of this.#active) {
            try {
                await this.#check(binding, id);
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
