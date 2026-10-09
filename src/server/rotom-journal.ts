/** Private execution receipts. RPC correlation IDs are not durable idempotency keys. */
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
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
export type KernelReceipt = {
    id: string;
    sessionId: string;
    requestId: string;
    status: "dispatch-intent" | "settled" | "handled" | "rejected" | "unknown";
    binding: KernelBinding;
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
        if (Number(db.prepare("PRAGMA user_version").get()!.user_version) !== 1) {
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

            if (version !== 0 && version !== 1) {
                throw new Error("Unsupported kernel journal version");
            }

            this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
                CREATE TABLE IF NOT EXISTS kernel_sessions (id TEXT PRIMARY KEY, binding TEXT NOT NULL, session_file TEXT, kernel_session_id TEXT);
                CREATE TABLE IF NOT EXISTS kernel_attempts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES kernel_sessions(id), request_id TEXT NOT NULL, prompt_hash TEXT NOT NULL, binding TEXT NOT NULL, home TEXT NOT NULL, status TEXT NOT NULL, UNIQUE(session_id, request_id));
                CREATE UNIQUE INDEX IF NOT EXISTS one_kernel_writer ON kernel_attempts(home) WHERE status IN ('dispatch-intent','unknown');
                CREATE TABLE IF NOT EXISTS kernel_entries (kernel_session_id TEXT NOT NULL, entry_id TEXT NOT NULL, session_id TEXT NOT NULL, attempt_id TEXT NOT NULL REFERENCES kernel_attempts(id), body TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(kernel_session_id,entry_id));
                CREATE TABLE IF NOT EXISTS kernel_usage (kernel_session_id TEXT NOT NULL, entry_id TEXT NOT NULL, attempt_id TEXT NOT NULL, member_id TEXT NOT NULL, raw_usage TEXT, PRIMARY KEY(kernel_session_id,entry_id), FOREIGN KEY(kernel_session_id,entry_id) REFERENCES kernel_entries(kernel_session_id,entry_id)); PRAGMA user_version=1;`);
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

        this.#db
            .prepare("INSERT INTO kernel_sessions(id,binding) VALUES (?,?)")
            .run(sessionId, JSON.stringify(normalized));
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

    session(id: string): {
        binding: KernelBinding;
        sessionFile?: string;
        kernelSessionId?: string;
    } {
        const row = this.#db.prepare("SELECT * FROM kernel_sessions WHERE id=?").get(id);

        if (!row) {
            throw new Error("Unknown kernel session");
        }

        return {
            binding: JSON.parse(String(row.binding)),
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

        return {
            id,
            sessionId: String(row.session_id),
            requestId: String(row.request_id),
            status: row.status as KernelReceipt["status"],
            binding: JSON.parse(String(row.binding)),
        };
    }

    existing(sessionId: string, requestId: string, prompt: string): KernelReceipt | undefined {
        const row = this.#db
            .prepare(
                "SELECT id,prompt_hash FROM kernel_attempts WHERE session_id=? AND request_id=?",
            )
            .get(sessionId, requestId);

        if (!row) {
            return undefined;
        }

        if (row.prompt_hash !== digest(prompt)) {
            throw new Error("Request identity cannot be reused with different content");
        }

        return this.receipt(String(row.id));
    }

    reserve(sessionId: string, requestId: string, prompt: string): KernelReceipt {
        const existing = this.existing(sessionId, requestId, prompt);

        if (existing) {
            return existing;
        }

        if (!requestId || requestId.length > 128) {
            throw new Error("Invalid request identity");
        }

        const { binding } = this.session(sessionId);
        const blocked = this.#db
            .prepare(
                "SELECT id FROM kernel_attempts WHERE home=? AND status IN ('dispatch-intent','unknown')",
            )
            .get(binding.home);

        if (blocked) {
            throw new Error(
                "Kernel account has a running or unknown attempt; reconcile it before any new dispatch",
            );
        }

        const id = randomUUID();

        // Synchronous FULL SQLite commit completes before any child launch or stdin send.
        this.#db
            .prepare(
                "INSERT INTO kernel_attempts(id,session_id,request_id,prompt_hash,binding,home,status) VALUES (?,?,?,?,?,?,'dispatch-intent')",
            )
            .run(id, sessionId, requestId, digest(prompt), JSON.stringify(binding), binding.home);

        return this.receipt(id);
    }

    attach(id: string, sessionFile: string, kernelSessionId: string): void {
        const receipt = this.receipt(id),
            session = this.session(receipt.sessionId);

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
            .run(sessionFile, kernelSessionId, receipt.sessionId);
    }

    finish(id: string, status: "settled" | "handled", entries: KernelEntry[]): KernelReceipt {
        const attempt = this.receipt(id),
            session = this.session(attempt.sessionId);

        if (attempt.status !== "dispatch-intent") {
            throw new Error("Attempt is not active");
        }

        if (!session.kernelSessionId) {
            throw new Error("Missing kernel session binding");
        }

        this.#db.exec("BEGIN IMMEDIATE");

        try {
            const seen = new Set<string>();
            let terminalResponse = false;

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
                    .get(session.kernelSessionId, entry.id);

                if (previous) {
                    if (previous.digest !== hash) {
                        throw new Error("Native entry changed after ingestion");
                    }

                    continue;
                }

                this.#db
                    .prepare("INSERT INTO kernel_entries VALUES (?,?,?,?,?,?)")
                    .run(session.kernelSessionId, entry.id, attempt.sessionId, id, body, hash);
                const message = entry.message as
                    | {
                          role?: string;
                          provider?: string;
                          model?: string;
                          stopReason?: string;
                          usage?: unknown;
                      }
                    | undefined;

                if (entry.type === "message" && message?.role === "user") {
                    terminalResponse = false;
                }

                if (entry.type === "message" && message?.role === "assistant") {
                    if (
                        message.provider !== attempt.binding.provider ||
                        message.model !== attempt.binding.model
                    ) {
                        throw new Error(
                            "Native response model does not match admitted payer/model",
                        );
                    }

                    terminalResponse = ["stop", "error", "aborted", "length"].includes(
                        String(message.stopReason),
                    );
                    // Preserve raw kernel usage. Pi's zero placeholders do not establish reported cost/credits.
                    this.#db
                        .prepare("INSERT INTO kernel_usage VALUES (?,?,?,?,?)")
                        .run(
                            session.kernelSessionId,
                            entry.id,
                            id,
                            attempt.binding.memberId,
                            message.usage ? JSON.stringify(message.usage) : null,
                        );
                }
            }

            if (status === "settled" && !terminalResponse) {
                throw new Error(
                    "Settled event has no new persisted terminal response; outcome remains unknown",
                );
            }

            if (status === "handled" && entries.length === 0) {
                // A fresh extension-handled prompt may never create JSONL. Keep its receipt, not a nonexistent resume path.
                this.#forgetUnmaterialized(attempt.sessionId);
            }

            this.#db.prepare("UPDATE kernel_attempts SET status=? WHERE id=?").run(status, id);
            this.#db.exec("COMMIT");
        } catch (error) {
            this.#db.exec("ROLLBACK");

            throw error;
        }

        return this.receipt(id);
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

    fail(id: string, status: "unknown" | "rejected", unmaterialized = false): KernelReceipt {
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
                this.#forgetUnmaterialized(attempt.sessionId);
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
                "SELECT id FROM kernel_attempts WHERE session_id=? ORDER BY rowid DESC LIMIT 100",
            )
            .all(sessionId)
            .map((row) => this.receipt(String(row.id)));
    }

    pending(memberId: string): KernelReceipt | undefined {
        const row = this.#db
            .prepare(
                "SELECT id FROM kernel_attempts WHERE home=? AND status IN ('dispatch-intent','unknown') LIMIT 1",
            )
            .get(join(this.#data, "kernel-homes", memberId));

        return row ? this.receipt(String(row.id)) : undefined;
    }

    entries(sessionId: string): { attemptId: string; entry: KernelEntry }[] {
        return this.#db
            .prepare("SELECT attempt_id,body FROM kernel_entries WHERE session_id=? ORDER BY rowid")
            .all(sessionId)
            .map((row) => ({
                attemptId: String(row.attempt_id),
                entry: JSON.parse(String(row.body)),
            }));
    }

    usage(
        sessionId: string,
    ): { memberId: string; attemptId: string; raw: unknown; costStatus: "unknown" }[] {
        return this.#db
            .prepare(
                "SELECT u.* FROM kernel_usage u JOIN kernel_entries e USING(kernel_session_id,entry_id) WHERE e.session_id=? ORDER BY u.rowid",
            )
            .all(sessionId)
            .map((row) => ({
                memberId: String(row.member_id),
                attemptId: String(row.attempt_id),
                raw: row.raw_usage ? JSON.parse(String(row.raw_usage)) : null,
                costStatus: "unknown",
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
