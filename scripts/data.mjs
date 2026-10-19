#!/usr/bin/env node
/** Private backup/restore and read-only native inspection. Restore never resurrects rotated model refresh credentials. */
import { createHash, randomUUID } from "node:crypto";
import {
    closeSync,
    constants,
    existsSync,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readSync,
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
const COPY_CHUNK_BYTES = 1024 * 1024;

/** Offline CLI only: bound payload memory independently of file size, including journal databases. */
function transferFile(input, output, mode = 0o600, expected) {
    const source = openSync(
        input,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let target;

    try {
        const before = fstatSync(source);

        if (!before.isFile() || !Number.isSafeInteger(before.size)) {
            throw new Error(`Backup refuses non-regular or oversized path: ${input}`);
        }

        if (expected && before.size !== expected.size) {
            throw new Error(`Backup digest mismatch: ${expected.path}`);
        }

        if (output !== undefined) {
            target = openSync(output, "wx", mode);
        }

        const chunk = Buffer.alloc(COPY_CHUNK_BYTES),
            hash = createHash("sha256");
        let size = 0;

        while (size < before.size) {
            const length = readSync(
                source,
                chunk,
                0,
                Math.min(chunk.length, before.size - size),
                size,
            );

            if (length === 0) {
                throw new Error(`Source file changed during backup/restore: ${input}`);
            }

            const bytes = chunk.subarray(0, length);

            hash.update(bytes);

            if (target !== undefined) {
                writeFileSync(target, bytes);
            }

            size += length;
        }

        const after = fstatSync(source),
            sha256 = hash.digest("hex");

        if (
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            before.ctimeMs !== after.ctimeMs
        ) {
            throw new Error(`Source file changed during backup/restore: ${input}`);
        }

        if (expected && sha256 !== expected.sha256) {
            throw new Error(`Backup digest mismatch: ${expected.path}`);
        }

        return { size, sha256 };
    } finally {
        if (target !== undefined) {
            closeSync(target);
        }

        closeSync(source);
    }
}

const ignored = new Set(["harness.lock", "kernel.lock", "kernel-gates", "extensions/node_modules"]);
const safe = (name) =>
    name &&
    !name.startsWith("/") &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    name.split("/").every((part) => part && part !== "." && part !== "..");

function copy(source, destination, records = [], prefix = "", excludedCaches = []) {
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

        if (path === "team-agent/npm/node_modules") {
            if (!stat.isDirectory()) {
                throw new Error("Shared npm cache must be a real directory");
            }

            for (const name of ["package.json", "package-lock.json"]) {
                const manifest = lstatSync(join(source, name), { throwIfNoEntry: false });

                if (!manifest?.isFile() || manifest.isSymbolicLink()) {
                    throw new Error(
                        "Shared npm cache requires regular package.json and package-lock.json; unlocked installs cannot be omitted from backup",
                    );
                }
            }

            const declarations = join(source, "../team.json");
            const declarationStat = lstatSync(declarations, { throwIfNoEntry: false });

            if (declarationStat && !declarationStat.isFile()) {
                throw new Error("Shared configuration manifest must be a regular file");
            }

            const config = declarationStat ? JSON.parse(readFileSync(declarations, "utf8")) : {};

            if (
                (config.configFiles ?? []).some((name) =>
                    String(name)
                        .replaceAll("\\", "/")
                        .toLowerCase()
                        .startsWith("npm/node_modules/"),
                )
            ) {
                throw new Error(
                    "Declared owner configuration cannot be omitted as installed npm cache",
                );
            }

            excludedCaches.push(path);
            continue;
        }

        if (stat.isDirectory()) {
            copy(input, output, records, path, excludedCaches);
            continue;
        }

        const mode = stat.mode & 0o111 ? 0o700 : 0o600;
        const { size, sha256 } = transferFile(input, output, mode);

        records.push({ path, size, sha256, mode });
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

        if (![1, 2, 3, 4, 5, 6].includes(version)) {
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
            ${version >= 6 ? "a.phase, a.failure," : ""}
            ${version >= 5 ? "EXISTS(SELECT 1 FROM kernel_command_inputs c WHERE c.attempt_id=a.id) AS unresolved_command_input," : ""}
            ${version >= 2 ? "a.conversation_id, a.operation" : "a.session_id AS conversation_id, 'prompt' AS operation"}
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
            ...(row.phase ? { phase: String(row.phase) } : {}),
            ...(row.failure ? { failure: String(row.failure) } : {}),
            ...(row.unresolved_command_input ? { unresolvedCommandInput: true } : {}),
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

        const excludedCaches = [];
        const files = copy(source, join(staging, "data"), [], "", excludedCaches);

        writeFileSync(
            join(staging, "manifest.json"),
            JSON.stringify({
                format: "rotom-team-backup/v1",
                source,
                createdAt: Date.now(),
                files,
                excludedCaches,
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
                !realpathSync(file).startsWith(realpathSync(join(source, "data")) + sep)
            ) {
                throw new Error("Backup contains a link or escaping path.");
            }

            // A snapshot is not refresh-token ownership. Independently sign in again after restore.
            if (
                /^people\/[^/]+\/auth\.json$/.test(record.path) ||
                /^kernel-homes\/[^/]+\/\.pi\/agent\/(mcp-)?auth\.json$/.test(record.path) ||
                record.path === "kernel.lock" ||
                record.path.startsWith("kernel-gates/")
            ) {
                transferFile(file, undefined, undefined, record);
                continue;
            }

            const target = join(staging, record.path);

            mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
            transferFile(file, target, record.mode === 0o700 ? 0o700 : 0o600, record);
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
                ? "Private backup verified. It contains credentials: do not upload or share it. Check excludedCaches; shared npm dependencies require explicit reinstall from the saved lock after restore."
                : "Backup restored. Model accounts require independent sign-in; old refresh tokens were not restored. Check excludedCaches and explicitly reinstall shared npm dependencies before native startup.",
        );
    }
}
