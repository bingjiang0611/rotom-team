/** Private execution receipts. RPC correlation IDs are not durable idempotency keys. */
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import {
    closeSync,
    existsSync,
    fsyncSync,
    lstatSync,
    openSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

// Reuse the hash-recorded Qoder reducer without requiring the optional installed kernel at module load.
const { creditSummary, CREDIT_ENTRY } = createRequire(import.meta.url)(
    "../../vendor/qoder/credits.mjs",
) as {
    CREDIT_ENTRY: string;
    creditSummary(
        entries: unknown[],
        sessionId: string,
    ): { credits: number | null; reported: number; unknown: number };
};

export type KernelBinding = {
    memberId: string;
    kernelVersion: string;
    accountGeneration: string;
    provider: string;
    model: string;
    thinkingLevel?: string;
    configurationDigest: string;
    home: string;
    workspace: string;
};
/** An in-place model change of the observed head segment. */
export type KernelRebind = { expectedHead: string; binding: KernelBinding };
/** A confirmed pre-dispatch identity conflict, not an uncertain external outcome. */
export class KernelRequestConflict extends Error {}

export type KernelOperation = "prompt" | "handoff" | "fork" | "compact" | "discover" | "command";
export type KernelFailure =
    "rpc-record-limit" | "rpc-timeout" | "rpc-disconnected" | "native-error";
export type KernelReceipt = {
    id: string;
    sessionId: string;
    segmentId: string;
    operation: KernelOperation;
    requestId: string;
    /** `interrupted` is retained for legacy records; it is not proof of a safe outcome or recovery. */
    status: "dispatch-intent" | "settled" | "handled" | "rejected" | "unknown" | "interrupted";
    binding: KernelBinding;
    /** Absent on legacy attempts: do not infer restart eligibility from a dead PID alone. */
    phase?: "execution" | "finalization";
    /** Bounded diagnostic code, never raw provider output or credentials. */
    failure?: KernelFailure;
    /** A queued native command crossed dispatch without a confirmed handled outcome. */
    unresolvedCommandInput?: true;
};
/** How many automatic continuations may follow one another before a person has to say Continue. */
export const MAX_RESUME_CHAIN = 3;
/** A prompt cut off by a server stop: `pending` resumes at startup, `capped` waits for a person. */
export type KernelResume = {
    attemptId: string;
    sessionId: string;
    chain: number;
    state: "pending" | "started" | "capped" | "skipped";
};
export type KernelEntry = { type: string; id?: string; [key: string]: unknown };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Disabling the executable backend is not permission to bypass its persisted account fence. */
export function requireNoPendingKernel(data: string): void {
    const path = join(data, "kernel.sqlite");

    if (!existsSync(path)) {
        return;
    }

    if (!lstatSync(path).isFile() || realpathSync(path) !== path) {
        throw new Error("Kernel journal must be canonical and regular");
    }

    const db = new DatabaseSync(path, { readOnly: true });

    try {
        if (
            ![1, 2, 3, 4, 5, 6].includes(
                Number(db.prepare("PRAGMA user_version").get()!.user_version),
            )
        ) {
            throw new Error("Unsupported kernel journal version");
        }

        if (
            db
                .prepare(
                    "SELECT id FROM kernel_attempts WHERE status IN ('dispatch-intent','unknown') LIMIT 1",
                )
                .get()
        ) {
            throw new Error(
                "Cannot disable rotom while a native dispatch is pending or unknown; reconcile it with the backend enabled",
            );
        }
    } finally {
        db.close();
    }
}

export class RotomJournal {
    readonly #db: DatabaseSync;
    readonly #lock: string;
    readonly #data: string;
    #closed = false;
    constructor(data: string) {
        if (
            realpathSync(data) !== data ||
            !lstatSync(data).isDirectory() ||
            lstatSync(data).mode & 0o077
        ) {
            throw new Error("Kernel journal directory must be canonical and private");
        }

        this.#data = data;
        this.#lock = join(data, "kernel.lock");
        // Never break a stale parent lock: its kernel/tool descendants may still be executing.
        const fd = openSync(this.#lock, "wx", 0o600);

        try {
            writeFileSync(fd, `${process.pid}\n`);
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }

        let opened: DatabaseSync | undefined;

        try {
            const harnessLock = join(data, "harness.lock");

            if (
                existsSync(harnessLock) &&
                Number(readFileSync(harnessLock, "utf8")) !== process.pid
            ) {
                throw new Error("Another app writer or offline backup owns this data directory");
            }

            const path = join(data, "kernel.sqlite");

            for (const file of [path, `${path}-wal`, `${path}-shm`]) {
                if (existsSync(file) && !lstatSync(file).isFile()) {
                    throw new Error("Kernel database must be a regular file");
                }
            }

            if (!existsSync(path)) {
                closeSync(openSync(path, "wx", 0o600));
            }

            this.#db = opened = new DatabaseSync(path);
            const version = Number(this.#db.prepare("PRAGMA user_version").get()!.user_version);

            if (![0, 1, 2, 3, 4, 5, 6].includes(version)) {
                throw new Error("Unsupported kernel journal version");
            }

            this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
                CREATE TABLE IF NOT EXISTS kernel_sessions (id TEXT PRIMARY KEY, binding TEXT NOT NULL, session_file TEXT, kernel_session_id TEXT);
                CREATE TABLE IF NOT EXISTS kernel_attempts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES kernel_sessions(id), request_id TEXT NOT NULL, prompt_hash TEXT NOT NULL, binding TEXT NOT NULL, home TEXT NOT NULL, status TEXT NOT NULL, UNIQUE(session_id, request_id));
                CREATE TABLE IF NOT EXISTS kernel_entries (kernel_session_id TEXT NOT NULL, entry_id TEXT NOT NULL, session_id TEXT NOT NULL, attempt_id TEXT NOT NULL REFERENCES kernel_attempts(id), body TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(kernel_session_id,entry_id));
                CREATE TABLE IF NOT EXISTS kernel_usage (kernel_session_id TEXT NOT NULL, entry_id TEXT NOT NULL, attempt_id TEXT NOT NULL, member_id TEXT NOT NULL, raw_usage TEXT, PRIMARY KEY(kernel_session_id,entry_id), FOREIGN KEY(kernel_session_id,entry_id) REFERENCES kernel_entries(kernel_session_id,entry_id));`);

            if (version < 2) {
                this.#db.exec(`BEGIN IMMEDIATE;
                    ALTER TABLE kernel_sessions ADD COLUMN conversation_id TEXT;
                    ALTER TABLE kernel_sessions ADD COLUMN parent_segment_id TEXT;
                    UPDATE kernel_sessions SET conversation_id=id;
                    ALTER TABLE kernel_attempts ADD COLUMN conversation_id TEXT;
                    ALTER TABLE kernel_attempts ADD COLUMN operation TEXT NOT NULL DEFAULT 'prompt';
                    UPDATE kernel_attempts SET conversation_id=session_id;
                    CREATE TABLE kernel_heads (conversation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES kernel_sessions(id));
                    INSERT INTO kernel_heads SELECT id,id FROM kernel_sessions;
                    CREATE UNIQUE INDEX one_conversation_request ON kernel_attempts(conversation_id,request_id);
                    CREATE UNIQUE INDEX one_conversation_writer ON kernel_attempts(conversation_id) WHERE status IN ('dispatch-intent','unknown');
                    PRAGMA user_version=2; COMMIT;`);
            }

            if (version < 3) {
                this.#db.exec(`BEGIN IMMEDIATE;
                    ALTER TABLE kernel_attempts ADD COLUMN pid INTEGER;
                    CREATE TABLE kernel_resume (attempt_id TEXT PRIMARY KEY REFERENCES kernel_attempts(id), conversation_id TEXT NOT NULL, chain INTEGER NOT NULL, state TEXT NOT NULL);
                    PRAGMA user_version=3; COMMIT;`);
            }

            // Usage a run's subagents reported through its gate. Their entries live in their own sessions, not this one.
            if (version < 4) {
                this.#db.exec(`BEGIN IMMEDIATE;
                    CREATE TABLE kernel_child_usage (attempt_id TEXT NOT NULL REFERENCES kernel_attempts(id), member_id TEXT NOT NULL, raw_usage TEXT NOT NULL);
                    PRAGMA user_version=4; COMMIT;`);
            }

            // Keep queued command uncertainty on the existing attempt; never reclassify its original intent.
            if (version < 5) {
                this.#db.exec(`BEGIN IMMEDIATE;
                    CREATE TABLE kernel_command_inputs (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE REFERENCES kernel_attempts(id), command_hash TEXT NOT NULL);
                    PRAGMA user_version=5; COMMIT;`);
            }

            if (version < 6) {
                this.#db.exec(`BEGIN IMMEDIATE;
                    ALTER TABLE kernel_attempts ADD COLUMN phase TEXT;
                    ALTER TABLE kernel_attempts ADD COLUMN failure TEXT;
                    PRAGMA user_version=6; COMMIT;`);
            }

            // One member may run several sessions at once; each conversation keeps its own single writer.
            this.#db.exec("DROP INDEX IF EXISTS one_kernel_writer");
            // The paying member's current model; kernel_sessions.binding stays the immutable identity anchor.
            // Unversioned on purpose: an older release ignores it and still opens this journal after a rollback.
            this.#db.exec(
                "CREATE TABLE IF NOT EXISTS kernel_segment_models (segment_id TEXT PRIMARY KEY REFERENCES kernel_sessions(id), binding TEXT NOT NULL)",
            );

            // A cleanly released parent lock is not evidence that an unfinished dispatch never happened.
            this.#db.exec(
                "UPDATE kernel_attempts SET status='unknown' WHERE status='dispatch-intent'",
            );
        } catch (error) {
            opened?.close();
            rmSync(this.#lock);

            throw error;
        }
    }

    bind(sessionId: string, binding: KernelBinding): void {
        if (!sessionId || sessionId.length > 128) {
            throw new Error("Invalid team session identity");
        }

        const normalized = this.#binding(binding);
        const existing = this.#db
            .prepare("SELECT binding FROM kernel_sessions WHERE id=?")
            .get(sessionId);

        if (existing) {
            if (existing.binding !== JSON.stringify(normalized)) {
                throw new Error(
                    "Kernel session identity is immutable; takeover requires an explicit public-history import",
                );
            }

            return;
        }

        this.#db.exec("BEGIN IMMEDIATE");

        try {
            this.#db
                .prepare("INSERT INTO kernel_sessions(id,binding,conversation_id) VALUES (?,?,?)")
                .run(sessionId, JSON.stringify(normalized), sessionId);
            this.#db.prepare("INSERT INTO kernel_heads VALUES (?,?)").run(sessionId, sessionId);
            this.#db.exec("COMMIT");
        } catch (error) {
            this.#db.exec("ROLLBACK");

            throw error;
        }
    }

    #binding(binding: KernelBinding): KernelBinding {
        const {
            memberId,
            kernelVersion,
            accountGeneration,
            provider,
            model,
            configurationDigest,
            home,
            workspace,
        } = binding;

        for (const value of [
            memberId,
            kernelVersion,
            accountGeneration,
            provider,
            model,
            configurationDigest,
        ]) {
            if (typeof value !== "string" || !value || value.length > 256) {
                throw new Error("Invalid kernel execution identity");
            }
        }

        if (
            !/^[a-zA-Z0-9_-]{1,128}$/.test(memberId) ||
            home !== join(this.#data, "kernel-homes", memberId)
        ) {
            throw new Error(
                "Kernel HOME must belong to this deployment member, never an imported personal HOME",
            );
        }

        for (const path of [home, workspace]) {
            if (realpathSync(path) !== path || !lstatSync(path).isDirectory()) {
                throw new Error("Kernel binding paths must be canonical directories");
            }
        }

        if (lstatSync(home).mode & 0o077) {
            throw new Error("Kernel HOME must be private");
        }

        if (
            binding.thinkingLevel !== undefined &&
            !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
                binding.thinkingLevel,
            )
        ) {
            throw new Error("Invalid kernel thinking level");
        }

        return {
            memberId,
            kernelVersion,
            accountGeneration,
            provider,
            model,
            configurationDigest,
            home,
            workspace,
            ...(binding.thinkingLevel === undefined
                ? {}
                : { thinkingLevel: binding.thinkingLevel }),
        };
    }

    hasConversation(id: string): boolean {
        return (
            this.#db.prepare("SELECT 1 FROM kernel_heads WHERE conversation_id=?").get(id) !==
            undefined
        );
    }

    /** Startup only, against the app's complete committed native-session set. Never discard execution evidence. */
    reconcileOrphans(known: ReadonlySet<string>): void {
        const orphans = this.#db
            .prepare("SELECT conversation_id FROM kernel_heads")
            .all()
            .map((row) => String(row.conversation_id))
            .filter((id) => !known.has(id));

        this.#db.exec("BEGIN IMMEDIATE");

        try {
            for (const id of orphans) {
                const attempts = this.#db
                    .prepare("SELECT 1 FROM kernel_attempts WHERE conversation_id=? LIMIT 1")
                    .get(id);
                const segments = this.#db
                    .prepare("SELECT id,session_file FROM kernel_sessions WHERE conversation_id=?")
                    .all(id);

                if (
                    attempts ||
                    segments.length !== 1 ||
                    segments[0]!.id !== id ||
                    segments[0]!.session_file !== null
                ) {
                    throw new Error(
                        "Native execution exists without application metadata; restore/reconcile metadata before starting, never replay it",
                    );
                }

                this.#db.prepare("DELETE FROM kernel_heads WHERE conversation_id=?").run(id);
                this.#db.prepare("DELETE FROM kernel_segment_models WHERE segment_id=?").run(id);
                this.#db.prepare("DELETE FROM kernel_sessions WHERE id=?").run(id);
            }

            this.#db.exec("COMMIT");
        } catch (error) {
            this.#db.exec("ROLLBACK");

            throw error;
        }
    }

    session(id: string) {
        const head = this.#db
            .prepare("SELECT session_id FROM kernel_heads WHERE conversation_id=?")
            .get(id);

        if (!head) {
            throw new Error("Unknown kernel session");
        }

        return this.segment(String(head.session_id));
    }

    /** One fresh projection read: absence is expected during setup, but a dangling head remains corruption. */
    sessionIfPresent(id: string) {
        const row = this.#db
            .prepare(
                "SELECT h.session_id,s.binding,s.session_file,s.kernel_session_id,m.binding AS model_binding FROM kernel_heads h LEFT JOIN kernel_sessions s ON s.id=h.session_id LEFT JOIN kernel_segment_models m ON m.segment_id=s.id WHERE h.conversation_id=?",
            )
            .get(id);

        if (!row) {
            return undefined;
        }

        if (row.binding === null) {
            throw new Error("Unknown kernel session");
        }

        return this.#segment(row, String(row.session_id));
    }

    segment(id: string): {
        segmentId: string;
        binding: KernelBinding;
        sessionFile?: string;
        kernelSessionId?: string;
    } {
        const row = this.#db
            .prepare(
                "SELECT s.*,m.binding AS model_binding FROM kernel_sessions s LEFT JOIN kernel_segment_models m ON m.segment_id=s.id WHERE s.id=?",
            )
            .get(id);

        if (!row) {
            throw new Error("Unknown kernel session");
        }

        return this.#segment(row, id);
    }

    #segment(
        row: Record<string, SQLOutputValue>,
        id: string,
    ): {
        segmentId: string;
        binding: KernelBinding;
        sessionFile?: string;
        kernelSessionId?: string;
    } {
        return {
            segmentId: id,
            binding: JSON.parse(String(row.model_binding ?? row.binding)),
            ...(row.session_file
                ? {
                      sessionFile: String(row.session_file),
                      kernelSessionId: String(row.kernel_session_id),
                  }
                : {}),
        };
    }

    receipt(id: string): KernelReceipt {
        const row = this.#db.prepare("SELECT * FROM kernel_attempts WHERE id=?").get(id);

        if (!row) {
            throw new Error("Unknown kernel receipt");
        }

        return this.#receipt(row);
    }

    #receipt(row: Record<string, SQLOutputValue>): KernelReceipt {
        const id = String(row.id);

        return {
            id,
            sessionId: String(row.conversation_id),
            segmentId: String(row.session_id),
            operation: row.operation as KernelOperation,
            ...(row.phase ? { phase: String(row.phase) as KernelReceipt["phase"] } : {}),
            ...(row.failure ? { failure: String(row.failure) as KernelFailure } : {}),
            requestId: String(row.request_id),
            status: row.status as KernelReceipt["status"],
            binding: JSON.parse(String(row.binding)),
            ...(this.hasUnresolvedCommandInput(id)
                ? { unresolvedCommandInput: true as const }
                : {}),
        };
    }

    /** Durable before queued side-effect dispatch; only a confirmed handled response clears this fence. */
    beginCommandInput(attemptId: string, command: string): string {
        if (
            this.receipt(attemptId).status !== "dispatch-intent" ||
            this.hasUnresolvedCommandInput(attemptId)
        ) {
            throw new KernelRequestConflict(
                "The owning attempt is finished or has an unresolved queued command",
            );
        }

        const id = randomUUID();

        this.#db
            .prepare("INSERT INTO kernel_command_inputs VALUES (?,?,?)")
            .run(id, attemptId, digest(command));

        return id;
    }

    completeCommandInput(id: string): void {
        this.#db.prepare("DELETE FROM kernel_command_inputs WHERE id=?").run(id);
    }

    hasUnresolvedCommandInput(attemptId: string): boolean {
        return Boolean(
            this.#db
                .prepare("SELECT id FROM kernel_command_inputs WHERE attempt_id=?")
                .get(attemptId),
        );
    }

    request(sessionId: string, requestId: string): KernelReceipt | undefined {
        const row = this.#db
            .prepare("SELECT id FROM kernel_attempts WHERE conversation_id=? AND request_id=?")
            .get(sessionId, requestId);

        return row ? this.receipt(String(row.id)) : undefined;
    }

    existing(
        sessionId: string,
        requestId: string,
        prompt: string,
        operation: KernelOperation = "prompt",
    ): KernelReceipt | undefined {
        const row = this.#db
            .prepare(
                "SELECT id,prompt_hash,operation FROM kernel_attempts WHERE conversation_id=? AND request_id=?",
            )
            .get(sessionId, requestId);

        if (!row) {
            return undefined;
        }

        // Slash expansions are conservatively reserved as commands until the native registry identifies
        // a prompt template or skill. Legacy slash receipts also remain readable without rewriting history.
        const expansion = operation === "command" && row.operation === "prompt";

        if (row.prompt_hash !== digest(prompt) || (row.operation !== operation && !expansion)) {
            throw new KernelRequestConflict(
                "Request identity cannot be reused with different content",
            );
        }

        return this.receipt(String(row.id));
    }

    reserve(
        sessionId: string,
        requestId: string,
        prompt: string,
        operation: "prompt" | "compact" | "fork" | "discover" | "command" = "prompt",
        rebind?: KernelRebind,
    ): KernelReceipt {
        const existing = this.existing(sessionId, requestId, prompt, operation);

        if (existing) {
            return existing;
        }

        if (!requestId || requestId.length > 128) {
            throw new Error("Invalid request identity");
        }

        if (rebind) {
            return this.#rebind(sessionId, requestId, prompt, rebind);
        }

        const { binding, segmentId, sessionFile } = this.session(sessionId);

        if (operation === "fork" && sessionFile) {
            throw new Error("Fork seed requires a fresh native segment");
        }

        this.#unblocked(sessionId);

        return this.#intent(sessionId, segmentId, requestId, prompt, binding, operation);
    }

    /**
     * The same payer keeps its native session across a model change: the head segment's current model changes with the
     * command's intent in one commit. Its original binding remains the identity anchor; earlier attempts keep their
     * own binding snapshots for validation and usage.
     */
    #rebind(
        sessionId: string,
        requestId: string,
        prompt: string,
        { expectedHead, binding }: KernelRebind,
    ): KernelReceipt {
        const normalized = this.#binding(binding);

        this.#db.exec("BEGIN IMMEDIATE");

        try {
            const head = this.session(sessionId);

            if (head.segmentId !== expectedHead) {
                throw new KernelRequestConflict(
                    "Conversation head changed; refresh before switching the model",
                );
            }

            for (const key of [
                "memberId",
                "kernelVersion",
                "configurationDigest",
                "home",
                "workspace",
            ] as const) {
                if (head.binding[key] !== normalized[key]) {
                    throw new KernelRequestConflict(
                        "Only the paying member's model can change in place; anything else hands off",
                    );
                }
            }

            this.#unblocked(sessionId);
            this.#db
                .prepare(
                    "INSERT INTO kernel_segment_models VALUES (?,?) ON CONFLICT(segment_id) DO UPDATE SET binding=excluded.binding",
                )
                .run(expectedHead, JSON.stringify(normalized));
            const receipt = this.#intent(
                sessionId,
                expectedHead,
                requestId,
                prompt,
                normalized,
                "command",
            );

            this.#db.exec("COMMIT");

            return receipt;
        } catch (error) {
            this.#db.exec("ROLLBACK");

            throw error;
        }
    }

    /** Only authoritative native prompt/skill discovery may make a reserved slash eligible for prompt recovery. */
    classifyPromptExpansion(id: string): void {
        const result = this.#db
            .prepare(
                "UPDATE kernel_attempts SET operation='prompt' WHERE id=? AND operation='command' AND status='dispatch-intent'",
            )
            .run(id);

        if (result.changes !== 1) {
            throw new Error("Only an undispatched native command may become a prompt expansion");
        }
    }

    /** Keep the old head until a new immutable segment's public seed is committed. */
    handoff(
        sessionId: string,
        requestId: string,
        expectedHead: string,
        binding: KernelBinding,
    ): KernelReceipt {
        const normalized = this.#binding(binding);
        const identity = JSON.stringify({ expectedHead, binding: normalized });
        const existing = this.existing(sessionId, requestId, identity, "handoff");

        if (existing) {
            return existing;
        }

        if (!requestId || requestId.length > 128) {
            throw new Error("Invalid request identity");
        }

        this.#db.exec("BEGIN IMMEDIATE");

        try {
            if (this.session(sessionId).segmentId !== expectedHead) {
                throw new KernelRequestConflict(
                    "Conversation head changed; refresh before handoff",
                );
            }

            this.#unblocked(sessionId);
            const segmentId = randomUUID();

            this.#db
                .prepare(
                    "INSERT INTO kernel_sessions(id,binding,conversation_id,parent_segment_id) VALUES (?,?,?,?)",
                )
                .run(segmentId, JSON.stringify(normalized), sessionId, expectedHead);
            const receipt = this.#intent(
                sessionId,
                segmentId,
                requestId,
                identity,
                normalized,
                "handoff",
            );

            this.#db.exec("COMMIT");

            return receipt;
        } catch (error) {
            this.#db.exec("ROLLBACK");

            throw error;
        }
    }

    #unblocked(sessionId: string): void {
        const blocked = this.#db
            .prepare(
                "SELECT id FROM kernel_attempts WHERE conversation_id=? AND status IN ('dispatch-intent','unknown')",
            )
            .get(sessionId);

        if (blocked) {
            throw new KernelRequestConflict(
                "This session has a running or unknown attempt; reconcile it before any new dispatch",
            );
        }
    }

    #intent(
        sessionId: string,
        segmentId: string,
        requestId: string,
        prompt: string,
        binding: KernelBinding,
        operation: KernelOperation,
    ): KernelReceipt {
        const id = randomUUID();

        // Synchronous FULL SQLite commit completes before any child launch or stdin send.
        this.#db
            .prepare(
                "INSERT INTO kernel_attempts(id,session_id,request_id,prompt_hash,binding,home,status,conversation_id,operation,phase) VALUES (?,?,?,?,?,?,'dispatch-intent',?,?,'execution')",
            )
            .run(
                id,
                segmentId,
                requestId,
                digest(prompt),
                JSON.stringify(binding),
                binding.home,
                sessionId,
                operation,
            );

        return this.receipt(id);
    }

    attach(id: string, sessionFile: string, kernelSessionId: string, pid?: number): void {
        const receipt = this.receipt(id),
            session = this.segment(receipt.segmentId);

        if (receipt.status !== "dispatch-intent") {
            throw new Error("Attempt is not active");
        }

        if (
            session.sessionFile &&
            (session.sessionFile !== sessionFile || session.kernelSessionId !== kernelSessionId)
        ) {
            throw new Error("Kernel session changed unexpectedly");
        }

        this.#db
            .prepare("UPDATE kernel_sessions SET session_file=?,kernel_session_id=? WHERE id=?")
            .run(sessionFile, kernelSessionId, receipt.segmentId);

        if (pid !== undefined) {
            // PID is diagnostic evidence only; a dead process never authorizes replay of an unknown run.
            this.#db.prepare("UPDATE kernel_attempts SET pid=? WHERE id=?").run(pid, id);
        }
    }

    /** Persist the completion boundary before readback; a crash here must not start another model turn. */
    setPhase(id: string, phase: "execution" | "finalization"): void {
        this.#db
            .prepare("UPDATE kernel_attempts SET phase=? WHERE id=? AND status='dispatch-intent'")
            .run(phase, id);
    }

    recordFailure(id: string, failure: KernelFailure): void {
        this.#db
            .prepare(
                "UPDATE kernel_attempts SET failure=COALESCE(failure,?) WHERE id=? AND status='dispatch-intent'",
            )
            .run(failure, id);
    }

    /** Eligibility for planning a clean stop; startup additionally requires an already settled receipt. */
    canResume(id: string): boolean {
        const attempt = this.receipt(id);

        return (
            attempt.operation === "prompt" &&
            ["dispatch-intent", "settled"].includes(attempt.status) &&
            (attempt.phase === "execution" ||
                (attempt.phase === undefined && attempt.status === "settled")) &&
            attempt.failure !== "rpc-record-limit" &&
            !attempt.unresolvedCommandInput
        );
    }

    /**
     * Plan the continuation of a prompt cut off by a server stop. A continuation of a continuation counts up; past
     * MAX_RESUME_CHAIN it waits for a person instead. Planning the same attempt twice keeps the first plan.
     */
    planResume(attemptId: string): KernelResume {
        const attempt = this.receipt(attemptId);

        if (!this.canResume(attemptId)) {
            throw new Error(
                "An unresolved command, unknown/interrupted outcome, unproven phase, finalization or size-limit failure cannot be resumed",
            );
        }

        const previous = /:#resume-(.+)$/.exec(attempt.requestId)?.[1];
        const chain = previous ? (this.resume(previous)?.chain ?? 0) + 1 : 1;

        this.#db
            .prepare("INSERT OR IGNORE INTO kernel_resume VALUES (?,?,?,?)")
            .run(
                attemptId,
                attempt.sessionId,
                chain,
                chain > MAX_RESUME_CHAIN ? "capped" : "pending",
            );

        return this.resume(attemptId)!;
    }

    resume(attemptId: string): KernelResume | undefined {
        const row = this.#db
            .prepare("SELECT * FROM kernel_resume WHERE attempt_id=?")
            .get(attemptId);

        return row
            ? {
                  attemptId,
                  sessionId: String(row.conversation_id),
                  chain: Number(row.chain),
                  state: row.state as KernelResume["state"],
              }
            : undefined;
    }

    resumes(state: KernelResume["state"]): KernelResume[] {
        return this.#db
            .prepare("SELECT attempt_id FROM kernel_resume WHERE state=? ORDER BY rowid")
            .all(state)
            .map((row) => this.resume(String(row.attempt_id))!);
    }

    markResume(attemptId: string, state: "started" | "skipped"): void {
        this.#db
            .prepare("UPDATE kernel_resume SET state=? WHERE attempt_id=?")
            .run(state, attemptId);
    }

    /** The conversation's newest attempt, whatever its operation. */
    latest(sessionId: string): KernelReceipt | undefined {
        const row = this.#db
            .prepare(
                "SELECT * FROM kernel_attempts WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1",
            )
            .get(sessionId);

        return row ? this.#receipt(row) : undefined;
    }

    /** Thinking is mutable native session state; the receipt binding retains its initial value. */
    thinkingLevel(sessionId: string): string {
        const { segmentId, binding } = this.session(sessionId);
        const entries = this.segmentEntries(segmentId);
        const byId = new Map(entries.map((entry) => [entry.id, entry]));
        let entry = entries.at(-1);

        while (entry) {
            if (entry.type === "thinking_level_change") {
                return String(entry.thinkingLevel);
            }

            // A model switch restarts Pi, which clamps silently; the binding holds that clamped level.
            if (entry.type === "model_change") {
                break;
            }

            entry = typeof entry.parentId === "string" ? byId.get(entry.parentId) : undefined;
        }

        return binding.thinkingLevel ?? "off";
    }

    /** Provisional ingestion while a prompt runs: records each persisted message once, never settles the attempt. */
    progress(id: string, entries: KernelEntry[]): number {
        const attempt = this.receipt(id),
            session = this.segment(attempt.segmentId);

        if (
            attempt.status !== "dispatch-intent" ||
            !["prompt", "command"].includes(attempt.operation)
        ) {
            throw new Error("Attempt is not an active prompt");
        }

        if (!session.kernelSessionId) {
            throw new Error("Missing kernel session binding");
        }

        this.#db.exec("BEGIN IMMEDIATE");

        try {
            const added = this.#ingest(attempt, session.kernelSessionId, entries);

            this.#db.exec("COMMIT");

            return added;
        } catch (error) {
            this.#db.exec("ROLLBACK");

            throw error;
        }
    }

    finish(id: string, status: "settled" | "handled", entries: KernelEntry[]): KernelReceipt {
        if (this.hasUnresolvedCommandInput(id)) {
            throw new Error("Queued native command outcome is unresolved");
        }

        const attempt = this.receipt(id),
            session = this.segment(attempt.segmentId);

        if (attempt.status !== "dispatch-intent") {
            throw new Error("Attempt is not active");
        }

        const seed = attempt.operation === "handoff" || attempt.operation === "fork";

        if (!session.kernelSessionId && !(seed && entries.length === 0)) {
            throw new Error("Missing kernel session binding");
        }

        this.#db.exec("BEGIN IMMEDIATE");

        try {
            if (session.kernelSessionId) {
                this.#ingest(attempt, session.kernelSessionId, entries);
            }

            if (status === "settled" && !seed && !this.#terminal(attempt)) {
                throw new Error(
                    "Settled event has no new persisted terminal response; outcome remains unknown",
                );
            }

            if (status === "handled" && entries.length === 0) {
                // A fresh extension-handled prompt may never create JSONL. Keep its receipt, not a nonexistent resume path.
                this.#forgetUnmaterialized(attempt.segmentId);
            }

            if (attempt.operation === "handoff") {
                if (status !== "settled") {
                    throw new Error("Handoff requires a committed public seed");
                }

                const target = this.#db
                    .prepare("SELECT parent_segment_id FROM kernel_sessions WHERE id=?")
                    .get(attempt.segmentId)!;
                const changed = this.#db
                    .prepare(
                        "UPDATE kernel_heads SET session_id=? WHERE conversation_id=? AND session_id=?",
                    )
                    .run(attempt.segmentId, attempt.sessionId, target.parent_segment_id!);

                if (changed.changes !== 1) {
                    throw new Error("Conversation head changed during handoff");
                }
            }

            this.#db.prepare("UPDATE kernel_attempts SET status=? WHERE id=?").run(status, id);
            this.#db.exec("COMMIT");
        } catch (error) {
            this.#db.exec("ROLLBACK");

            throw error;
        }

        return this.receipt(id);
    }

    /** Record new native entries of one snapshot for an attempt. Callers hold a write transaction. */
    #ingest(attempt: KernelReceipt, kernelSessionId: string, entries: KernelEntry[]): number {
        const seen = new Set<string>();
        const seed = attempt.operation === "handoff" || attempt.operation === "fork";
        let added = 0;

        for (const entry of entries) {
            if (entry.type === "session") {
                continue;
            }

            if (typeof entry.id !== "string" || !entry.id) {
                throw new Error("Missing native entry identity");
            }

            if (seen.has(entry.id)) {
                throw new Error("Duplicate native entry in one snapshot");
            }

            seen.add(entry.id);
            const body = JSON.stringify(entry),
                hash = digest(body);
            const previous = this.#db
                .prepare(
                    "SELECT digest FROM kernel_entries WHERE kernel_session_id=? AND entry_id=?",
                )
                .get(kernelSessionId, entry.id);

            if (previous) {
                if (previous.digest !== hash) {
                    throw new Error("Native entry changed after ingestion");
                }

                continue;
            }

            this.#db
                .prepare("INSERT INTO kernel_entries VALUES (?,?,?,?,?,?)")
                .run(kernelSessionId, entry.id, attempt.segmentId, attempt.id, body, hash);
            added++;

            // Inherited context is not a new invocation by the receiving payer.
            if (seed) {
                continue;
            }

            if (entry.type === "compaction") {
                if (
                    typeof entry.summary !== "string" ||
                    !entry.summary.trim() ||
                    (entry.firstKeptEntryId !== null &&
                        !this.#db
                            .prepare(
                                "SELECT 1 FROM kernel_entries WHERE kernel_session_id=? AND entry_id=?",
                            )
                            .get(kernelSessionId, String(entry.firstKeptEntryId)))
                ) {
                    throw new Error("Invalid persisted compaction");
                }

                this.#db
                    .prepare("INSERT INTO kernel_usage VALUES (?,?,?,?,?)")
                    .run(
                        kernelSessionId,
                        entry.id,
                        attempt.id,
                        attempt.binding.memberId,
                        entry.usage ? JSON.stringify(entry.usage) : null,
                    );
            }

            if (attempt.operation === "command" && entry.type === "branch_summary") {
                if (typeof entry.summary !== "string" || !entry.summary.trim()) {
                    throw new Error("Invalid persisted native branch summary");
                }

                this.#db
                    .prepare("INSERT INTO kernel_usage VALUES (?,?,?,?,?)")
                    .run(
                        kernelSessionId,
                        entry.id,
                        attempt.id,
                        attempt.binding.memberId,
                        entry.usage ? JSON.stringify(entry.usage) : null,
                    );
            }

            // Native auxiliary inference (for example SoL-Pi reduction) records usage outside assistant messages.
            const message = (entry.type === "usage" ? entry : entry.message) as
                { role?: string; provider?: string; model?: string; usage?: unknown } | undefined;

            if (
                entry.type === "usage" ||
                (entry.type === "message" && message?.role === "assistant")
            ) {
                if (
                    message?.provider !== attempt.binding.provider ||
                    message?.model !== attempt.binding.model
                ) {
                    throw new Error("Native response model does not match admitted payer/model");
                }

                // Preserve raw kernel usage. Pi's zero placeholders do not establish reported cost/credits.
                this.#db
                    .prepare("INSERT INTO kernel_usage VALUES (?,?,?,?,?)")
                    .run(
                        kernelSessionId,
                        entry.id,
                        attempt.id,
                        attempt.binding.memberId,
                        message.usage ? JSON.stringify(message.usage) : null,
                    );
            }
        }

        return added;
    }

    /** Whether everything this attempt recorded ends in a terminal response: across progress and finish snapshots. */
    #terminal(attempt: KernelReceipt): boolean {
        let terminal = false;

        for (const row of this.#db
            .prepare("SELECT body FROM kernel_entries WHERE attempt_id=? ORDER BY rowid")
            .all(attempt.id)) {
            const entry = JSON.parse(String(row.body)) as KernelEntry;
            const message = entry.message as { role?: string; stopReason?: string } | undefined;

            if (attempt.operation === "compact" && entry.type === "compaction") {
                terminal = true;
            }

            if (entry.type === "message" && message?.role === "user") {
                terminal = false;
            }

            if (entry.type === "message" && message?.role === "assistant") {
                terminal =
                    ["prompt", "command"].includes(attempt.operation) &&
                    ["stop", "error", "aborted", "length"].includes(String(message.stopReason));
            }
        }

        return terminal;
    }

    #forgetUnmaterialized(sessionId: string): void {
        const prior = this.#db
            .prepare("SELECT entry_id FROM kernel_entries WHERE session_id=? LIMIT 1")
            .get(sessionId);

        if (prior) {
            throw new Error("Cannot clear a materialized session binding");
        }

        this.#db
            .prepare(
                "UPDATE kernel_sessions SET session_file=NULL,kernel_session_id=NULL WHERE id=?",
            )
            .run(sessionId);
    }

    fail(
        id: string,
        status: "unknown" | "rejected",
        unmaterialized = false,
        restore?: KernelBinding,
    ): KernelReceipt {
        const attempt = this.receipt(id);

        if (attempt.status !== "dispatch-intent") {
            return attempt;
        }

        if (unmaterialized && status !== "rejected") {
            throw new Error("Unknown dispatch cannot discard its native binding");
        }

        this.#db.exec("BEGIN IMMEDIATE");

        try {
            if (unmaterialized) {
                this.#forgetUnmaterialized(attempt.segmentId);
            }

            // A known-rejected model change did not happen; an unknown one keeps the binding it may have used.
            if (restore && status === "rejected") {
                const previous = JSON.stringify(restore);

                this.#db
                    .prepare("DELETE FROM kernel_segment_models WHERE segment_id=?")
                    .run(attempt.segmentId);
                this.#db
                    .prepare(
                        "INSERT INTO kernel_segment_models SELECT id,? FROM kernel_sessions WHERE id=? AND binding<>?",
                    )
                    .run(previous, attempt.segmentId, previous);
            }

            this.#db.prepare("UPDATE kernel_attempts SET status=? WHERE id=?").run(status, id);
            this.#db.exec("COMMIT");
        } catch (error) {
            this.#db.exec("ROLLBACK");

            throw error;
        }

        return this.receipt(id);
    }

    receipts(sessionId: string): KernelReceipt[] {
        return this.#db
            .prepare(
                "SELECT id FROM kernel_attempts WHERE conversation_id=? ORDER BY rowid DESC LIMIT 100",
            )
            .all(sessionId)
            .map((row) => this.receipt(String(row.id)));
    }

    pendingConversation(sessionId: string): KernelReceipt | undefined {
        const row = this.#db
            .prepare(
                "SELECT * FROM kernel_attempts WHERE conversation_id=? AND status IN ('dispatch-intent','unknown') LIMIT 1",
            )
            .get(sessionId);

        return row ? this.#receipt(row) : undefined;
    }

    pending(memberId: string): KernelReceipt | undefined {
        const row = this.#db
            .prepare(
                "SELECT id FROM kernel_attempts WHERE home=? AND status IN ('dispatch-intent','unknown') LIMIT 1",
            )
            .get(join(this.#data, "kernel-homes", memberId));

        return row ? this.receipt(String(row.id)) : undefined;
    }

    /** Own history in append-only order, skipping an already-consumed prefix (never handoff seed copies). */
    entries(
        sessionId: string,
        skip = 0,
    ): {
        attemptId: string;
        entry: KernelEntry;
        operation: KernelOperation;
        requestId: string;
        memberId: string;
    }[] {
        if (!Number.isSafeInteger(skip) || skip < 0) {
            throw new RangeError("Native history offset must be a non-negative safe integer");
        }

        return this.#db
            .prepare(
                "SELECT e.attempt_id,e.body,a.operation,a.request_id,a.binding FROM kernel_entries e JOIN kernel_attempts a ON a.id=e.attempt_id WHERE a.conversation_id=? AND a.operation<>'handoff' ORDER BY e.rowid LIMIT -1 OFFSET ?",
            )
            .all(sessionId, skip)
            .map((row) => ({
                attemptId: String(row.attempt_id),
                entry: JSON.parse(String(row.body)),
                operation: row.operation as KernelOperation,
                requestId: String(row.request_id),
                memberId: (JSON.parse(String(row.binding)) as KernelBinding).memberId,
            }));
    }

    /** Full native entries for exactly one segment, including inherited seed entries. */
    segmentEntries(segmentId: string): KernelEntry[] {
        return this.#db
            .prepare("SELECT body FROM kernel_entries WHERE session_id=? ORDER BY rowid")
            .all(segmentId)
            .map((row) => JSON.parse(String(row.body)));
    }

    /** One model response of a subagent, charged to the member its run's attempt is bound to. */
    childUsage(attemptId: string, raw: unknown): void {
        const attempt = this.receipt(attemptId);

        if (attempt.status !== "dispatch-intent") {
            throw new Error("Subagent usage arrived after its run ended");
        }

        this.#db
            .prepare("INSERT INTO kernel_child_usage VALUES (?,?,?)")
            .run(attemptId, attempt.binding.memberId, JSON.stringify(raw));
    }

    usage(sessionId: string): {
        memberId: string;
        attemptId: string;
        raw: unknown;
        costStatus: "unknown";
        subagent?: true;
    }[] {
        const rows = (table: string) =>
            this.#db
                .prepare(
                    `SELECT u.* FROM ${table} u JOIN kernel_attempts a ON a.id=u.attempt_id WHERE a.conversation_id=? ORDER BY u.rowid`,
                )
                .all(sessionId);

        return [
            ...rows("kernel_usage").map((row) => ({
                memberId: String(row.member_id),
                attemptId: String(row.attempt_id),
                raw: row.raw_usage ? JSON.parse(String(row.raw_usage)) : null,
                costStatus: "unknown" as const,
            })),
            ...rows("kernel_child_usage").map((row) => ({
                memberId: String(row.member_id),
                attemptId: String(row.attempt_id),
                raw: JSON.parse(String(row.raw_usage)),
                costStatus: "unknown" as const,
                subagent: true as const,
            })),
        ];
    }

    /** Reported subtotals, not a full account ledger. Imported seeds never become recipient charges. */
    credits(sessionId: string) {
        const groups = new Map<
            string,
            {
                memberId: string;
                nativeId: string;
                entries: KernelEntry[];
                attempts: Map<string, { status: string; observed: boolean }>;
            }
        >();
        const rows = this.#db
            .prepare(
                `SELECT a.id,a.session_id,a.binding,a.status,s.kernel_session_id,e.body
            FROM kernel_attempts a JOIN kernel_sessions s ON s.id=a.session_id
            LEFT JOIN kernel_entries e ON e.attempt_id=a.id AND json_extract(e.body,'$.customType')=?
            WHERE a.conversation_id=? AND a.operation IN ('prompt','compact','command') ORDER BY a.rowid,e.rowid`,
            )
            .all(CREDIT_ENTRY, sessionId);

        for (const row of rows) {
            const binding = JSON.parse(String(row.binding)) as KernelBinding;

            if (binding.provider !== "qoder") {
                continue;
            }

            const segmentId = String(row.session_id);
            let group = groups.get(segmentId);

            if (!group) {
                group = {
                    memberId: binding.memberId,
                    nativeId: row.kernel_session_id ? String(row.kernel_session_id) : "",
                    entries: [],
                    attempts: new Map(),
                };
                groups.set(segmentId, group);
            }

            const attemptId = String(row.id);
            const attempt = group.attempts.get(attemptId) ?? {
                status: String(row.status),
                observed: false,
            };

            group.attempts.set(attemptId, attempt);

            if (row.body) {
                const entry = JSON.parse(String(row.body)) as KernelEntry;

                group.entries.push(entry);

                if (
                    entry.type === "custom" &&
                    entry.data !== null &&
                    typeof entry.data === "object" &&
                    "sessionId" in entry.data &&
                    entry.data.sessionId === group.nativeId
                ) {
                    attempt.observed = true;
                }
            }
        }

        return [...groups].map(([segmentId, group]) => ({
            segmentId,
            memberId: group.memberId,
            ...creditSummary(group.entries, group.nativeId),
            unmeteredOperations: [...group.attempts.values()].filter(
                (attempt) =>
                    !attempt.observed &&
                    ["settled", "unknown", "dispatch-intent", "interrupted"].includes(
                        attempt.status,
                    ),
            ).length,
            partial: true as const,
        }));
    }

    close(): void {
        if (this.#closed) {
            return;
        }

        this.#closed = true;
        this.#db.close();
        rmSync(this.#lock);
    }
}
