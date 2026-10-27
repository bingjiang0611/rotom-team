import type { ModelDomain } from "./team-kernel-model.ts";
import type { CatalogDomain } from "./team-kernel-catalog.ts";
import type { RuntimeDomain } from "./team-kernel-runtime.ts";
import type { LifecycleDomain } from "./team-kernel-lifecycle.ts";
import type { SubmissionDomain } from "./team-kernel-submission.ts";
import type { SubmissionOwner } from "./team-kernel-submission.ts";
import type { ModelOwner } from "./team-kernel-model.ts";
import type { HistoryOwner } from "./team-kernel-history.ts";
import type { AdapterOwner } from "./team-kernel-adapters.ts";
import type { CatalogOwner } from "./team-kernel-catalog.ts";
import type { RoomOwner } from "./team-kernel-room.ts";
import type { MirrorOwner } from "./team-kernel-mirror.ts";
import type { RuntimeOwner } from "./team-kernel-runtime.ts";
import type { RequestOwner } from "./team-kernel-request.ts";
import type { AccessOwner } from "./team-kernel-access.ts";
import type { SetupOwner } from "./team-kernel-setup.ts";
import type { LifecycleOwner } from "./team-kernel-lifecycle.ts";

export type KernelOwnerContext = SubmissionOwner &
    Omit<ModelOwner, keyof SubmissionOwner> &
    Omit<HistoryOwner, keyof SubmissionOwner | "check" | "submit"> &
    Omit<AdapterOwner, keyof SubmissionOwner> &
    Omit<CatalogOwner, keyof SubmissionOwner> &
    Omit<RoomOwner, keyof SubmissionOwner> &
    Omit<MirrorOwner, keyof SubmissionOwner> &
    Omit<RuntimeOwner, keyof SubmissionOwner | "submission" | "model"> &
    Omit<RequestOwner, keyof SubmissionOwner> &
    Omit<AccessOwner, keyof SubmissionOwner> &
    Omit<SetupOwner, keyof SubmissionOwner> &
    Omit<LifecycleOwner, keyof SubmissionOwner | "check" | "submit"> & {
        closing: { value: boolean };
        receipt: SubmissionOwner["receipt"];
        submitInternal: SubmissionOwner["submitInternal"];
        check: HistoryOwner["check"];
        submit: HistoryOwner["submit"];
        model: () => ModelDomain;
        submission: () => SubmissionDomain;
        catalog: () => CatalogDomain;
        runtime: () => RuntimeDomain;
        lifecycle: () => LifecycleDomain;
        commandSnapshot: RoomOwner["commandSnapshot"];
        observe: RuntimeOwner["observe"];
    };

export function createKernelOwners(context: KernelOwnerContext) {
    const submissionOwner: SubmissionOwner = {
        app: context.app,
        executions: context.executions,
        isRunning: (id) => context.isRunning(id),
        requireAccountIdle: (user) => context.requireAccountIdle(user),
        nativeGoal: (id, readEntries) => context.nativeGoal(id, readEntries),
        chooseModel: (id, user, body, requestId) => context.chooseModel(id, user, body, requestId),
        operation: (id, user, requestId, operation, identity, action) =>
            context.operation(id, user, requestId, operation, identity, action),
        admitNativeCommand: (command) => context.admitNativeCommand(command),
        currentChoice: (id, user) => context.currentChoice(id, user),
        ref: (binding) => context.ref(binding),
        request: (id, user, requestId, requireReady, operation) =>
            context.request(id, user, requestId, requireReady, operation),
        hooks: (id, onReserved) => context.hooks(id, onReserved),
        mcpCommand: (id, user, text, requestId) => context.mcpCommand(id, user, text, requestId),
        requireDynamicAdapter: (id, user, name, requestId) =>
            context.requireDynamicAdapter(id, user, name, requestId),
        requireSupportedCommand: (id, user, text, requestId) =>
            context.requireSupportedCommand(id, user, text, requestId),
        track: (id, binding, promise) => context.track(id, binding, promise),
        upgradeKernel: (id, user, observed) => context.upgradeKernel(id, user, observed),
        configure: (id, user, requestId, expectedHead) =>
            context.configure(id, user, requestId, expectedHead),
        compact: (id, user, requestId, instructions) =>
            context.compact(id, user, requestId, instructions),
        handoff: (id, user, requestId, expectedHead, selected) =>
            context.handoff(id, user, requestId, expectedHead, selected),
        fork: (id, user, requestId, expectedHead, entryId, clone) =>
            context.fork(id, user, requestId, expectedHead, entryId, clone),
        receipt: (receipt) => context.receipt(receipt),
        submitInternal: (id, user, requestId, text, wait, attachments) =>
            context.submitInternal(id, user, requestId, text, wait, attachments),
    };

    const modelOwner: ModelOwner = {
        ...submissionOwner,
        commands: context.commands,
        live: context.live,
    };

    const historyOwner: HistoryOwner = {
        ...submissionOwner,
        active: context.active,
        configurations: context.configurations,
        commands: context.commands,
        live: context.live,
        nativeGoals: context.nativeGoals,
        historicalGoals: context.historicalGoals,
        ready: context.ready,
        remoteStorage: context.remoteStorage,
        operations: context.operations,
        id: (value) => context.id(value),
        check: (binding, id, staged) => context.check(binding, id, staged),
        request: (id, user, requestId, requireReady, operation) =>
            context.request(id, user, requestId, requireReady, operation),
        forkIdentity: (id, key, operation) => context.forkIdentity(id, key, operation),
        mirror: (id) => context.mirror(id),
        submit: (id, user, requestId, text, wait, attachments) =>
            context.submit(id, user, requestId, text, wait, attachments),
        isRunning: (id) => context.isRunning(id),
    };

    const adapterOwner: AdapterOwner = {
        ...submissionOwner,
        live: context.live,
        commands: context.commands,
        active: context.active,
        home: (memberId) => context.home(memberId),
        mcp: context.mcp,
    };

    const catalogOwner: CatalogOwner = {
        ...submissionOwner,
        commands: context.commands,
        live: context.live,
        nativeGoals: context.nativeGoals,
        historicalGoals: context.historicalGoals,
        ready: context.ready,
    };

    const roomOwner: RoomOwner = {
        ...submissionOwner,
        live: context.live,
        commands: context.commands,
        ready: context.ready,
        branchedHistory: context.branchedHistory,
        mirrorHistoryLoaded: context.mirrorHistoryLoaded,
        mirrorCursors: context.mirrorCursors,
        agentInfo: (id, readEntries) => context.agentInfo(id, readEntries),
        commandSnapshot: (id, memberId, knownSession) =>
            context.catalog().commandSnapshot(id, memberId, knownSession),
        cutOff: (id, latest) => context.cutOff(id, latest),
    };

    const mirrorOwner: MirrorOwner = {
        ...submissionOwner,
        live: context.live,
        mirrorHistoryLoaded: context.mirrorHistoryLoaded,
        mirrorCursors: context.mirrorCursors,
        branchedHistory: context.branchedHistory,
        mirrors: context.mirrors,
    };

    const runtimeOwner: RuntimeOwner = {
        ...submissionOwner,
        get submission() {
            return context.submission();
        },
        get model() {
            return context.model();
        },
        executions: context.executions,
        live: context.live,
        commands: context.commands,
        nativeGoals: context.nativeGoals,
        ready: context.ready,
        configurations: context.configurations,
        mirror: (id) => context.mirror(id),
        observe: (id, event) => context.runtime().observe(id, event),
        operations: context.operations,
        forkIdentity: (id, key, operation) => context.forkIdentity(id, key, operation),
    };

    const requestOwner: RequestOwner = {
        ...submissionOwner,
        ready: context.ready,
        configurations: context.configurations,
    };

    const accessOwner: AccessOwner = {
        ...submissionOwner,
        configurations: context.configurations,
        ready: context.ready,
        closing: context.closing,
        home: (memberId) => context.home(memberId),
    };

    const setupOwner: SetupOwner = {
        ...submissionOwner,
        ready: context.ready,
        configurations: context.configurations,
        active: context.active,
        live: context.live,
        home: (memberId) => context.home(memberId),
        ensureBound: (id) => context.ensureBound(id),
        mirror: (id) => context.mirror(id),
    };

    const lifecycleOwner: LifecycleOwner = {
        ...submissionOwner,
        active: context.active,
        ready: context.ready,
        closing: context.closing,
        remoteStorage: context.remoteStorage,
        id: (value) => context.id(value),
        mcp: context.mcp,
        submit: (id, user, requestId, text, wait) =>
            context.submit(id, user, requestId, text, wait),
        resumeInterruptedImpl: () => context.lifecycle().resumeInterruptedImpl(),
        check: (binding, id) => context.check(binding, id),
    };

    return {
        submission: submissionOwner,
        model: modelOwner,
        history: historyOwner,
        adapters: adapterOwner,
        catalog: catalogOwner,
        room: roomOwner,
        mirror: mirrorOwner,
        runtime: runtimeOwner,
        request: requestOwner,
        access: accessOwner,
        setup: setupOwner,
        lifecycle: lifecycleOwner,
    };
}
