import type { ConversationId, ModelRef } from "@earendil-works/pi-durable";
import type { User } from "./config.ts";
import type { PocketApp } from "./app.ts";
import type { AsyncRotomJournal, KernelBinding } from "./rotom-journal.ts";
import { RotomExecutions } from "./rotom-executions.ts";
import type { ConfigurationSnapshot } from "./team-profiles.ts";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { HttpError } from "./errors.ts";
import { NATIVE_LAYERS } from "./team-kernel-docs.ts";

export function createTeamExecutions(
    app: PocketApp,
    journal: AsyncRotomJournal | undefined,
    conversationId: (value: string) => ConversationId,
    check: (binding: KernelBinding, id: ConversationId) => Promise<User>,
    ref: (binding: KernelBinding) => ModelRef,
    readSnapshot: (binding: KernelBinding, id: ConversationId) => ConfigurationSnapshot | undefined,
    closing: () => boolean,
): RotomExecutions {
    return new RotomExecutions(
        app.dataDir,
        async (binding, operation, sessionId) => {
            const id = conversationId(sessionId);

            if (operation === "fork") {
                if (closing()) {
                    throw new HttpError(409, "Native execution is unavailable.");
                }

                const member = app.config.userById(binding.memberId);

                if (!member) {
                    throw new HttpError(403, "Membership ended.");
                }

                app.commands.requireForkable(id, member, "rotom");

                return;
            }

            const user = await check(binding, id);

            if (operation === "refresh") {
                throw new Error(
                    "Native OAuth refresh is disabled; the team credential store is the only writer",
                );
            }

            if (operation === "inference") {
                const auth = await app.accounts.kernelAuth(user, ref(binding));

                await check(binding, id);

                return auth;
            }
        },
        (binding, sessionId) => {
            const user = app.config.userById(binding.memberId)!;
            const model = app.accounts.kernelModel(user, ref(binding));
            const layered = binding.configurationDigest === NATIVE_LAYERS;
            const snapshot = layered ? undefined : readSnapshot(binding, conversationId(sessionId));

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
                        skills: snapshot.skills.map((skill: { path: string }) => skill.path),
                    },
                }),
            };
        },
        journal,
    );
}
