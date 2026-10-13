/** Opt-in application boundary: team authorizes and owns credentials; pinned rotom alone executes new native conversations. */
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
    defineDoc,
    type ConversationId,
    type LiveState,
    type ModelRef,
} from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import type { ConfigurationSnapshot } from "./team-profiles.ts";
import { accountContext } from "./team-accounts.ts";
import { HttpError } from "./errors.ts";
import {
    isTeamPrompt,
    nativePromptIdentity,
    NativeTail,
    RotomExecutions,
    type RunHooks,
} from "./rotom-executions.ts";
import { attachmentImages, attachmentText } from "./attachments.ts";
import type { Attachment } from "./commands.ts";
import { childrenReport, type RpcRecord } from "./rotom-rpc.ts";
import { AuthorsDoc } from "./docs.ts";
import { THINKING_LEVELS } from "./commands.ts";
import { NATIVE_ENTRY, RESUME_PREFIX } from "./entry-format.ts";
import { projectLive, type ClientLive } from "./projection.ts";
import type { KernelBinding, KernelEntry, KernelReceipt } from "./rotom-journal.ts";
import { projectSkillPaths, verifyRotomKernel } from "./rotom-kernel.ts";
import { loadSkillCommands, type SkillCommand } from "./prompts.ts";
import { McpSignIns } from "./mcp-sign-in.ts";
import { touchSession } from "./titles.ts";

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

/** How many journal entries (in `journal.entries` order) are mirrored into the conversation for display. */
export const NativeMirrorDoc = defineDoc<{ count: number }>({
    kind: "rotom-team.native-mirror",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ count: 0 }),
});

/** What a running kernel shows before its messages are persisted. Provisional: never billed, never replayed. */
type NativeLive = {
    generation?: { message: { content: Record<string, unknown>[] }; ended: boolean };
    retry?: { at: number; error: string };
    tools: { callId: string; name: string; status: "running"; output?: string }[];
    compacting?: string;
    /** Extension dialogs waiting for the paying member, oldest first. */
    dialogs?: NativeDialog[];
    /** Background subagents whose results the run still waits for. */
    subagents?: number;
};
/** A dialog a rotom extension opened during a run, such as ask_user_question's choices. */
export type NativeDialog = {
    id: string;
    method: "select" | "confirm" | "input" | "editor";
    title: string;
    message?: string;
    options?: string[];
    placeholder?: string;
    prefill?: string;
};
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

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

/**
 * The configuration of a session that has no frozen snapshot: rotom loads the project's AGENTS.md and skills from the
 * workspace and the paying member's own from their private HOME, each run. A legacy session keeps its snapshot digest.
 */
export const NATIVE_LAYERS = "native-layers-v1";

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
    readonly #live = new Map<ConversationId, NativeLive>();
    readonly #mcp = new McpSignIns();
    readonly #mirrors = new Map<ConversationId, Promise<void>>();
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
                const layered = binding.configurationDigest === NATIVE_LAYERS;
                const snapshot = layered ? undefined : this.#snapshot(binding, this.#id(sessionId));

                if (!layered && (!snapshot || snapshot.digest !== binding.configurationDigest)) {
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
                    ...(snapshot && {
                        frozen: {
                            context: snapshot.context,
                            skills: snapshot.skills.map((skill) => skill.path),
                        },
                    }),
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
        if (binding.configurationDigest === NATIVE_LAYERS) {
            return undefined;
        }

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

        if (
            (staged || binding.configurationDigest !== NATIVE_LAYERS) &&
            (!configuration || configuration.digest !== binding.configurationDigest)
        ) {
            throw new HttpError(409, "Frozen configuration changed.");
        }

        return user;
    }

    binding(user: User, cwd: string, ref: ModelRef, thinkingLevel: string): KernelBinding {
        const model = this.#app.accounts.kernelModel(user, ref);
        const home = this.#home(user.id);

        return {
            memberId: user.id,
            kernelVersion: verifyRotomKernel().version,
            accountGeneration: ref.provider,
            provider: model.provider,
            model: model.id,
            thinkingLevel,
            configurationDigest: NATIVE_LAYERS,
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
        this.#interruptDeadRuns();

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
            // Catch the display up with the journal: entries of runs that ended while the mirror was behind.
            await this.mirror(id);
        }
    }

    /** Account changes wait for every run of the member; starting runs in other sessions does not. */
    requireAccountIdle(user: User): void {
        const pending = this.executions.journal.pending(user.id);

        if (pending) {
            throw new HttpError(
                409,
                `Your account is still running in session ${pending.sessionId}, or its outcome there is unknown. Wait for it to finish or stop it first.`,
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

    /** `wait: false` answers once the intent is durably reserved; the run continues and shows in the room. */
    submit(
        id: ConversationId,
        user: User,
        requestId: string,
        text: string,
        wait = true,
        attachments: Attachment[] = [],
    ) {
        return this.#operation(id, user, requestId, "submit", { text, attachments }, () =>
            this.#submit(id, user, requestId, text, wait, attachments),
        );
    }
    /**
     * A message sent while a prompt runs joins that run (steer) or waits for its turn (followUp). The run is paid by
     * its member, so only they may add to it; anyone else waits for it to end, then their message takes it over.
     */
    async queue(
        id: ConversationId,
        user: User,
        text: string,
        mode: "steer" | "followUp",
        attachments: Attachment[] = [],
    ) {
        if (typeof text !== "string" || !isTeamPrompt(attachmentText(text, attachments))) {
            throw new HttpError(
                400,
                "Rotom sessions take ordinary text or /skill:name; other slash commands are not supported.",
            );
        }

        if (text.length > 100_000) {
            throw new HttpError(400, "That message is too long.");
        }

        this.#app.requireSteer(user);
        this.#app.requireSee(user, id);
        const { binding } = this.executions.journal.session(String(id));

        if (binding.memberId !== user.id) {
            const name = this.#app.config.userById(binding.memberId)?.name ?? "Another member";

            throw new HttpError(
                409,
                `${name}'s run is working on their account. Send when it ends, and it continues on yours.`,
            );
        }

        const model = this.#app.accounts.kernelModel(user, this.#ref(binding));
        const images = await attachmentImages(attachments, model.input.includes("image"));

        if (
            !(await this.executions.queue(
                String(id),
                attachmentText(text, attachments),
                mode,
                images,
            ))
        ) {
            throw new HttpError(
                409,
                "Pi is not running a prompt now (it finished, or is compacting). Send again.",
            );
        }

        return { queued: mode };
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

    async #submit(
        id: ConversationId,
        user: User,
        requestId: string,
        text: string,
        wait: boolean,
        attachments: Attachment[],
    ) {
        const key = this.#request(id, user, requestId);

        this.#app.requireSteer(user);

        if (
            typeof requestId !== "string" ||
            !requestId ||
            `${user.id}:${requestId}`.length > 128 ||
            typeof text !== "string"
        ) {
            throw new HttpError(400, "A stable requestId and text are required.");
        }

        const prompt = attachmentText(text, attachments);

        if (!isTeamPrompt(prompt)) {
            throw new HttpError(
                400,
                "Rotom sessions take ordinary text or /skill:name; other slash commands are not supported.",
            );
        }

        // Identity readback must not need a still-connected account or today's model capabilities.
        const images = await attachmentImages(attachments, true);
        const identity = nativePromptIdentity(prompt, images);
        const previous = this.executions.journal.existing(String(id), key, identity);

        if (previous) {
            return this.#receipt(previous);
        }

        if (this.isRunning(id)) {
            throw new HttpError(409, "Pi is working. Wait for it to finish or Stop it first.");
        }

        const journal = this.executions.journal;
        const source = journal.session(String(id));

        if (images.length > 0) {
            await this.#app.accounts.forUser(user);
            const ref =
                source.binding.memberId === user.id
                    ? this.#ref(source.binding)
                    : this.#app.commands.defaultModel(user).model;

            if (!ref) {
                throw new HttpError(409, "Connect your own account and choose a model first.");
            }

            if (!this.#app.accounts.kernelModel(user, ref).input.includes("image")) {
                throw new HttpError(
                    400,
                    "This model does not accept images. Choose an image-capable model.",
                );
            }
        }

        // Whoever sends pays: take over with the sender's own account, on the pinned kernel, before running.
        if (
            source.binding.memberId !== user.id ||
            source.binding.kernelVersion !== verifyRotomKernel().version
        ) {
            const takeover = await this.#handoff(
                id,
                user,
                `${requestId}:takeover`,
                source.segmentId,
            );

            if (takeover.status !== "settled") {
                throw new HttpError(
                    409,
                    `Taking over with your own account ended ${takeover.status}; the message was not sent.`,
                );
            }
        }

        const binding = journal.session(String(id)).binding;

        if (binding.memberId !== user.id) {
            throw new HttpError(409, "Another member took over first; refresh and send again.");
        }

        let reserved!: (receipt: KernelReceipt) => void;
        let wasReserved = false;
        const admitted = new Promise<KernelReceipt>((resolve) => {
            reserved = (receipt) => {
                wasReserved = true;
                resolve(receipt);
            };
        });
        const run = this.#track(
            id,
            binding,
            this.executions.run(
                String(id),
                key,
                prompt,
                this.#hooks(id, async (receipt) => {
                    if (!requestId.startsWith("#resume-")) {
                        try {
                            await touchSession(this.#app, id, text);
                        } catch (error) {
                            this.#app.notice(
                                "warning",
                                `The session name could not be saved: ${error}`,
                                id,
                            );
                        }
                    }

                    reserved(receipt);
                }),
                images,
            ),
        );

        if (wait) {
            return run;
        }

        // After reservation every outcome is journaled and shown in the room; only a lost child is reported here.
        // A refusal before reservation never ran: the race below returns it to the sender.
        run.catch((error) => {
            if (wasReserved) {
                this.#app.notice("warning", `Native run ended without a proven outcome: ${error}`);
            }
        });

        return Promise.race([run, admitted.then((receipt) => this.#receipt(receipt))]);
    }

    /**
     * Choosing a model in a native session takes it over on the chooser's account with that model: a new segment with
     * public history, as any change of payer. The choice is also remembered as the person's default.
     */
    async chooseModel(id: ConversationId, user: User, body: unknown) {
        const request = body as {
            model?: { provider?: unknown; modelId?: unknown };
            thinkingLevel?: unknown;
        } | null;

        if (
            !request ||
            typeof request !== "object" ||
            Object.keys(request).length === 0 ||
            Object.keys(request).some((key) => key !== "model" && key !== "thinkingLevel") ||
            (request.model !== undefined &&
                (typeof request.model?.provider !== "string" ||
                    typeof request.model.modelId !== "string")) ||
            (request.thinkingLevel !== undefined &&
                !THINKING_LEVELS.has(String(request.thinkingLevel)))
        ) {
            throw new HttpError(
                400,
                "A rotom session changes only its model {provider, modelId} and thinkingLevel; its folder is fixed.",
            );
        }

        this.#app.requireSteer(user);
        await this.#app.accounts.forUser(user);
        const previous = this.#app.accounts.choice(user);
        const ref = request.model
            ? { provider: String(request.model.provider), modelId: String(request.model.modelId) }
            : (previous ?? this.#app.commands.defaultModel(user).model);

        if (!ref) {
            throw new HttpError(409, "Connect your own account and choose a model first.");
        }

        this.#app.accounts.choose(user, {
            ...ref,
            thinkingLevel: String(request.thinkingLevel ?? previous?.thinkingLevel ?? "off"),
        });
        const chosen = this.#app.commands.defaultModel(user);
        const { binding, segmentId } = this.executions.journal.session(String(id));

        if (
            binding.memberId === user.id &&
            binding.accountGeneration === chosen.model?.provider &&
            binding.model === chosen.model.modelId &&
            (binding.thinkingLevel ?? "off") === (chosen.thinkingLevel ?? "off")
        ) {
            return { receipt: null };
        }

        if (this.isRunning(id)) {
            throw new HttpError(409, "Pi is working. Stop it or wait before switching the model.");
        }

        return { receipt: await this.handoff(id, user, `model-${randomUUID()}`, segmentId) };
    }

    #hooks(
        id: ConversationId,
        onReserved?: (receipt: KernelReceipt) => void | Promise<void>,
    ): RunHooks {
        return {
            ...(onReserved ? { onReserved } : {}),
            onEvent: (event) => this.#observe(id, event),
            // A failed mirror is already a notice, and the run's end mirrors again.
            onProgress: () => void this.mirror(id).catch(() => undefined),
        };
    }

    /** Fold one kernel event into the provisional live view of the conversation. */
    #observe(id: ConversationId, event: RpcRecord): void {
        const live = this.#live.get(id) ?? { tools: [] };
        const message = event.message as { role?: unknown } | undefined;

        this.#live.set(id, live);

        switch (event.type) {
            case "message_start":
                if (message?.role !== "assistant") {
                    return;
                }

                live.generation = { message: { ...message, content: [] }, ended: false };
                break;

            case "message_update":
                if (!live.generation || !applyUpdate(live.generation.message, event)) {
                    return;
                }

                break;

            case "message_end":
                if (message?.role !== "assistant" || !live.generation) {
                    return;
                }

                // Shown until its persisted copy is mirrored, so the message never blinks out.
                live.generation.ended = true;
                break;

            case "tool_execution_start":
                live.tools.push({
                    callId: String(event.toolCallId),
                    name: String(event.toolName),
                    status: "running",
                });
                break;

            case "tool_execution_update": {
                const slot = live.tools.find((each) => each.callId === String(event.toolCallId));
                const content = (event.partialResult as { content?: unknown } | undefined)?.content;

                if (!slot || !Array.isArray(content)) {
                    return;
                }

                slot.output = content
                    .flatMap((part: { type?: unknown; text?: unknown }) =>
                        part.type === "text" && typeof part.text === "string" ? [part.text] : [],
                    )
                    .join("\n");
                break;
            }

            case "tool_execution_end":
                live.tools = live.tools.filter((each) => each.callId !== String(event.toolCallId));
                break;

            case "auto_retry_start":
                live.retry = {
                    at: Date.now() + Number(event.delayMs ?? 0),
                    error: String(event.errorMessage ?? "Retrying"),
                };
                break;

            case "auto_retry_end":
                delete live.retry;
                break;

            case "auto_compaction_start":
                live.compacting = String(event.reason ?? "threshold");
                break;

            case "auto_compaction_end":
                delete live.compacting;
                break;

            case "extension_ui_request": {
                const subagents = childrenReport(event);

                if (subagents !== undefined) {
                    live.subagents = subagents;
                    break;
                }

                // Status lines, widgets and toasts are for a terminal; only dialogs need a person.
                if (!DIALOG_METHODS.has(String(event.method))) {
                    return;
                }

                const text = (value: unknown) =>
                    typeof value === "string" ? value.slice(0, 16_000) : undefined;

                live.dialogs = [
                    ...(live.dialogs ?? []),
                    {
                        id: String(event.id),
                        method: event.method as NativeDialog["method"],
                        title: text(event.title) ?? "",
                        ...(text(event.message) !== undefined && { message: text(event.message) }),
                        ...(Array.isArray(event.options) && {
                            options: event.options.slice(0, 64).map((each) => String(each)),
                        }),
                        ...(text(event.placeholder) !== undefined && {
                            placeholder: text(event.placeholder),
                        }),
                        ...(text(event.prefill) !== undefined && { prefill: text(event.prefill) }),
                    },
                ];
                break;
            }

            default:
                return;
        }

        this.#app.roomChanged(id);
    }

    /**
     * Answer a dialog of the running prompt. Only the member it runs for may: the run spends their account and
     * acts with their authority. A dialog that is gone (answered, or its run ended) is a 409, never a resend.
     */
    answerDialog(id: ConversationId, user: User, body: unknown): { answered: true } {
        const request = body as {
            id?: unknown;
            value?: unknown;
            confirmed?: unknown;
            cancelled?: unknown;
        } | null;
        const dialog = this.#live
            .get(id)
            ?.dialogs?.find((each) => typeof request?.id === "string" && each.id === request.id);

        if (!request || typeof request !== "object" || typeof request.id !== "string") {
            throw new HttpError(400, "A dialog id is required.");
        }

        this.#app.requireSteer(user);

        if (this.executions.journal.session(String(id)).binding.memberId !== user.id) {
            throw new HttpError(403, "Only the member this run is for can answer its questions.");
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

        const live = this.#live.get(id)!;

        live.dialogs = live.dialogs!.filter((each) => each.id !== dialog.id);

        if (!this.executions.answer(String(id), dialog.id, response)) {
            this.#app.roomChanged(id);

            throw new HttpError(409, "That question is no longer waiting.");
        }

        this.#app.roomChanged(id);

        return { answered: true };
    }

    /** The room's agent line for a native conversation: what the current segment runs on, and for whom. */
    agentInfo(id: ConversationId) {
        const cwd = this.#app.sessionMeta(id)?.cwd ?? this.#app.defaultCwd;

        if (!this.executions.journal.hasConversation(String(id))) {
            return { model: null, thinkingLevel: "off", cwd, available: false };
        }

        const { binding } = this.executions.journal.session(String(id));

        return {
            model: { provider: binding.accountGeneration, modelId: binding.model },
            modelName: binding.model,
            accountName: this.#app.config.userById(binding.memberId)?.name ?? "A former member",
            personalAccount: true,
            thinkingLevel: binding.thinkingLevel ?? "off",
            cwd: binding.workspace,
            available: true,
        };
    }

    /**
     * The project's MCP servers as this member's runs reach them, and sign-in to those that use OAuth. A sign-in is the
     * member's own: only their runs send its tokens. Reporting starts the project's command servers, as a run does, so
     * it takes the right to run Pi in the project.
     */
    async mcp(id: ConversationId, user: User, action: string, body?: unknown) {
        const current = this.#app.config.userById(user.id);

        if (!current) {
            throw new HttpError(403, "Membership ended.");
        }

        this.#app.requireSee(current, id);
        this.#app.requireSteer(current);
        this.#app.projects.require(
            current,
            this.#app.sessionMeta(this.#app.rootOf(id))?.projectId,
            "continue",
        );

        if (!this.executions.journal.hasConversation(String(id))) {
            throw new HttpError(409, "This session is still starting.");
        }

        const { workspace } = this.executions.journal.session(String(id)).binding;
        const home = this.#home(current.id);
        const key = JSON.stringify([current.id, workspace]);
        const request = (body ?? {}) as { server?: unknown; url?: unknown };

        switch (action) {
            case "list":
                return this.#mcp.list(home, workspace);
            case "login":
                return this.#mcp.start(key, home, workspace, request.server);
            case "finish":
                return this.#mcp.finish(key, request.url);
            case "logout":
                return this.#mcp.logout(home, workspace, request.server);
            default:
                throw new HttpError(404, "Unknown MCP action.");
        }
    }

    /**
     * The skills to suggest as `/skill:name`: a frozen configuration's, or the project's as this member's runs find
     * them. Suggestions only: the kernel expands the command itself, with its bundled skills too.
     */
    skillCommands(id: ConversationId, user: User): SkillCommand[] {
        this.#app.requireSee(user, id);

        if (!this.executions.journal.hasConversation(String(id))) {
            throw new HttpError(409, "This session is still starting.");
        }

        const snapshot = this.configuration(id);

        if (snapshot) {
            return snapshot.skills;
        }

        const { workspace } = this.executions.journal.session(String(id)).binding;

        return loadSkillCommands(
            workspace,
            join(this.#home(user.id), ".pi/agent"),
            projectSkillPaths(workspace),
        );
    }

    /** What the web app needs to drive a native conversation: the head it acts on, and who pays for it. */
    roomState(id: ConversationId, viewer: User) {
        const journal = this.executions.journal;

        if (!journal.hasConversation(String(id))) {
            return { initializing: true };
        }

        const { binding, segmentId } = journal.session(String(id));
        const pending = journal.pendingConversation(String(id));

        return {
            initializing: !this.#ready.has(id),
            segmentId,
            memberId: binding.memberId,
            memberName: this.#app.config.userById(binding.memberId)?.name ?? "A former member",
            provider: binding.provider,
            model: binding.model,
            thinkingLevel: binding.thinkingLevel ?? "off",
            kernelVersion: binding.kernelVersion,
            yours: binding.memberId === viewer.id,
            dialogs: this.#live.get(id)?.dialogs ?? [],
            subagents: this.#live.get(id)?.subagents ?? 0,
            ...(this.#cutOff(id) ? { cutOff: true } : {}),
            ...(pending
                ? {
                      pending: {
                          id: pending.id,
                          status: pending.status,
                          operation: pending.operation,
                          memberId: pending.binding.memberId,
                      },
                  }
                : {}),
        };
    }

    /** The last run was cut off by a server stop and did not continue by itself: a person may say Continue. */
    #cutOff(id: ConversationId): boolean {
        const journal = this.executions.journal;
        const latest = journal.latest(String(id));

        if (!latest || this.isRunning(id)) {
            return false;
        }

        const plan = journal.resume(latest.id);

        return latest.status === "interrupted"
            ? plan?.state !== "pending" && plan?.state !== "started"
            : plan?.state === "capped" || plan?.state === "skipped";
    }

    /** The live view of a native conversation for the Transcript; `busy` while any native operation runs. */
    clientLive(id: ConversationId): ClientLive {
        const live = this.#live.get(id);

        if (!this.isRunning(id)) {
            return { busy: false };
        }

        return projectLive({
            run: { taskId: 0, inputs: [] },
            ...(live?.generation || live?.retry
                ? {
                      generation: {
                          attempt: 1,
                          // Unshown parts (reasoning) leave holes in the streamed content.
                          ...(live.generation
                              ? {
                                    message: {
                                        ...live.generation.message,
                                        content: live.generation.message.content.filter(Boolean),
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
    }

    /** Copy newly journaled entries into the conversation for display, once each, in journal order. */
    mirror(id: ConversationId): Promise<void> {
        const next = (this.#mirrors.get(id) ?? Promise.resolve()).then(() => this.#mirrorNow(id));

        this.#mirrors.set(
            id,
            next.catch((error) =>
                this.#app.notice("warning", `Native transcript mirror failed: ${error}`),
            ),
        );

        return next;
    }

    async #mirrorNow(id: ConversationId): Promise<void> {
        const app = this.#app;
        const rows = this.executions.journal.entries(String(id));
        const mirrored = (await app.harness.snapshot(NativeMirrorDoc, id, BACKGROUND_CONTEXT))
            ?.count;

        if (rows.length > (mirrored ?? 0)) {
            await app.harness.commit(async (tx) => {
                const doc = await tx.doc(NativeMirrorDoc, id);
                const authors = await tx.doc(AuthorsDoc, id);

                for (const row of rows.slice(doc.count)) {
                    const record = await tx.appendEntry(id, {
                        kind: NATIVE_ENTRY,
                        data: { entry: publicEntry(row.entry) } as unknown as JsonValue,
                    });
                    const message = row.entry.message as { role?: unknown } | undefined;

                    // A person's own prompt; inherited fork history and automatic continuations have no author.
                    if (
                        row.operation === "prompt" &&
                        !row.requestId.includes("#resume") &&
                        row.entry.type === "message" &&
                        message?.role === "user"
                    ) {
                        authors.entries[String(record.id)] = row.memberId;
                    }
                }

                doc.count = rows.length;
            }, BACKGROUND_CONTEXT);
        }

        const live = this.#live.get(id);

        if (live?.generation?.ended) {
            delete live.generation;
            app.roomChanged(id);
        }
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
            kernelVersion: verifyRotomKernel().version,
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

        let finished = false;

        try {
            const receipt = await run.promise;

            await this.mirror(id);
            finished =
                receipt.operation === "prompt" &&
                ["settled", "interrupted"].includes(receipt.status);

            return this.#receipt(receipt);
        } finally {
            this.#active.delete(run);

            if (!this.isRunning(id)) {
                this.#live.delete(id);
            }

            if (finished) {
                await this.#app.recordRunFinished(id);
            }

            this.#app.kernelChanged();
            this.#app.roomChanged(id);
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

    /**
     * After a crash, an unknown prompt whose kernel process no longer exists is over: what its session file holds is
     * what it did. It becomes interrupted, which releases its account, and is planned to continue. A run whose process
     * still lives, or that recorded none, stays unknown for a person to reconcile.
     */
    #interruptDeadRuns(): void {
        const journal = this.executions.journal;

        for (const attempt of journal.unknownPrompts()) {
            if (processAlive(attempt.pid)) {
                continue;
            }

            const { binding } = journal.receipt(attempt.id);

            try {
                const entries = new NativeTail(
                    attempt.sessionFile,
                    attempt.kernelSessionId,
                    binding.workspace,
                ).read();

                journal.interrupt(attempt.id, entries);
                journal.planResume(attempt.id);
            } catch (error) {
                this.#app.notice(
                    "warning",
                    `A rotom run cut off by a crash stays unknown: its session file did not read back (${error}).`,
                );
            }
        }
    }

    /**
     * Continue prompts a server stop cut off, once each: as the member they ran for, under the usual checks, with a
     * message that tells Pi what happened. The request id is derived from the cut-off attempt, so a second startup
     * finds the first continuation instead of sending another.
     */
    async resumeInterrupted(): Promise<void> {
        const journal = this.executions.journal;

        for (const plan of journal.resumes("pending")) {
            const id = this.#id(plan.sessionId);
            const attempt = journal.receipt(plan.attemptId);
            const { binding } = journal.session(plan.sessionId);
            const user = this.#app.config.userById(binding.memberId);

            // Someone acted since (a new message, a handoff, a fork seed): their choice stands.
            if (journal.latest(plan.sessionId)?.id !== attempt.id || !user) {
                journal.markResume(plan.attemptId, "skipped");
                continue;
            }

            try {
                await this.#app.accounts.forUser(user);
                await this.submit(id, user, `#resume-${attempt.id}`, RESUME_TEXT, false);
                journal.markResume(plan.attemptId, "started");
            } catch (error) {
                journal.markResume(plan.attemptId, "skipped");
                this.#app.notice(
                    "warning",
                    `A rotom run cut off by a server restart did not continue by itself: ${error}`,
                );
            }

            this.#app.roomChanged(id);
        }
    }

    async close(): Promise<void> {
        this.#closing = true;
        this.#mcp.close();

        // A stop cuts prompts off mid-work: plan their continuation before stopping them.
        for (const id of new Set([...this.#active].map((run) => run.id))) {
            const pending = this.executions.journal.pendingConversation(String(id));

            if (pending?.operation === "prompt") {
                this.executions.journal.planResume(pending.id);
            }
        }

        for (const id of new Set([...this.#active].map((run) => run.id))) {
            await this.executions.abort(String(id));
        }

        await Promise.allSettled([...this.#active].map((run) => run.promise));
        this.executions.close();
    }
}

/** What a continuation after a server stop tells Pi. It shows in the transcript as the server's note. */
const RESUME_TEXT = `${RESUME_PREFIX} The server restarted while you were working, and your last step may have been cut off. Check what was already done, then continue the task from where it stopped. Do not repeat finished steps.`;

function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);

        return true;
    } catch (error) {
        // EPERM: the process exists but belongs to someone else.
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

/**
 * What everyone in the room may see of a native entry: an answer's text and tool calls, without reasoning or provider
 * signatures, as handoff does. The complete entry stays in the kernel journal.
 */
function publicEntry(entry: KernelEntry): KernelEntry {
    const message = entry.message as
        { role?: unknown; content?: { type?: unknown; [key: string]: unknown }[] } | undefined;

    if (
        entry.type !== "message" ||
        message?.role !== "assistant" ||
        !Array.isArray(message.content)
    ) {
        return entry;
    }

    return {
        ...entry,
        message: {
            ...message,
            content: message.content.flatMap((part): Record<string, unknown>[] =>
                part.type === "text"
                    ? [{ type: "text", text: part.text }]
                    : part.type === "toolCall"
                      ? [
                            {
                                type: "toolCall",
                                id: part.id,
                                name: part.name,
                                arguments: part.arguments,
                            },
                        ]
                      : [],
            ),
        },
    };
}

/**
 * Apply one streamed delta to the in-flight answer. Rotom's RPC sends deltas, not the whole partial message. Reasoning
 * is not shown live, as it is not shown once persisted. Returns whether anything visible changed.
 */
function applyUpdate(message: { content: Record<string, unknown>[] }, event: RpcRecord): boolean {
    const update = event.assistantMessageEvent as
        | {
              type?: string;
              contentIndex?: number;
              delta?: string;
              content?: string;
              id?: string;
              toolName?: string;
              toolCall?: Record<string, unknown>;
          }
        | undefined;
    const index = update?.contentIndex;

    if (!update || typeof index !== "number" || !Number.isInteger(index) || index < 0) {
        return false;
    }

    const content = message.content;
    const text = typeof content[index]?.text === "string" ? (content[index].text as string) : "";

    switch (update.type) {
        case "text_start":
            content[index] = { type: "text", text: "" };

            return true;

        case "text_delta":
            content[index] = { type: "text", text: text + String(update.delta ?? "") };

            return true;

        case "text_end":
            content[index] = { type: "text", text: String(update.content ?? text) };

            return true;

        case "toolcall_start":
            content[index] = {
                type: "toolCall",
                id: String(update.id ?? ""),
                name: String(update.toolName ?? ""),
                arguments: {},
            };

            return true;

        case "toolcall_end":
            if (!update.toolCall) {
                return false;
            }

            content[index] = update.toolCall;

            return true;

        default:
            return false;
    }
}
