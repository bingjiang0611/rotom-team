/** Opt-in application boundary: team authorizes and owns credentials; pinned rotom alone executes new native conversations. */
import { safeConfigurationPath } from "./rotom-resource-policy.ts";
import { teamResourceRevision } from "./rotom-resources.ts";
import { createHash, randomUUID } from "node:crypto";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
    defineDoc,
    type ConversationId,
    type LiveState,
    type ModelRef,
} from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    clampThinkingLevel,
    getSupportedThinkingLevels,
    type ModelThinkingLevel,
    type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import type { ConfigurationSnapshot } from "./team-profiles.ts";
import { accountContext } from "./team-accounts.ts";
import { HttpError } from "./errors.ts";
import {
    isTeamPrompt,
    currentBranchGoalState,
    nativePromptIdentity,
    nativePromptOperation,
    nativeCommandName,
    nativeCommandArgs,
    normalizeNativePrompt,
    RotomExecutions,
    type RunHooks,
} from "./rotom-executions.ts";
import { attachmentImages, attachmentText } from "./attachments.ts";
import type { Attachment } from "./commands.ts";
import { childrenReport, RpcFailure, type RpcRecord } from "./rotom-rpc.ts";
import { AuthorsDoc, SessionsDoc } from "./docs.ts";
import { THINKING_LEVELS } from "./commands.ts";
import { NATIVE_ENTRY, RESUME_PREFIX } from "./entry-format.ts";
import { projectLive, type ClientLive } from "./projection.ts";
import {
    KernelRequestConflict,
    type KernelBinding,
    type KernelEntry,
    type KernelReceipt,
} from "./rotom-journal.ts";
import {
    nativeBuiltinCommands,
    nativeConfigurationApi,
    nativeSessionManager,
    nativeSessionExports,
    verifyRotomKernel,
} from "./rotom-kernel.ts";
import { McpSignIns } from "./mcp-sign-in.ts";
import { nativeTreeNodes } from "./native-tree.ts";
import {
    supportedTeamCommand,
    teamCommandCatalog,
    teamCommandInputError,
    teamCommandWebInfo,
} from "./team-command-policy.ts";
import { touchSession } from "./titles.ts";

export type NativeCreation = {
    sourceId: ConversationId;
    requestId: string;
    identity: string;
    seed?: boolean;
};
export const NativeCreationsDoc = defineDoc<{
    items: Record<string, { id: ConversationId; identity: string }>;
}>({
    kind: "rotom-team.native-creations",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ items: {} }),
});

/** App-side creation intent. Never copied from a source conversation or rebuilt from today's account settings. */
export type NativeForkPlan = {
    sourceId: ConversationId;
    requestId: string;
    expectedHead: string;
    entryId?: string;
    clone?: boolean;
};
export const NativeForksDoc = defineDoc<{
    items: Record<
        string,
        { id: ConversationId; expectedHead: string; entryId?: string; clone?: boolean }
    >;
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
    seed?: NativeForkPlan | { requestId: string };
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

type NativeCommandCatalog = {
    memberId: string;
    segmentId: string;
    binding: string;
    capturedAt: number;
    resourceRevision: string;
    invalidated?: boolean;
    commands: Array<{
        name: string;
        description: string;
        argumentHint?: string;
        source?: string;
        sourceInfo?: JsonValue;
    }>;
};

function commandCatalogRevision(catalog: NativeCommandCatalog | undefined): string | null {
    return catalog ? `${catalog.capturedAt}:${catalog.invalidated ? "stale" : "known"}` : null;
}

const NativeCommandCatalogDoc = defineDoc<{ catalog?: NativeCommandCatalog }>({
    kind: "rotom-team.native-command-catalog",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({}),
});

/** Preserve native tree cancellation/draft outcomes for receipt readback without replaying navigation. */
const NativeCommandResultsDoc = defineDoc<{ items: Record<string, JsonValue> }>({
    kind: "rotom-team.native-command-results",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ items: {} }),
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
    statuses?: Record<string, string>;
    widgets?: Record<string, { lines: string[]; placement: string }>;
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
 * The configuration of a session that has no frozen snapshot: rotom loads the project's AGENTS.md and skills each
 * run. Personal skill files are ignored. A legacy session keeps its snapshot digest.
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
    readonly #commands = new Map<ConversationId, NativeCommandCatalog>();
    readonly #nativeGoal = new Map<ConversationId, unknown>();
    readonly #branchedHistory = new Set<ConversationId>();
    readonly #mirrorHistoryLoaded = new Set<ConversationId>();
    readonly #mcp: McpSignIns;
    readonly #mirrors = new Map<ConversationId, Promise<void>>();
    readonly #operations = new Map<
        string,
        { operation: string; identity: string; promise: Promise<unknown> }
    >();
    constructor(app: PocketApp) {
        this.#app = app;
        this.#mcp = new McpSignIns(join(app.dataDir, "team-agent"));
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
    /** Current head models for list views in one read, including in-place changes; no native startup/cache. */
    modelNames(): ReadonlyMap<string, string> {
        return this.executions.journal.modelNames();
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
        // A missing native PID proves neither tool closure nor the outcome of an external request.
        // Historical unknown attempts retain their fences; startup must not classify them as interrupted.

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

    needsAnswer(id: ConversationId, viewer?: User): boolean {
        const waiting = (this.#live.get(id)?.dialogs?.length ?? 0) > 0;

        if (!waiting || viewer === undefined) {
            return waiting;
        }

        return this.executions.journal.session(String(id)).binding.memberId === viewer.id;
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
            history: "immutable-audit",
            initializing: !this.#ready.has(id),
            segmentId,
            memberId: binding.memberId,
            provider: binding.provider,
            model: binding.model,
            configurationDigest: binding.configurationDigest,
            thinkingLevel: this.executions.thinkingLevel(String(id)),
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
        const command = nativeCommandName(text);
        const operation =
            command === "clone" || command === "fork"
                ? "fork"
                : command === "compact"
                  ? "compact"
                  : "submit";

        return this.#operation(id, user, requestId, operation, { text, attachments }, () =>
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
            throw new HttpError(400, "Enter ordinary text or a native slash command.");
        }

        if (text.length > 100_000) {
            throw new HttpError(400, "That message is too long.");
        }

        this.#app.requireSteer(user);
        this.#app.requireSee(user, id);

        await this.#requireSupportedCommand(id, user, text);

        if (["qoder-credits", "qoder-models"].includes(nativeCommandName(text) ?? "")) {
            await this.#requireDynamicAdapter(id, user, nativeCommandName(text)!);

            throw new HttpError(
                409,
                "Wait for your account's runs to finish before requesting private Qoder account data.",
            );
        }

        const mcp = await this.#mcpCommand(id, user, text);

        if (mcp) {
            return mcp;
        }

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
        const goal = (this.nativeGoal(id) as { goal?: { waiting?: unknown } } | undefined)?.goal;

        try {
            if (
                goal?.waiting &&
                !nativeCommandName(text) &&
                (await this.executions.wake(String(id), attachmentText(text, attachments), images))
            ) {
                return { queued: mode };
            }

            if (
                !(await this.executions.queue(
                    String(id),
                    normalizeNativePrompt(attachmentText(text, attachments)),
                    mode,
                    images,
                    (command) => this.#admitNativeCommand(command),
                ))
            ) {
                throw new HttpError(
                    409,
                    "Pi is not running a prompt now (it finished, or is compacting). Send again.",
                );
            }
        } catch (error) {
            if (error instanceof RpcFailure) {
                throw new HttpError(
                    409,
                    `Native command outcome is ${error.outcome}: ${error.message}`,
                );
            }

            if (error instanceof KernelRequestConflict) {
                throw new HttpError(409, error.message);
            }

            throw error;
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
    fork(
        id: ConversationId,
        user: User,
        requestId: string,
        expectedHead: string,
        entryId?: string,
    ) {
        return this.#operation(id, user, requestId, "fork", { expectedHead, entryId }, () =>
            this.#fork(id, user, requestId, expectedHead, entryId),
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

        const prompt = normalizeNativePrompt(attachmentText(text, attachments));

        if (!isTeamPrompt(prompt)) {
            throw new HttpError(400, "Enter ordinary text or a native slash command.");
        }

        await this.#requireSupportedCommand(id, user, prompt, requestId);
        const command = nativeCommandName(prompt);
        const args = nativeCommandArgs(prompt);

        if (command === "goal" && !args) {
            return { status: "handled" as const, interaction: { type: "native-goal" } };
        }

        const mcp = await this.#mcpCommand(id, user, prompt, requestId);

        if (mcp) {
            return mcp;
        }

        if (command === "qoder-credits" || command === "qoder-models") {
            await this.#requireDynamicAdapter(id, user, command, requestId);
            this.requireAccountIdle(user);
            const result = await this.#app.accounts.nativeQoder(
                user,
                command === "qoder-models" ? "models" : "credits",
            );

            return { status: "handled" as const, nativeResult: result };
        }

        if (command === "context") {
            if (args && args !== "usage" && args !== "injections") {
                throw new HttpError(
                    400,
                    "Use /context [usage|injections]. Context configuration belongs to the owner-managed shared profile.",
                );
            }

            await this.#requireDynamicAdapter(id, user, command, requestId);
        }

        if (command === "settings") {
            return { status: "handled" as const, interaction: { type: "native-settings" } };
        }

        if (command === "compact") {
            return this.#compact(id, user, requestId, args);
        }

        if (command === "model" || command === "thinking") {
            if (!args) {
                if (command === "model") {
                    return { status: "handled" as const, interaction: { type: "model" } };
                }

                await this.#app.accounts.forUser(user);
                const current = this.#currentChoice(id, user);
                const ref = current ?? this.#app.commands.defaultModel(user).model;

                if (!ref) {
                    throw new HttpError(409, "Connect your own account and choose a model first.");
                }

                const model = this.#app.accounts.kernelModel(user, ref);

                return {
                    status: "handled" as const,
                    interaction: {
                        type: "native-thinking",
                        levels: model.reasoning ? getSupportedThinkingLevels(model) : ["off"],
                        thinkingLevel: clampThinkingLevel(
                            model,
                            (current?.thinkingLevel ?? "off") as ModelThinkingLevel,
                        ),
                    },
                };
            }

            const separator = args.indexOf("/");

            if (command === "model" && separator <= 0) {
                return { status: "handled" as const, interaction: { type: "model", query: args } };
            }

            const result = await this.chooseModel(
                id,
                user,
                command === "model"
                    ? {
                          model: {
                              provider: args.slice(0, separator),
                              modelId: args.slice(separator + 1),
                          },
                      }
                    : { thinkingLevel: args.toLowerCase() },
                requestId,
            );

            return result.receipt ?? { status: "handled" as const };
        }

        if ((command === "fork" || command === "tree") && !args) {
            const source = this.executions.journal.session(String(id));

            if (command === "tree" && source.binding.memberId !== user.id) {
                const receipt = await this.#handoff(
                    id,
                    user,
                    `tree-handoff-${createHash("sha256").update(requestId).digest("hex").slice(0, 40)}`,
                    source.segmentId,
                );

                if (receipt.status !== "settled") {
                    return receipt;
                }
            }

            const { segmentId } = this.executions.journal.session(String(id));
            const entries = this.executions.journal.segmentEntries(segmentId);

            if (command === "tree") {
                return {
                    status: "handled" as const,
                    interaction: {
                        type: "native-tree",
                        title: "Session Tree",
                        ...nativeTreeNodes(entries),
                    },
                };
            }

            const native = await nativeSessionManager();
            const options = entries.flatMap((entry) => {
                const message = entry.message as { role?: string; content?: unknown } | undefined;

                if (entry.type !== "message" || message?.role !== "user") {
                    return [];
                }

                const selectedText = native.contentText(message.content, "") as string;

                // Native fork selectors omit user entries with no text (including image-only input).
                if (!selectedText) {
                    return [];
                }

                return [
                    {
                        entryId: entry.id,
                        label: `user: ${selectedText.slice(0, 160)}`,
                        text: `/fork ${entry.id}`,
                    },
                ];
            });

            return {
                status: "handled" as const,
                interaction: {
                    type: "native-command",
                    title: "Fork before a user message",
                    command,
                    options,
                },
            };
        }

        if (command === "clone" || command === "fork") {
            const { segmentId } = this.executions.journal.session(String(id));
            const target = await this.#fork(
                id,
                user,
                requestId,
                segmentId,
                command === "fork" ? args : undefined,
                command === "clone",
            );

            let editorText: string | undefined;

            if (command === "fork" && target.receipt?.status === "settled") {
                const selected = this.executions.journal
                    .segmentEntries(segmentId)
                    .find((entry) => entry.id === args);
                const native = await nativeSessionManager();

                editorText = native.contentText(
                    (selected!.message as { content: unknown }).content,
                    "",
                );
            }

            return target.receipt
                ? {
                      ...target.receipt,
                      conversationId: target.id,
                      receipt: target.receipt,
                      editorText,
                  }
                : { status: "unknown" as const, conversationId: target.id, receipt: null };
        }

        // Identity readback must not need a still-connected account or today's model capabilities.
        const images = await attachmentImages(attachments, true);
        const identity = nativePromptIdentity(prompt, images);
        const previous = this.executions.journal.existing(
            String(id),
            key,
            identity,
            nativePromptOperation(prompt),
        );

        if (previous) {
            const saved = (
                await this.#app.harness.snapshot(NativeCommandResultsDoc, id, BACKGROUND_CONTEXT)
            )?.items[key];

            return {
                ...this.#receipt(previous),
                ...(saved === undefined ? {} : { nativeResult: saved }),
            };
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

        let nativeResult: unknown;
        let expanded!: (receipt: KernelReceipt) => void;
        const promptExpansion = new Promise<KernelReceipt>((resolve) => {
            expanded = resolve;
        });
        let reserved!: (receipt: KernelReceipt) => void;
        let wasReserved = false;
        const admitted = new Promise<KernelReceipt>((resolve) => {
            reserved = (receipt) => {
                wasReserved = true;
                resolve(receipt);
            };
        });

        const nameAcceptedPrompt = async () => {
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
        };

        const run = this.#track(
            id,
            binding,
            this.executions.run(
                String(id),
                key,
                prompt,
                {
                    ...this.#hooks(id, async (receipt) => {
                        if (nativeCommandName(text) === undefined) {
                            await nameAcceptedPrompt();
                        }

                        reserved(receipt);
                    }),
                    onCommandAdmitted: async (command) => {
                        this.#admitNativeCommand(command);

                        if (command.source === "skill" || command.source === "prompt") {
                            await nameAcceptedPrompt();
                            expanded(journal.request(String(id), key)!);
                        }
                    },
                    onNativeResult: async (result) => {
                        nativeResult = result;

                        if (
                            result &&
                            typeof result === "object" &&
                            ("navigation" in result || "context" in result)
                        ) {
                            await this.#app.harness.commit(async (tx) => {
                                (await tx.doc(NativeCommandResultsDoc, id)).items[key] =
                                    result as JsonValue;
                            }, BACKGROUND_CONTEXT);
                        }
                    },
                },
                images,
            ),
        );

        if (wait) {
            // Skills/templates are model input, not dialogs: release the draft on authoritative admission.
            const receipt = await Promise.race([
                run,
                promptExpansion.then((receipt) => this.#receipt(receipt)),
            ]);

            return { ...receipt, ...(nativeResult === undefined ? {} : { nativeResult }) };
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
     * public history, as any change of payer. The paying member's own model or thinking change stays in the same session.
     * The choice is also remembered as the person's default.
     */
    async chooseModel(id: ConversationId, user: User, body: unknown, requestId?: string) {
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
        this.#app.requireSee(user, id);

        const prior = requestId
            ? this.executions.journal.request(String(id), this.#request(id, user, requestId))
            : undefined;

        if (prior?.operation === "command" && request.model === undefined) {
            // An idle thinking change ran as the native /thinking command in the same session.
            try {
                this.executions.journal.existing(
                    String(id),
                    prior.requestId,
                    `/thinking ${String(request.thinkingLevel)}`,
                    "command",
                );
            } catch (error) {
                if (error instanceof KernelRequestConflict) {
                    throw new HttpError(409, "Model command request identity changed.");
                }

                throw error;
            }

            return { receipt: this.#receipt(prior) };
        }

        if (prior) {
            const model = request.model;
            const matches =
                (prior.operation === "handoff" ||
                    (prior.operation === "command" && model !== undefined)) &&
                (!model ||
                    ((model.provider === prior.binding.provider ||
                        model.provider === prior.binding.accountGeneration) &&
                        model.modelId === prior.binding.model)) &&
                (request.thinkingLevel === undefined ||
                    request.thinkingLevel === prior.binding.thinkingLevel);

            if (!matches) {
                throw new HttpError(409, "Model command request identity changed.");
            }

            return { receipt: this.#receipt(prior) };
        }

        if (this.isRunning(id) && request.model === undefined) {
            await this.#app.requireDriver(id, user, "rotom");
            const { binding } = this.executions.journal.session(String(id));

            if (binding.memberId !== user.id) {
                throw new HttpError(
                    409,
                    "Only the paying member can change thinking during this run.",
                );
            }

            try {
                const level = await this.executions.setThinkingLevel(
                    String(id),
                    String(request.thinkingLevel),
                );

                this.#app.accounts.choose(user, { ...this.#ref(binding), thinkingLevel: level });
                this.#app.roomChanged(id);

                return { receipt: null };
            } catch (error) {
                if (error instanceof RpcFailure) {
                    throw new HttpError(
                        409,
                        `Thinking change outcome is ${error.outcome}: ${error.message}`,
                    );
                }

                throw error;
            }
        }

        if (this.isRunning(id) || this.executions.journal.pendingConversation(String(id))) {
            throw new HttpError(
                409,
                "Pi is working or has an unknown operation. Reconcile it before switching the model.",
            );
        }

        await this.#app.accounts.forUser(user);
        const previous = this.#currentChoice(id, user);
        let ref = request.model
            ? { provider: String(request.model.provider), modelId: String(request.model.modelId) }
            : (previous ?? this.#app.commands.defaultModel(user).model);

        if (request.model) {
            const matches = this.#app.accounts.available(user).filter((model) => {
                const native = this.#app.accounts.kernelModel(user, {
                    provider: model.provider,
                    modelId: model.id,
                });

                return (
                    model.id === request.model!.modelId &&
                    (model.provider === request.model!.provider ||
                        native.provider === request.model!.provider)
                );
            });

            if (matches.length !== 1) {
                throw new HttpError(400, "Choose one available model on your own account.");
            }

            ref = { provider: matches[0]!.provider, modelId: matches[0]!.id };
        }

        if (!ref) {
            throw new HttpError(409, "Connect your own account and choose a model first.");
        }

        const model = this.#app.accounts.kernelModel(user, ref);
        const chosen = {
            model: ref,
            thinkingLevel: clampThinkingLevel(
                model,
                String(
                    request.thinkingLevel ?? previous?.thinkingLevel ?? "off",
                ) as ModelThinkingLevel,
            ),
        };
        const { binding, segmentId } = this.executions.journal.session(String(id));

        if (
            requestId === undefined &&
            binding.memberId === user.id &&
            binding.accountGeneration === chosen.model?.provider &&
            binding.model === chosen.model.modelId &&
            this.executions.thinkingLevel(String(id)) === (chosen.thinkingLevel ?? "off")
        ) {
            this.#app.accounts.choose(user, { ...ref, thinkingLevel: chosen.thinkingLevel });

            return { receipt: null };
        }

        if (this.isRunning(id)) {
            throw new HttpError(409, "Pi is working. Stop it or wait before switching the model.");
        }

        // Thinking alone is mutable native session state: keep the session (and its identity seen
        // by project hooks) and its retained process instead of seeding a new one.
        if (
            request.model === undefined &&
            binding.memberId === user.id &&
            binding.accountGeneration === ref.provider &&
            binding.kernelVersion === verifyRotomKernel().version
        ) {
            const thinking = await this.#track(
                id,
                binding,
                this.executions.run(
                    String(id),
                    this.#request(id, user, requestId ?? `thinking-${randomUUID()}`),
                    `/thinking ${String(request.thinkingLevel)}`,
                    this.#hooks(id),
                ),
            );

            if (thinking.status === "handled") {
                this.#app.accounts.choose(user, {
                    ...ref,
                    thinkingLevel: this.executions.thinkingLevel(String(id)),
                });
                this.#app.roomChanged(id);
            }

            return { receipt: thinking };
        }

        // The paying member's model lives in its own HOME's native session: switch there, keeping the
        // session id. Another member or kernel version still takes over through a handoff.
        if (binding.memberId === user.id && binding.kernelVersion === verifyRotomKernel().version) {
            const next: KernelBinding = {
                ...binding,
                accountGeneration: ref.provider,
                provider: model.provider,
                model: model.id,
                thinkingLevel: chosen.thinkingLevel,
            };
            const switched = await this.#track(
                id,
                next,
                this.executions.setModel(
                    String(id),
                    this.#request(id, user, requestId ?? `model-${randomUUID()}`),
                    { expectedHead: segmentId, binding: next },
                    this.#hooks(id),
                ),
            );

            if (switched.status === "handled") {
                this.#app.accounts.choose(user, {
                    ...ref,
                    thinkingLevel: this.executions.thinkingLevel(String(id)),
                });
                this.#app.roomChanged(id);
            }

            return { receipt: switched };
        }

        const receipt = await this.#handoff(
            id,
            user,
            requestId ?? `model-${randomUUID()}`,
            segmentId,
            chosen,
        );

        if (receipt.status === "settled") {
            this.#app.accounts.choose(user, { ...ref, thinkingLevel: chosen.thinkingLevel });
        }

        return { receipt };
    }

    #hooks(
        id: ConversationId,
        onReserved?: (receipt: KernelReceipt) => void | Promise<void>,
    ): RunHooks {
        return {
            ...(onReserved ? { onReserved } : {}),
            onCommandAdmitted: (command) => this.#admitNativeCommand(command),
            sessionName: () => this.#app.sessionMeta(id)?.title,
            onSessionName: async (name) => {
                await this.#app.harness.commit(async (tx) => {
                    const meta = (await tx.doc(SessionsDoc)).items[String(id)];

                    if (meta) {
                        meta.title = name;
                        meta.updatedAt = Date.now();
                    }
                }, BACKGROUND_CONTEXT);
                this.#app.roomChanged(id);
            },
            onEvent: (event) => this.#observe(id, event),
            onCommands: async (commands) => {
                const session = this.executions.journal.session(String(id));

                this.#commands.set(id, {
                    memberId: session.binding.memberId,
                    segmentId: session.segmentId,
                    binding: JSON.stringify(session.binding),
                    capturedAt: Date.now(),
                    resourceRevision: teamResourceRevision(
                        join(this.#app.dataDir, "team-agent"),
                        this.#app.cwdOf(id),
                    ),
                    commands: commands
                        .filter(
                            (command) =>
                                typeof command.name === "string" &&
                                !command.name.startsWith("team-kernel-"),
                        )
                        .map((command) => ({
                            name: command.name as string,
                            description:
                                typeof command.description === "string" ? command.description : "",
                            ...(typeof command.argumentHint === "string"
                                ? { argumentHint: command.argumentHint }
                                : {}),
                            ...(command.sourceInfo
                                ? { sourceInfo: command.sourceInfo as JsonValue }
                                : {}),
                            ...(typeof command.source === "string"
                                ? { source: command.source }
                                : {}),
                        })),
                });
                await this.#app.harness.commit(async (tx) => {
                    (await tx.doc(NativeCommandCatalogDoc, id)).catalog = this.#commands.get(id)!;
                }, BACKGROUND_CONTEXT);
                this.#app.roomChanged(id);
            },
            onNativeGoalState: (state) => {
                this.#nativeGoal.set(id, state);
                this.#app.roomChanged(id);
            },
            onNativeResult: (result) => {
                const nativeResult = result as { path?: unknown } | undefined;
                const path =
                    nativeResult && typeof nativeResult.path === "string" ? nativeResult.path : "";

                this.#app.notice(
                    "info",
                    path === "" ? "Native command completed." : `Native command wrote ${path}`,
                    id,
                );
            },
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

            case "compaction_start":
                live.compacting = String(event.reason ?? "threshold");
                break;

            case "compaction_end":
                delete live.compacting;
                break;

            case "extension_error":
                this.#app.notice(
                    "warning",
                    `Native extension error (${String(event.extensionPath ?? "unknown")}): ${String(event.error ?? "unknown error")}`,
                    id,
                );
                break;

            case "extension_ui_request": {
                const subagents = childrenReport(event);

                if (subagents !== undefined) {
                    live.subagents = subagents;
                    break;
                }

                const method = String(event.method);
                const text = (value: unknown) =>
                    typeof value === "string" ? value.slice(0, 16_000) : undefined;

                // Native notifications are notices; statuses/widgets are keyed live replace/clear slots.
                // Dialogs remain interactive live state for the paying member.
                if (method === "notify") {
                    if (
                        typeof event.message === "string" &&
                        event.message.startsWith('{"kind":"team-kernel-context-v1"')
                    ) {
                        return;
                    }

                    const message = text(event.message);

                    if (message) {
                        let control: { kind?: unknown } | undefined;

                        try {
                            control = JSON.parse(message) as { kind?: unknown };
                        } catch {}

                        if (
                            [
                                "team-kernel-barrier-v1",
                                "team-kernel-tree-v1",
                                "team-kernel-context-v1",
                            ].includes(String(control?.kind))
                        ) {
                            return;
                        }

                        const level = ["warning", "error"].includes(String(event.notifyType))
                            ? (String(event.notifyType) as "warning" | "error")
                            : "info";

                        this.#app.notice(level, message, id);
                    }

                    return;
                }

                if (method === "setStatus") {
                    const key = String(event.statusKey);
                    const message = text(event.statusText);

                    live.statuses ??= Object.create(null) as Record<string, string>;

                    if (message === undefined) {
                        delete live.statuses[key];
                    } else {
                        live.statuses[key] = message;
                    }

                    break;
                }

                if (method === "setWidget") {
                    const lines = Array.isArray(event.widgetLines)
                        ? event.widgetLines.filter(
                              (line): line is string => typeof line === "string",
                          )
                        : [];

                    const key = String(event.widgetKey);

                    live.widgets ??= Object.create(null) as NonNullable<NativeLive["widgets"]>;

                    if (event.widgetLines === undefined) {
                        delete live.widgets[key];
                    } else {
                        live.widgets[key] = {
                            lines,
                            placement: String(event.widgetPlacement ?? "aboveEditor"),
                        };
                    }

                    break;
                }

                if (!DIALOG_METHODS.has(method)) {
                    return;
                }

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
                this.#app.kernelChanged();
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
        this.#app.kernelChanged();

        if (!this.executions.answer(String(id), dialog.id, response)) {
            this.#app.roomChanged(id);

            throw new HttpError(409, "That question is no longer waiting.");
        }

        this.#app.roomChanged(id);

        return { answered: true };
    }

    /** The same personal model choice drives the thinking picker and its eventual configuration write. */
    #currentChoice(id: ConversationId, user: User) {
        const { binding } = this.executions.journal.session(String(id));

        return binding.memberId === user.id
            ? { ...this.#ref(binding), thinkingLevel: this.executions.thinkingLevel(String(id)) }
            : this.#app.accounts.choice(user);
    }

    /** The room's agent line for a native conversation: what the current segment runs on, and for whom. */
    agentInfo(id: ConversationId, readEntries?: (segmentId: string) => KernelEntry[]) {
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
            thinkingLevel: this.executions.thinkingLevel(String(id), readEntries),
            cwd: binding.workspace,
            available: true,
        };
    }

    /**
     * Shared/project MCP servers as this member's runs reach them, and sign-in to those that use OAuth. A sign-in is the
     * member's own: only their runs send its tokens. Reporting starts the configured command servers, as a run does, so
     * it takes the right to run Pi in the project.
     */
    async #mcpCommand(id: ConversationId, user: User, text: string, requestId?: string) {
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

        await this.#requireDynamicAdapter(id, user, "mcp", requestId);

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
                    : { message: "message" in result ? result.message : "MCP command completed." }),
            },
        };
    }

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

    async nativeSettings(id: ConversationId, user: User, patch?: Record<string, unknown>) {
        this.#app.requireSee(user, id);
        this.#app.requireSteer(user);
        this.#app.projects.require(user, this.#app.sessionMeta(id)?.projectId, "continue");
        await this.#app.accounts.forUser(user);
        const api = await nativeConfigurationApi();

        safeConfigurationPath(join(this.#app.dataDir, "team-agent"), "settings.json");
        const manager = api.SettingsManager.create(
            this.#app.cwdOf(id),
            join(this.#app.dataDir, "team-agent"),
            { projectTrusted: false },
        );

        if (patch) {
            if (user.role !== "owner") {
                throw new HttpError(403, "Only the owner can change shared agent settings.");
            }

            if (this.#active.size > 0) {
                throw new HttpError(
                    409,
                    "Wait for active Team runs before changing shared settings.",
                );
            }

            this.requireAccountIdle(user);
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
                throw new HttpError(400, "enabledModels must be a list of native model patterns.");
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

            for (const [sessionId, cached] of this.#commands) {
                cached.invalidated = true;
                this.#app.roomChanged(sessionId);
            }

            const errors = manager.drainErrors();

            if (errors.length) {
                throw new HttpError(409, "Native settings could not be saved.");
            }
        }

        const available = this.#app.accounts.available(user);
        const nativeModels = available.map((model) =>
            this.#app.accounts.kernelModel(user, { provider: model.provider, modelId: model.id }),
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
                const native = this.#app.accounts.kernelModel(user, {
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
    }

    /** Raw native export is a private download for the segment's member, never a shared artifact. */
    async nativeExport(id: ConversationId, user: User, format: string) {
        this.#app.requireSee(user, id);

        if (format !== "jsonl" && format !== "html") {
            throw new HttpError(400, "Choose html or jsonl.");
        }

        const segment = this.executions.journal.session(String(id));

        if (segment.binding.memberId !== user.id) {
            throw new HttpError(
                403,
                "Raw native exports belong to the member who owns this segment.",
            );
        }

        if (this.executions.journal.pendingConversation(String(id))) {
            throw new HttpError(409, "Wait for the native operation to settle before exporting.");
        }

        if (!segment.sessionFile) {
            throw new HttpError(409, "This session has no native history yet.");
        }

        // Snapshot before yielding: a later run must not change the downloaded branch mid-export.
        const bytes = readFileSync(segment.sessionFile);
        const folder = mkdtempSync(join(segment.binding.home, "export-"));

        try {
            const input = join(folder, "session.jsonl");

            writeFileSync(input, bytes, { mode: 0o600 });
            const native = await nativeSessionManager();
            const exports = await nativeSessionExports();
            const manager = native.SessionManager.open(input);

            if (format === "jsonl") {
                return Buffer.from(exports.serializeSessionBranch(manager));
            }

            const path = join(folder, "session.html");

            await exports.exportFromFile(input, { outputPath: path });

            return readFileSync(path);
        } finally {
            rmSync(folder, { recursive: true, force: true });
        }
    }

    /** Explicit discovery is a non-inference native operation under the requesting member's lease. */
    discoverCommands(id: ConversationId, user: User, requestId: string) {
        return this.#operation(id, user, requestId, "discover", {}, async () => {
            this.#app.requireSteer(user);
            await this.#app.requireDriver(id, user, "rotom");

            if (this.isRunning(id)) {
                throw new HttpError(409, "Wait for this run before refreshing native commands.");
            }

            const prior = this.executions.journal.request(
                String(id),
                this.#request(id, user, requestId),
            );

            if (prior) {
                if (prior.operation !== "discover") {
                    throw new HttpError(409, "Request belongs to another operation.");
                }

                return { receipt: this.#receipt(prior), ...(await this.nativeCommands(id, user)) };
            }

            if (this.executions.journal.pendingConversation(String(id))?.status === "unknown") {
                throw new HttpError(
                    409,
                    "Reconcile the unknown operation before refreshing native commands.",
                );
            }

            const source = this.executions.journal.session(String(id));

            if (
                source.binding.memberId !== user.id ||
                source.binding.kernelVersion !== verifyRotomKernel().version
            ) {
                const takeover = await this.#handoff(
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

            const binding = this.executions.journal.session(String(id)).binding;
            const receipt = await this.#track(
                id,
                binding,
                this.executions.discover(
                    String(id),
                    this.#request(id, user, requestId),
                    this.#hooks(id),
                ),
            );

            return { receipt, ...(await this.nativeCommands(id, user)) };
        });
    }

    async #requireDynamicAdapter(id: ConversationId, user: User, name: string, requestId?: string) {
        if (!this.isRunning(id)) {
            if (!requestId) {
                throw new HttpError(409, "The run finished; submit this command again while idle.");
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

        if (!registry.dynamicReady || !registry.commands.some((command) => command.name === name)) {
            throw new HttpError(
                400,
                `Native command /${name} is not registered for your selected runtime.`,
            );
        }
    }

    #commandSnapshot(
        id: ConversationId,
        memberId: string,
        knownSession?: { segmentId: string; binding: KernelBinding },
    ) {
        const cached = this.#commands.get(id);

        if (!cached) {
            return undefined;
        }

        // A standalone catalog read must prove the session still exists. roomState already read this exact snapshot
        // synchronously, so reuse it there instead of querying and decoding the same binding again.
        if (knownSession === undefined && !this.executions.journal.hasConversation(String(id))) {
            return undefined;
        }

        const session = knownSession ?? this.executions.journal.session(String(id));

        if (
            cached?.memberId === memberId &&
            cached.segmentId === session.segmentId &&
            cached.binding === JSON.stringify(session.binding)
        ) {
            return cached;
        }
    }

    /** Recheck the live native registry: a cached template may now be shadowed by an extension. */
    #admitNativeCommand(command: { name: string; source?: unknown; args?: string }) {
        if (!supportedTeamCommand(command)) {
            throw new RpcFailure("rejected", `/${command.name} is not supported in Team.`);
        }

        const error = teamCommandInputError(command, command.args);

        if (error) {
            throw new RpcFailure("rejected", error);
        }
    }

    /** Reject hidden commands before native startup, handoff or inference. Skills/templates still need discovery. */
    async #requireSupportedCommand(
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
            await this.#requireDynamicAdapter(id, user, name, requestId);

            return;
        }

        if (!catalog.commands.some((command) => command.name === name)) {
            throw new HttpError(
                400,
                `/${name} is not supported in Team. Open / to see available commands.`,
            );
        }
    }

    /** Read-only snapshots; another member's native command descriptions are never returned. */
    async nativeCommands(id: ConversationId, user: User) {
        this.#app.requireSee(user, id);

        const builtins = await nativeBuiltinCommands();

        if (!this.#commands.has(id)) {
            const saved = (
                await this.#app.harness.snapshot(NativeCommandCatalogDoc, id, BACKGROUND_CONTEXT)
            )?.catalog;

            if (saved) {
                this.#commands.set(id, saved);
            }
        }

        const cached = this.#commandSnapshot(id, user.id);
        const dynamic = cached?.commands ?? [];

        return {
            commands: teamCommandCatalog([...builtins, ...dynamic]).map((command) => ({
                ...command,
                web: teamCommandWebInfo(command),
            })),
            dynamicReady: Boolean(cached),
            discoveryBlocked:
                this.executions.journal.pendingConversation(String(id))?.status === "unknown",
            revision: commandCatalogRevision(cached),
            freshness: !cached
                ? "undiscovered"
                : cached.invalidated ||
                    cached.resourceRevision !==
                        teamResourceRevision(
                            join(this.#app.dataDir, "team-agent"),
                            this.#app.cwdOf(id),
                        )
                  ? "configuration-changed"
                  : this.isRunning(id)
                    ? "live"
                    : "last-known",
            capturedAt: cached?.capturedAt ?? null,
        };
    }

    /** Canonical Goal snapshot captured after the native command barrier, if one has been observed. */
    nativeGoal(
        id: ConversationId,
        readEntries = (segmentId: string) => this.executions.journal.segmentEntries(segmentId),
    ): unknown {
        if (this.#nativeGoal.has(id)) {
            return this.#nativeGoal.get(id);
        }

        if (!this.executions.journal.hasConversation(String(id))) {
            return undefined;
        }

        const { segmentId } = this.executions.journal.session(String(id));

        const entries = readEntries(segmentId);

        return currentBranchGoalState({ entries, leafId: entries.at(-1)?.id });
    }

    /** Room-wide public readback; share complete history only within this synchronous projection. */
    roomInfo(id: ConversationId) {
        const bySegment = new Map<string, KernelEntry[]>();

        const readEntries = (segmentId: string) => {
            let entries = bySegment.get(segmentId);

            if (entries === undefined) {
                entries = this.executions.journal.segmentEntries(segmentId);
                bySegment.set(segmentId, entries);
            }

            return entries;
        };

        // Goal used to be read before agentInfo; keep that error/live-state ordering.
        const goal = this.nativeGoal(id, readEntries);
        const agent = this.agentInfo(id, readEntries);

        return { goal, agent };
    }

    /** What the web app needs to drive a native conversation: the head it acts on, and who pays for it. */
    roomState(id: ConversationId, viewer: User) {
        const journal = this.executions.journal;

        const session = journal.sessionIfPresent(String(id));

        if (!session) {
            return { initializing: true };
        }

        const { binding, segmentId } = session;
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
            commandsRevision: commandCatalogRevision(
                this.#commandSnapshot(id, viewer.id, { binding, segmentId }),
            ),
            hasBranchedHistory: this.#branchedHistory.has(id),
            dialogs: this.#live.get(id)?.dialogs ?? [],
            statuses: this.#live.get(id)?.statuses ?? {},
            widgets: this.#live.get(id)?.widgets ?? {},
            subagents: this.#live.get(id)?.subagents ?? 0,
            ...(this.#cutOff(id) ? { cutOff: true } : {}),
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
    }

    /** The last run was cut off by a server stop and did not continue by itself: a person may say Continue. */
    #cutOff(id: ConversationId): boolean {
        const journal = this.executions.journal;
        const latest = journal.latest(String(id));

        if (
            !latest ||
            this.isRunning(id) ||
            latest.status === "unknown" ||
            latest.phase === "finalization"
        ) {
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
        const mirrored =
            (await app.harness.snapshot(NativeMirrorDoc, id, BACKGROUND_CONTEXT))?.count ?? 0;
        // Once per process, inspect the prefix too so historical branch notices survive restart.
        // Thereafter SQL returns only the unmirrored suffix, avoiding old body/binding JSON decoding.
        const skip = this.#mirrorHistoryLoaded.has(id) ? mirrored : 0;
        const rows = this.executions.journal.entries(String(id), skip);
        const count = skip + rows.length;

        if (rows.some((row) => row.entry.customType === "team-kernel-branch")) {
            this.#branchedHistory.add(id);
        }

        this.#mirrorHistoryLoaded.add(id);

        if (count > mirrored) {
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

                    const record = await tx.appendEntry(id, {
                        kind: NATIVE_ENTRY,
                        data: { entry: publicEntry(row.entry) } as unknown as JsonValue,
                    });
                    const message = row.entry.message as { role?: unknown } | undefined;

                    // A person's own prompt; inherited fork history and automatic continuations have no author.
                    if (
                        ["prompt", "command"].includes(row.operation) &&
                        !row.requestId.includes("#resume") &&
                        row.entry.type === "message" &&
                        message?.role === "user"
                    ) {
                        authors.entries[String(record.id)] = row.memberId;
                    }
                }

                doc.count = count;
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

        if (
            !["submit", "handoff", "compact", "fork", "configuration", "discover"].includes(
                operation,
            )
        ) {
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
            (operation === "submit"
                ? !["prompt", "command", "compact"].includes(receipt.operation)
                : receipt.operation !== (operation === "configuration" ? "handoff" : operation))
        ) {
            throw new HttpError(409, "Request belongs to another operation.");
        }

        const preparedOnly =
            ["fork", "configuration"].includes(operation) &&
            targetId !== null &&
            !receipt &&
            !this.#operations.has(JSON.stringify([id, key]));

        const nativeResult =
            operation === "submit"
                ? (
                      await this.#app.harness.snapshot(
                          NativeCommandResultsDoc,
                          id,
                          BACKGROUND_CONTEXT,
                      )
                  )?.items[key]
                : undefined;

        return {
            targetId,
            receipt: receipt ? this.#receipt(receipt) : null,
            ...(nativeResult === undefined ? {} : { nativeResult }),
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

    async #fork(
        id: ConversationId,
        user: User,
        requestId: string,
        expectedHead: string,
        entryId?: string,
        clone = false,
    ) {
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
                if (
                    prior.expectedHead !== expectedHead ||
                    prior.entryId !== entryId ||
                    Boolean(prior.clone) !== clone
                ) {
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

            if (entryId) {
                const selected = journal
                    .segmentEntries(expectedHead)
                    .find((entry) => entry.id === entryId);

                if (
                    selected?.type !== "message" ||
                    (selected.message as { role?: unknown } | undefined)?.role !== "user"
                ) {
                    throw new HttpError(400, "Select a user message from this native segment.");
                }
            }

            const meta = app.sessionMeta(id)!;
            const target = await app.commands.createSession(
                current,
                {
                    backend: "rotom",
                    cwd: meta.cwd,
                    title: `${meta.title ?? "New session"} · ${clone ? "Copy" : "Fork"}`,
                },
                {
                    sourceId: id,
                    requestId: key,
                    expectedHead,
                    ...(entryId ? { entryId } : {}),
                    ...(clone ? { clone: true } : {}),
                },
            );
            const binding = journal.session(String(target.id)).binding;
            const receipt = await this.#track(
                target.id,
                binding,
                this.executions.fork(
                    String(id),
                    String(target.id),
                    key,
                    expectedHead,
                    entryId,
                    clone,
                ),
            );

            if (receipt.status === "settled") {
                this.#ready.add(target.id);
            }

            app.kernelChanged();

            return { id: target.id, receipt };
        });
    }

    async #handoff(
        id: ConversationId,
        user: User,
        requestId: string,
        expectedHead: string,
        selected?: { model: ModelRef; thinkingLevel: ModelThinkingLevel },
    ) {
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
        const { model: choice, thinkingLevel } = selected ?? this.#app.commands.defaultModel(user);

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
            phase: receipt.phase,
            failure: receipt.failure,
        };
    }

    async #track(id: ConversationId, binding: KernelBinding, promise: Promise<KernelReceipt>) {
        const run = { id, binding, promise };

        this.#nativeGoal.delete(id);
        this.#active.add(run);
        this.#app.kernelChanged();

        let finished = false;

        try {
            const receipt = await run.promise;

            if (["unknown", "rejected", "interrupted"].includes(receipt.status)) {
                const cached = this.#commands.get(id);

                if (cached) {
                    cached.invalidated = true;
                }
            }

            await this.mirror(id);
            finished =
                receipt.operation === "prompt" &&
                ["settled", "interrupted"].includes(receipt.status);

            return this.#receipt(receipt);
        } finally {
            this.#active.delete(run);

            if (!this.isRunning(id)) {
                this.#live.delete(id);
                this.#nativeGoal.delete(id);
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
     * Continue only a planned, cleanly settled stop, once, under the original member's usual checks.
     * Unknown outcomes and legacy interrupted classifications stay untouched, even with a persisted resume plan.
     * The derived request id prevents a second startup from sending the same continuation again.
     */
    async resumeInterrupted(): Promise<void> {
        const journal = this.executions.journal;

        for (const plan of journal.resumes("pending")) {
            const id = this.#id(plan.sessionId);
            const attempt = journal.receipt(plan.attemptId);

            if (attempt.status !== "settled") {
                continue;
            }

            const { binding } = journal.session(plan.sessionId);
            const user = this.#app.config.userById(binding.memberId);

            // Someone acted since (a new message, a handoff, a fork seed): their choice stands.
            if (
                journal.latest(plan.sessionId)?.id !== attempt.id ||
                !user ||
                !journal.canResume(attempt.id)
            ) {
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

            if (pending?.operation === "prompt" && this.executions.journal.canResume(pending.id)) {
                this.executions.journal.planResume(pending.id);
            }
        }

        for (const id of new Set([...this.#active].map((run) => run.id))) {
            await this.executions.abort(String(id));
        }

        await Promise.allSettled([...this.#active].map((run) => run.promise));
        await this.executions.close();
    }
}

/** What a continuation after a server stop tells Pi. It shows in the transcript as the server's note. */
const RESUME_TEXT = `${RESUME_PREFIX} The server restarted while you were working, and your last step may have been cut off. Check what was already done, then continue the task from where it stopped. Do not repeat finished steps.`;

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
