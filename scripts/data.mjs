#!/usr/bin/env node
/** Private backup/restore and read-only native inspection. Restore never resurrects rotated model refresh credentials. */
import { createHash, randomUUID } from "node:crypto";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { takeLock } from "../src/server/lock.ts";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ignored = new Set(["harness.lock", "kernel.lock", "kernel-gates", "extensions/node_modules"]);
const safe = (name) =>
    name &&
    !name.startsWith("/") &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    name.split("/").every((part) => part && part !== "." && part !== "..");

function copy(source, destination, records = [], prefix = "") {
    mkdirSync(destination, { recursive: true, mode: 0o700 });

    for (const name of readdirSync(source).sort()) {
        const path = prefix ? `${prefix}/${name}` : name;

        if (ignored.has(path)) {
            continue;
        }

        const input = join(source, name),
            output = join(destination, name),
            stat = lstatSync(input);

        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
            throw new Error(`Backup refuses non-regular path: ${path}`);
        }

        if (stat.isDirectory()) {
            copy(input, output, records, path);
            continue;
        }

        if (stat.size > 512 * 1024 * 1024) {
            throw new Error(
                "A backup file exceeds 512 MiB; use a reviewed streaming backup before proceeding.",
            );
        }

        const content = readFileSync(input),
            mode = stat.mode & 0o111 ? 0o700 : 0o600;

        writeFileSync(output, content, { mode, flag: "wx" });
        records.push({ path, size: content.length, sha256: digest(content), mode });
    }

    return records;
}

/** Read-only operator evidence. A lease/PID or transcript binding never proves tool closure or business success. */
export function inspectNative(data) {
    const source = realpathSync(data);

    if (!lstatSync(source).isDirectory() || lstatSync(source).mode & 0o077) {
        throw new Error("Native inspection requires a private data directory.");
    }

    const database = join(source, "kernel.sqlite");
    const lease = join(source, "kernel.lock");

    for (const path of [database, `${database}-wal`, `${database}-shm`, lease]) {
        const stat = lstatSync(path, { throwIfNoEntry: false });

        if (stat && !stat.isFile()) {
            throw new Error("Native inspection refuses non-regular journal or lease paths.");
        }
    }

    const leasePresent = existsSync(lease);
    let leaseOwnerPid = null;

    if (leasePresent) {
        if (lstatSync(lease).size > 32) {
            throw new Error("Invalid native lease.");
        }

        const value = readFileSync(lease, "utf8").trim();

        if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
            throw new Error("Invalid native lease.");
        }

        leaseOwnerPid = Number(value);
    }

    const evidence = {
        format: "rotom-team-native-inspection/v1",
        leasePresent,
        leaseOwnerPid,
        toolClosure: "unknown",
        replayPermitted: false,
    };

    if (!existsSync(database)) {
        return { ...evidence, journalPresent: false };
    }

    const db = new DatabaseSync(database, { readOnly: true });

    try {
        db.exec("BEGIN");
        const version = Number(db.prepare("PRAGMA user_version").get().user_version);

        if (![1, 2, 3].includes(version)) {
            throw new Error("Unsupported native journal version; no migration was attempted.");
        }

        const pendingTotal = Number(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM kernel_attempts WHERE status IN ('dispatch-intent','unknown')",
                )
                .get().count,
        );
        const rows = db
            .prepare(
                `SELECT a.id, a.session_id, a.request_id, a.binding, a.status, s.session_file,
            ${version === 2 ? "a.conversation_id, a.operation" : "a.session_id AS conversation_id, 'prompt' AS operation"}
            FROM kernel_attempts a JOIN kernel_sessions s ON s.id=a.session_id
            WHERE a.status IN ('dispatch-intent','unknown') ORDER BY a.id LIMIT 100`,
            )
            .all();
        const pending = rows.map((row) => ({
            attemptId: String(row.id),
            conversationId: String(row.conversation_id),
            segmentId: String(row.session_id),
            requestId: String(row.request_id),
            memberId: String(JSON.parse(row.binding).memberId),
            operation: String(row.operation),
            recordedStatus: String(row.status),
            transcriptBound: row.session_file !== null,
            outcome: "unresolved",
        }));

        return {
            ...evidence,
            journalPresent: true,
            version,
            pendingTotal,
            pending,
            truncated: pendingTotal > pending.length,
        };
    } finally {
        db.close();
    }
}

export function backup(data, destination) {
    const source = realpathSync(data),
        absolute = resolve(destination);
    const output = join(realpathSync(dirname(absolute)), basename(absolute));

    if (output === source || output.startsWith(source + sep) || existsSync(output)) {
        throw new Error("Backup destination must be new and outside the data directory.");
    }

    const lock = join(source, "harness.lock"),
        staging = `${output}.${randomUUID()}.tmp`;

    takeLock(lock);

    try {
        if (existsSync(join(source, "kernel.lock"))) {
            throw new Error(
                "Kernel writer or unreconciled kernel lease exists; stop and reconcile it before backup.",
            );
        }

        const files = copy(source, join(staging, "data"));

        writeFileSync(
            join(staging, "manifest.json"),
            JSON.stringify({
                format: "rotom-team-backup/v1",
                source,
                createdAt: Date.now(),
                files,
            }),
            { mode: 0o600, flag: "wx" },
        );
        renameSync(staging, output);
    } catch (error) {
        rmSync(staging, { recursive: true, force: true });

        throw error;
    } finally {
        rmSync(lock);
    }
}

export function restore(archive, destination) {
    const source = realpathSync(archive),
        absolute = resolve(destination);
    const output = join(realpathSync(dirname(absolute)), basename(absolute));
    const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));

    if (manifest.format !== "rotom-team-backup/v1" || !Array.isArray(manifest.files)) {
        throw new Error("Unsupported backup format.");
    }

    if (output !== manifest.source) {
        throw new Error(
            "Restore must use the original absolute data path. Relocation of durable tool intents is not supported; do not silently rewrite them.",
        );
    }

    if (existsSync(output)) {
        throw new Error(
            "Restore destination already exists; never overwrite active or existing data.",
        );
    }

    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    const staging = `${output}.${randomUUID()}.tmp`,
        seen = new Set();

    mkdirSync(staging, { mode: 0o700 });

    try {
        for (const record of manifest.files) {
            if (!safe(record.path) || seen.has(record.path)) {
                throw new Error("Invalid backup path.");
            }

            seen.add(record.path);
            const file = join(source, "data", record.path),
                stat = lstatSync(file);

            if (
                !stat.isFile() ||
                stat.size > 512 * 1024 * 1024 ||
                !realpathSync(file).startsWith(realpathSync(join(source, "data")) + sep)
            ) {
                throw new Error("Backup contains a link or escaping path.");
            }

            const content = readFileSync(file);

            if (content.length !== record.size || digest(content) !== record.sha256) {
                throw new Error(`Backup digest mismatch: ${record.path}`);
            }

            // A snapshot is not refresh-token ownership. Independently sign in again after restore.
            if (
                /^people\/[^/]+\/auth\.json$/.test(record.path) ||
                /^kernel-homes\/[^/]+\/\.pi\/agent\/auth\.json$/.test(record.path) ||
                record.path === "kernel.lock" ||
                record.path.startsWith("kernel-gates/")
            ) {
                continue;
            }

            const target = join(staging, record.path);

            mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
            writeFileSync(target, content, {
                mode: record.mode === 0o700 ? 0o700 : 0o600,
                flag: "wx",
            });
        }

        renameSync(staging, output);
    } catch (error) {
        rmSync(staging, { recursive: true, force: true });

        throw error;
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const [command, input, output] = process.argv.slice(2);

    if (command === "inspect-native" && input && !output) {
        console.log(JSON.stringify(inspectNative(input), null, 2));
    } else {
        if (!input || !output || !["backup", "restore"].includes(command)) {
            throw new Error(
                "Usage: node scripts/data.mjs backup|restore /absolute/source /absolute/destination; or inspect-native /absolute/data",
            );
        }

        (command === "backup" ? backup : restore)(input, output);
        console.log(
            command === "backup"
                ? "Private backup verified. It contains credentials: do not upload or share it."
                : "Backup restored. Model accounts require independent sign-in; old refresh tokens were not restored.",
        );
    }
}
