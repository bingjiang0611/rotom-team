import { join } from "node:path";
import { type ConversationId, type ModelRef } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import type { Attachment } from "./commands.ts";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { RunHooks } from "./rotom-executions/contracts.ts";
import { HttpError } from "./errors.ts";
import { RotomExecutions } from "./rotom-executions.ts";
import type { ClientLive } from "./projection.ts";
import {
    type KernelBinding,
    type AsyncRotomJournal,
    type KernelEntry,
    type KernelReceipt,
} from "./rotom-journal.ts";
import { verifyRotomKernel } from "./rotom-kernel.ts";
import { McpSignIns } from "./mcp-sign-in.ts";
import {
    createSubmissionDomain,
    type ReceiptView,
    type SessionRecord,
} from "./team-kernel-submission.ts";
import { createModelDomain } from "./team-kernel-model.ts";
import { createHistoryDomain } from "./team-kernel-history.ts";
import { createAdapterDomain } from "./team-kernel-adapters.ts";
import { createCatalogDomain } from "./team-kernel-catalog.ts";
import { createRoomDomain } from "./team-kernel-room.ts";
import { createMirrorDomain } from "./team-kernel-mirror.ts";
import { createRuntimeDomain } from "./team-kernel-runtime.ts";
import { createExportDomain } from "./team-kernel-export.ts";
import { createRequestDomain } from "./team-kernel-request.ts";
import { createAccessDomain } from "./team-kernel-access.ts";
import type { ConfigurationSnapshot } from "./team-profiles.ts";
import { createSetupDomain } from "./team-kernel-setup.ts";
import { createLifecycleDomain } from "./team-kernel-lifecycle.ts";
import { createKernelOwners, type KernelOwnerContext } from "./team-kernel-owners.ts";
import { createTeamExecutions } from "./team-kernel-executions.ts";
import { nativeHome } from "./team-kernel-home.ts";

import {
    NATIVE_LAYERS,
    NativeCreationsDoc,
    NativeForksDoc,
    NativeSetupDoc,
    NativeMirrorDoc,
    NativeCommandCatalogDoc,
    NativeCommandResultsDoc,
    NativeConfigurationsDoc,
    type NativeCreation,
    type NativeForkPlan,
    type NativeLive,
    type NativeCommandCatalog,
    type NativeConfigurations,
    type NativeDialog,
} from "./team-kernel-docs.ts";
export {
    NATIVE_LAYERS,
    NativeCreationsDoc,
    NativeForksDoc,
    NativeSetupDoc,
    NativeMirrorDoc,
    NativeCommandCatalogDoc,
    NativeCommandResultsDoc,
    NativeConfigurationsDoc,
};
export type {
    NativeCreation,
    NativeForkPlan,
    NativeLive,
    NativeCommandCatalog,
    NativeConfigurations,
    NativeDialog,
};

export class TeamKernel {
    readonly executions: RotomExecutions;
    readonly #app: PocketApp;
    readonly #active = new Set<{
        id: ConversationId;
        binding: KernelBinding;
        promise: Promise<KernelReceipt>;
    }>();
    readonly #closing = { value: false };
    readonly #ready = new Set<ConversationId>();
    readonly #configurations = new Map<ConversationId, NativeConfigurations>();
    readonly #live = new Map<ConversationId, NativeLive>();
    readonly #commands = new Map<ConversationId, NativeCommandCatalog>();
    readonly #nativeGoal = new Map<ConversationId, unknown>();
    readonly #historicalGoals = new Map<
        string,
        { rowid: number; version: string; value: unknown }
    >();
    readonly #branchedHistory = new Set<ConversationId>();
    readonly #mirrorHistoryLoaded = new Set<ConversationId>();
    readonly #mirrorCursors = new Map<ConversationId, { count: number; rowid: number }>();
    readonly #mirrors = new Map<ConversationId, Promise<void>>();
    readonly #mcp: McpSignIns;
    readonly #operations = new Map<
        string,
        { operation: string; identity: string; promise: Promise<unknown> }
    >();
    readonly #remoteStorage: boolean;
    readonly #submission: ReturnType<typeof createSubmissionDomain>;
    readonly #model: ReturnType<typeof createModelDomain>;
    readonly #history: ReturnType<typeof createHistoryDomain>;
    readonly #adapters: ReturnType<typeof createAdapterDomain>;
    readonly #catalog: ReturnType<typeof createCatalogDomain>;
    readonly #room: ReturnType<typeof createRoomDomain>;
    readonly #mirror: ReturnType<typeof createMirrorDomain>;
    readonly #runtime: ReturnType<typeof createRuntimeDomain>;
    readonly #export: ReturnType<typeof createExportDomain>;
    readonly #requestDomain: ReturnType<typeof createRequestDomain>;
    readonly #access: ReturnType<typeof createAccessDomain>;
    readonly #setup: ReturnType<typeof createSetupDomain>;
    readonly #lifecycle: ReturnType<typeof createLifecycleDomain>;
    constructor(app: PocketApp, journal?: AsyncRotomJournal) {
        this.#remoteStorage = journal !== undefined;
        this.#app = app;
        this.#mcp = new McpSignIns(join(app.dataDir, "team-agent"));
        verifyRotomKernel();
        this.executions = createTeamExecutions(
            app,
            journal,
            (value) => this.#id(value),
            (binding, id) => this.#check(binding, id),
            (binding) => this.#ref(binding),
            (binding, id) => this.#snapshot(binding, id),
            () => this.#closing.value,
        );

        const owners = createKernelOwners(this.#ownerContext());

        this.#submission = createSubmissionDomain(owners.submission);

        this.#model = createModelDomain(owners.model);

        this.#history = createHistoryDomain(owners.history);

        this.#adapters = createAdapterDomain(owners.adapters);

        this.#catalog = createCatalogDomain(owners.catalog);

        this.#room = createRoomDomain(owners.room);

        this.#mirror = createMirrorDomain(owners.mirror);

        this.#runtime = createRuntimeDomain(owners.runtime);

        this.#export = createExportDomain(owners.submission);

        this.#requestDomain = createRequestDomain(owners.request);

        this.#access = createAccessDomain(owners.access);

        this.#setup = createSetupDomain(owners.setup);

        this.#lifecycle = createLifecycleDomain(owners.lifecycle);
    }

    #ownerContext(): KernelOwnerContext {
        return {
            app: this.#app,
            executions: this.executions,
            active: this.#active,
            configurations: this.#configurations,
            commands: this.#commands,
            live: this.#live,
            nativeGoals: this.#nativeGoal,
            historicalGoals: this.#historicalGoals,
            ready: this.#ready,
            remoteStorage: this.#remoteStorage,
            operations: this.#operations,
            mirrorHistoryLoaded: this.#mirrorHistoryLoaded,
            mirrorCursors: this.#mirrorCursors,
            branchedHistory: this.#branchedHistory,
            mirrors: this.#mirrors,
            mcp: this.#mcp,
            closing: this.#closing,
            model: () => this.#model,
            submission: () => this.#submission,
            catalog: () => this.#catalog,
            runtime: () => this.#runtime,
            lifecycle: () => this.#lifecycle,
            isRunning: (id) => this.isRunning(id),
            requireAccountIdle: (user) => this.requireAccountIdle(user),
            nativeGoal: (id, readEntries) => this.nativeGoal(id, readEntries),
            chooseModel: (id, user, body, requestId) => this.chooseModel(id, user, body, requestId),
            operation: (id, user, requestId, operation, identity, action) =>
                this.#operation(id, user, requestId, operation, identity, action),
            admitNativeCommand: (command) => this.#admitNativeCommand(command),
            currentChoice: (id, user) => this.#currentChoice(id, user),
            ref: (binding) => this.#ref(binding),
            request: (id, user, requestId, requireReady, operation) =>
                this.#request(id, user, requestId, requireReady, operation),
            hooks: (id, onReserved) => this.#hooks(id, onReserved),
            mcpCommand: (id, user, text, requestId) => this.#mcpCommand(id, user, text, requestId),
            requireDynamicAdapter: (id, user, name, requestId) =>
                this.#requireDynamicAdapter(id, user, name, requestId),
            requireSupportedCommand: (id, user, text, requestId) =>
                this.#requireSupportedCommand(id, user, text, requestId),
            track: (id, binding, promise) => this.#track(id, binding, promise),
            upgradeKernel: (id, user, observed) => this.#upgradeKernel(id, user, observed),
            configure: (id, user, requestId, expectedHead) =>
                this.#configure(id, user, requestId, expectedHead),
            compact: (id, user, requestId, instructions) =>
                this.#compact(id, user, requestId, instructions),
            handoff: (id, user, requestId, expectedHead, selected) =>
                this.#handoff(id, user, requestId, expectedHead, selected),
            fork: (id, user, requestId, expectedHead, entryId, clone) =>
                this.#fork(id, user, requestId, expectedHead, entryId, clone),
            receipt: (receipt) => this.#history.receipt(receipt),
            submitInternal: (id, user, requestId, text, wait, attachments) =>
                this.#submission.submitInternal(id, user, requestId, text, wait, attachments),
            check: (binding, id, staged) => this.#check(binding, id, staged),
            forkIdentity: (id, key, operation) => this.#forkIdentity(id, key, operation),
            mirror: (id) => this.mirror(id),
            submit: (id, user, requestId, text, wait, attachments) =>
                this.submit(id, user, requestId, text, wait, attachments),
            resumeInterruptedImpl: () => this.#lifecycle.resumeInterruptedImpl(),
            agentInfo: (id, readEntries) => this.agentInfo(id, readEntries),
            home: (memberId) => this.#home(memberId),
            id: (value) => this.#id(value),
            ensureBound: (id) => this.ensureBound(id),
            cutOff: (id, user) => this.cutOff(id, user),
            commandSnapshot: (...args) => this.#catalog.commandSnapshot(...args),
            observe: (...args) => this.#runtime.observe(...args),
        };
    }
    #home(memberId: string): string {
        return nativeHome(this.#app.dataDir, memberId);
    }

    #id(value: string): ConversationId {
        const id = Number(value);

        if (!Number.isSafeInteger(id) || String(id) !== value) {
            throw new HttpError(403, "Unknown team conversation.");
        }

        return id as ConversationId;
    }
    modelNames(): Promise<ReadonlyMap<string, string>> {
        return this.#access.modelNames();
    }
    configuration(id: ConversationId): Promise<ConfigurationSnapshot | undefined> {
        return this.#access.configuration(id);
    }
    binding(user: User, cwd: string, ref: ModelRef, thinkingLevel: string): KernelBinding {
        return this.#access.binding(user, cwd, ref, thinkingLevel);
    }
    #ref(binding: KernelBinding): ModelRef {
        return this.#access.ref(binding);
    }
    #snapshot(binding: KernelBinding, id: ConversationId): ConfigurationSnapshot | undefined {
        return this.#access.snapshot(binding, id);
    }
    async #check(
        binding: KernelBinding,
        id: ConversationId,
        staged?: ConfigurationSnapshot,
    ): Promise<User> {
        return this.#access.check(binding, id, staged);
    }

    isRunning(id: ConversationId): boolean {
        return this.#setup.isRunning(id);
    }
    #operation<T>(
        id: ConversationId,
        user: User,
        requestId: string,
        operation: string,
        payload: unknown,
        action: () => Promise<T>,
    ): Promise<T> {
        return this.#runtime.operation(id, user, requestId, operation, payload, action);
    }
    submit(
        id: ConversationId,
        user: User,
        requestId: string,
        text: string,
        wait = true,
        attachments: Attachment[] = [],
    ) {
        return this.#runtime.submit(id, user, requestId, text, wait, attachments);
    }
    queue(
        id: ConversationId,
        user: User,
        text: string,
        mode: "steer" | "followUp",
        attachments: Attachment[] = [],
    ) {
        return this.#runtime.queue(id, user, text, mode, attachments);
    }
    configure(id: ConversationId, user: User, requestId: string, expectedHead: string) {
        return this.#runtime.configure(id, user, requestId, expectedHead);
    }
    compact(id: ConversationId, user: User, requestId: string, instructions: string) {
        return this.#runtime.compact(id, user, requestId, instructions);
    }
    fork(
        id: ConversationId,
        user: User,
        requestId: string,
        expectedHead: string,
        entryId?: string,
        clone?: boolean,
    ) {
        return this.#runtime.fork(id, user, requestId, expectedHead, entryId, clone);
    }
    handoff(
        id: ConversationId,
        user: User,
        requestId: string,
        expectedHead: string,
        selected?: { model: ModelRef; thinkingLevel: ModelThinkingLevel },
    ) {
        return this.#runtime.handoff(id, user, requestId, expectedHead, selected);
    }
    chooseModel(id: ConversationId, user: User, body: unknown, requestId?: string) {
        return this.#runtime.chooseModel(id, user, body, requestId);
    }
    #hooks(
        id: ConversationId,
        onReserved?: (receipt: KernelReceipt) => void | Promise<void>,
    ): RunHooks {
        return this.#runtime.hooks(id, onReserved);
    }
    async ensureBound(id: ConversationId): Promise<void> {
        return this.#setup.ensureBound(id);
    }
    async reconcile(ids: readonly ConversationId[]): Promise<void> {
        return this.#setup.reconcile(ids);
    }
    async requireAccountIdle(user: User): Promise<void> {
        return this.#setup.requireAccountIdle(user);
    }
    async needsAnswer(id: ConversationId, viewer?: User): Promise<boolean> {
        return this.#setup.needsAnswer(id, viewer);
    }
    async snapshot(id: ConversationId, user: User) {
        return this.#setup.snapshot(id, user);
    }

    /**
     * Answer a dialog of the running prompt. Only the member it runs for may: the run spends their account and
     * acts with their authority. A dialog that is gone (answered, or its run ended) is a 409, never a resend.
     */
    async answerDialog(id: ConversationId, user: User, body: unknown): Promise<{ answered: true }> {
        return this.#adapters.answerDialog(id, user, body);
    }
    async agentInfo(
        id: ConversationId,
        readEntries?: (segmentId: string) => Promise<KernelEntry[]>,
    ) {
        return this.#adapters.agentInfo(id, readEntries);
    }
    async #currentChoice(id: ConversationId, user: User) {
        return this.#adapters.currentChoice(id, user);
    }
    async #mcpCommand(id: ConversationId, user: User, text: string, requestId?: string) {
        return this.#adapters.mcpCommand(id, user, text, requestId);
    }
    async mcp(id: ConversationId, user: User, action: string, body?: unknown) {
        return this.#adapters.mcp(id, user, action, body);
    }
    async nativeSettings(id: ConversationId, user: User, patch?: Record<string, unknown>) {
        return this.#adapters.nativeSettings(id, user, patch);
    }

    async nativeExport(id: ConversationId, user: User, format: string) {
        return this.#export.nativeExport(id, user, format);
    }

    /** Explicit discovery is a non-inference native operation under the requesting member's lease. */
    async discoverCommands(id: ConversationId, user: User, requestId: string) {
        return this.#catalog.discoverCommands(id, user, requestId);
    }
    async #requireDynamicAdapter(id: ConversationId, user: User, name: string, requestId?: string) {
        return this.#catalog.requireDynamicAdapter(id, user, name, requestId);
    }
    #admitNativeCommand(command: { name: string; source?: unknown; args?: string }) {
        return this.#catalog.admitNativeCommand(command);
    }
    async #requireSupportedCommand(
        id: ConversationId,
        user: User,
        text: string,
        requestId?: string,
    ) {
        return this.#catalog.requireSupportedCommand(id, user, text, requestId);
    }
    async nativeCommands(id: ConversationId, user: User) {
        return this.#catalog.nativeCommands(id, user);
    }
    async nativeGoal(
        id: ConversationId,
        readEntries?: (segmentId: string) => Promise<KernelEntry[]>,
    ) {
        return this.#catalog.nativeGoal(id, readEntries);
    }

    async roomInfo(id: ConversationId) {
        return this.#room.roomInfo(id);
    }
    roomState(id: ConversationId, viewer: User) {
        return this.#room.roomState(id, viewer);
    }
    cutOff(id: ConversationId, latest: KernelReceipt | undefined) {
        return this.#room.cutOff(id, latest);
    }
    clientLive(id: ConversationId): ClientLive {
        return this.#room.clientLive(id);
    }

    /** Copy newly journaled entries into the conversation for display, once each, in journal order. */
    mirror(id: ConversationId): Promise<void> {
        return this.#mirror.mirror(id);
    }

    #request(
        id: ConversationId,
        user: User,
        requestId: string,
        requireReady = true,
        operation = "submit",
    ): string {
        return this.#requestDomain.request(id, user, requestId, requireReady, operation);
    }
    #forkIdentity(id: ConversationId, key: string, operation: string): Promise<void> {
        return this.#requestDomain.forkIdentity(id, key, operation);
    }

    async lookup(id: ConversationId, user: User, requestId: string, operation: string) {
        return this.#history.lookup(id, user, requestId, operation);
    }
    async #configure(
        id: ConversationId,
        user: User,
        requestId: string,
        expectedHead: string,
    ): Promise<{ receipt: ReceiptView | null }> {
        return this.#history.configure(id, user, requestId, expectedHead);
    }
    async #compact(
        id: ConversationId,
        user: User,
        requestId: string,
        instructions: string,
    ): Promise<ReceiptView> {
        return this.#history.compact(id, user, requestId, instructions);
    }
    async #fork(
        id: ConversationId,
        user: User,
        requestId: string,
        expectedHead: string,
        entryId?: string,
        clone?: boolean,
    ): Promise<{ id: ConversationId; receipt: ReceiptView | null }> {
        return this.#history.fork(id, user, requestId, expectedHead, entryId, clone);
    }
    async #upgradeKernel(
        id: ConversationId,
        user: User,
        observed?: SessionRecord,
    ): Promise<SessionRecord> {
        return this.#history.upgradeKernel(id, user, observed);
    }
    async #handoff(
        id: ConversationId,
        user: User,
        requestId: string,
        expectedHead: string,
        selected?: { model: ModelRef; thinkingLevel: ModelThinkingLevel },
    ): Promise<ReceiptView> {
        return this.#history.handoff(id, user, requestId, expectedHead, selected);
    }
    async #track(
        id: ConversationId,
        binding: KernelBinding,
        promise: Promise<KernelReceipt>,
    ): Promise<ReceiptView> {
        return this.#history.track(id, binding, promise);
    }

    async abort(id: ConversationId, user: User): Promise<void> {
        return this.#lifecycle.abort(id, user);
    }
    async revoke(): Promise<void> {
        return this.#lifecycle.revoke();
    }
    async warm(id: ConversationId, user: User): Promise<{ warmed: boolean }> {
        return this.#lifecycle.warm(id, user);
    }
    async resumeInterrupted(): Promise<void> {
        return this.#lifecycle.resumeInterrupted();
    }
    async close(): Promise<void> {
        return this.#lifecycle.close();
    }
}
