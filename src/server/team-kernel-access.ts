import type { ConversationId, ModelRef } from "@earendil-works/pi-durable";
import type { User } from "./config.ts";
import type { KernelBinding } from "./rotom-journal.ts";
import type { PocketApp } from "./app.ts";
import type { RotomExecutions } from "./rotom-executions.ts";
import type { ConfigurationSnapshot } from "./team-profiles.ts";
import type { SubmissionOwner } from "./team-kernel-submission.ts";
import type { NativeConfigurations } from "./team-kernel-docs.ts";
import { NATIVE_LAYERS } from "./team-kernel-docs.ts";
import { HttpError } from "./errors.ts";
import { verifyRotomKernel } from "./rotom-kernel.ts";
export type AccessOwner = SubmissionOwner & {
    app: PocketApp;
    executions: RotomExecutions;
    configurations: Map<ConversationId, NativeConfigurations>;
    ready: Set<ConversationId>;
    closing: { value: boolean };
    home: (memberId: string) => string;
};

export function createAccessDomain(owner: AccessOwner) {
    return {
        ref(binding: KernelBinding): ModelRef {
            // The complete personal alias includes the account generation; never parse/rekey a foreign credential.
            return { provider: binding.accountGeneration, modelId: binding.model };
        },
        /** Current head models for list views in one read, including in-place changes; no native startup/cache. */
        async modelNames(): Promise<ReadonlyMap<string, string>> {
            return owner.executions.journal.modelNames();
        },

        async configuration(id: ConversationId): Promise<ConfigurationSnapshot | undefined> {
            const { binding } = await owner.executions.journal.session(String(id));

            return this.snapshot(binding, id);
        },

        snapshot(binding: KernelBinding, id: ConversationId): ConfigurationSnapshot | undefined {
            if (binding.configurationDigest === NATIVE_LAYERS) {
                return undefined;
            }

            const snapshot = owner.configurations.get(id)?.snapshots[binding.configurationDigest];

            if (snapshot) {
                owner.app.profiles.verify(snapshot);

                return snapshot;
            }

            const initial = owner.app.profiles.snapshot(id);

            if (!initial || initial.digest !== binding.configurationDigest) {
                throw new HttpError(
                    409,
                    "Frozen native configuration is unavailable; restore its verified snapshot.",
                );
            }

            return initial;
        },

        async check(
            binding: KernelBinding,
            id: ConversationId,
            staged?: ConfigurationSnapshot,
        ): Promise<User> {
            const app = owner.app;

            if (
                owner.closing.value ||
                !owner.ready.has(id) ||
                app.sessionMeta(id)?.backend !== "rotom"
            ) {
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

            const model = app.accounts.kernelModel(user, owner.ref(binding));

            if (model.provider !== binding.provider) {
                throw new HttpError(409, "Personal provider binding changed.");
            }

            const configuration = staged ?? this.snapshot(binding, id);

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
        },

        binding(user: User, cwd: string, ref: ModelRef, thinkingLevel: string): KernelBinding {
            const model = owner.app.accounts.kernelModel(user, ref);
            const home = owner.home(user.id);

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
        },
    };
}

export type AccessDomain = ReturnType<typeof createAccessDomain>;
