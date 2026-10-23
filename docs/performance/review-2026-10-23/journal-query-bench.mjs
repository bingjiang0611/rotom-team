// Reproduce the kernel-journal query costs found in the 2026-10-23 review. Measurement only: it never opens the
// service's data. Run with Node 24 (or 22.13+): `node docs/performance/review-2026-10-23/journal-query-bench.mjs`.
//
//   --conversations N   synthetic conversations (default 60); each has 50 attempts × 12 entries of ~2 KB
//   --schema FILE       copy tables and indexes from an existing kernel journal (for example one a test created
//                       with the patched RotomJournal) instead of the e5df4bc schema below
//
// The queries are copied verbatim from src/server/rotom-journal.ts at e5df4bc. If a fix changes a query, add the new
// text beside the old one here so both are measured on the same data.
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => {
    const at = args.indexOf(name);

    return at === -1 ? fallback : args[at + 1];
};
const CONVERSATIONS = Number(option("--conversations", 60));
const ATTEMPTS = 50;
const PER_ATTEMPT = 12;
const schemaFile = option("--schema", undefined);

const BASE_SCHEMA = `
CREATE TABLE kernel_sessions (id TEXT PRIMARY KEY, binding TEXT NOT NULL, session_file TEXT, kernel_session_id TEXT, conversation_id TEXT, parent_segment_id TEXT);
CREATE TABLE kernel_attempts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES kernel_sessions(id), request_id TEXT NOT NULL, prompt_hash TEXT NOT NULL, binding TEXT NOT NULL, home TEXT NOT NULL, status TEXT NOT NULL, conversation_id TEXT, operation TEXT NOT NULL DEFAULT 'prompt', pid INTEGER, phase TEXT, failure TEXT, UNIQUE(session_id, request_id));
CREATE TABLE kernel_entries (kernel_session_id TEXT NOT NULL, entry_id TEXT NOT NULL, session_id TEXT NOT NULL, attempt_id TEXT NOT NULL REFERENCES kernel_attempts(id), body TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(kernel_session_id,entry_id));
CREATE TABLE kernel_usage (kernel_session_id TEXT NOT NULL, entry_id TEXT NOT NULL, attempt_id TEXT NOT NULL, member_id TEXT NOT NULL, raw_usage TEXT, PRIMARY KEY(kernel_session_id,entry_id));
CREATE TABLE kernel_child_usage (attempt_id TEXT NOT NULL REFERENCES kernel_attempts(id), member_id TEXT NOT NULL, raw_usage TEXT NOT NULL);
CREATE UNIQUE INDEX one_conversation_request ON kernel_attempts(conversation_id,request_id);
CREATE UNIQUE INDEX one_conversation_writer ON kernel_attempts(conversation_id) WHERE status IN ('dispatch-intent','unknown');`;

const QUERIES = {
    "entries (mirror suffix)":
        "SELECT e.attempt_id,e.body,a.operation,a.request_id,a.binding FROM kernel_entries e JOIN kernel_attempts a ON a.id=e.attempt_id WHERE a.conversation_id=? AND a.operation<>'handoff' ORDER BY e.rowid LIMIT -1 OFFSET ?",
    segmentEntries: "SELECT body FROM kernel_entries WHERE session_id=? ORDER BY rowid",
    "#terminal": "SELECT body FROM kernel_entries WHERE attempt_id=? ORDER BY rowid",
    usage: "SELECT u.* FROM kernel_usage u JOIN kernel_attempts a ON a.id=u.attempt_id WHERE a.conversation_id=? ORDER BY u.rowid",
    credits:
        "SELECT a.id,a.session_id,a.binding,a.status,s.kernel_session_id,e.body FROM kernel_attempts a JOIN kernel_sessions s ON s.id=a.session_id LEFT JOIN kernel_entries e ON e.attempt_id=a.id AND json_extract(e.body,'$.customType')=? WHERE a.conversation_id=? AND a.operation IN ('prompt','compact','command') ORDER BY a.rowid,e.rowid",
};
const PARAMS = {
    "entries (mirror suffix)": (c) => [`${c}`, ATTEMPTS * PER_ATTEMPT],
    segmentEntries: (c) => [`s${c}`],
    "#terminal": (c) => [`a${c}-0`],
    usage: (c) => [`${c}`],
    credits: (c) => ["credit", `${c}`],
};

const folder = mkdtempSync(join(tmpdir(), "journal-bench-"));
const db = new DatabaseSync(join(folder, "kernel.sqlite"));

try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");

    if (schemaFile) {
        const source = new DatabaseSync(schemaFile, { readOnly: true });
        const ddl = source
            .prepare(
                "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type DESC",
            )
            .all()
            .map((row) => `${row.sql};`)
            .join("\n");

        source.close();
        db.exec(ddl);
    } else {
        db.exec(BASE_SCHEMA);
    }

    const body = JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "x".repeat(2000) }] },
    });
    const binding = JSON.stringify({ memberId: "m", provider: "qoder" });
    const session = db.prepare(
        "INSERT INTO kernel_sessions(id,binding,kernel_session_id,conversation_id) VALUES (?,?,?,?)",
    );
    const attempt = db.prepare(
        "INSERT INTO kernel_attempts(id,session_id,request_id,prompt_hash,binding,home,status,conversation_id,operation) VALUES (?,?,?,?,?,?,?,?,?)",
    );
    const entry = db.prepare("INSERT INTO kernel_entries VALUES (?,?,?,?,?,?)");
    const usage = db.prepare("INSERT INTO kernel_usage VALUES (?,?,?,?,?)");

    db.exec("BEGIN");

    for (let c = 0; c < CONVERSATIONS; c++) {
        session.run(`s${c}`, binding, `k${c}`, `${c}`);

        for (let a = 0; a < ATTEMPTS; a++) {
            attempt.run(`a${c}-${a}`, `s${c}`, `r${a}`, "h", binding, "/h", "settled", `${c}`, "prompt");

            for (let e = 0; e < PER_ATTEMPT; e++) {
                entry.run(`k${c}`, `e${a}-${e}`, `s${c}`, `a${c}-${a}`, body, "d");
            }

            usage.run(`k${c}`, `e${a}-0`, `a${c}-${a}`, "m", "{}");
        }
    }

    db.exec("COMMIT; ANALYZE;");
    console.log(
        `${CONVERSATIONS} conversations × ${ATTEMPTS * PER_ATTEMPT} entries = ${CONVERSATIONS * ATTEMPTS * PER_ATTEMPT} rows (${schemaFile ? `schema from ${schemaFile}` : "e5df4bc schema"})`,
    );

    for (const [name, sql] of Object.entries(QUERIES)) {
        const plan = db
            .prepare(`EXPLAIN QUERY PLAN ${sql}`)
            .all()
            .map((row) => row.detail)
            .join(" | ");
        const runs = Math.min(CONVERSATIONS, 20);
        const started = performance.now();

        for (let c = 0; c < runs; c++) {
            db.prepare(sql).all(...PARAMS[name](c));
        }

        const ms = (performance.now() - started) / runs;

        console.log(`${name.padEnd(24)} ${ms.toFixed(2).padStart(9)} ms/call   ${plan}`);
    }
} finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
}
