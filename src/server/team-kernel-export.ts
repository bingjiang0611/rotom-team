import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { User } from "./config.ts";
import type { SubmissionOwner } from "./team-kernel-submission.ts";
import { nativeSessionManager, nativeSessionExports } from "./rotom-kernel.ts";
import { HttpError } from "./errors.ts";

export function createExportDomain(owner: SubmissionOwner) {
    return {
        async nativeExport(id: ConversationId, user: User, format: string) {
            owner.app.requireSee(user, id);

            if (format !== "jsonl" && format !== "html") {
                throw new HttpError(400, "Choose html or jsonl.");
            }

            const segment = await owner.executions.journal.session(String(id));

            if (segment.binding.memberId !== user.id) {
                throw new HttpError(
                    403,
                    "Raw native exports belong to the member who owns this segment.",
                );
            }

            if (await owner.executions.journal.pendingConversation(String(id))) {
                throw new HttpError(
                    409,
                    "Wait for the native operation to settle before exporting.",
                );
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
        },
    };
}
