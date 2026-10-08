#!/usr/bin/env node
/** Offline private backups. Restore never resurrects potentially rotated model refresh credentials. */
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
import { takeLock } from "../src/server/lock.ts";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ignored = new Set(["harness.lock", "extensions/node_modules"]);
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
            if (/^people\/[^/]+\/auth\.json$/.test(record.path)) {
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

    if (!input || !output || !["backup", "restore"].includes(command)) {
        throw new Error(
            "Usage: node scripts/data.mjs backup|restore /absolute/source /absolute/destination",
        );
    }

    (command === "backup" ? backup : restore)(input, output);
    console.log(
        command === "backup"
            ? "Private backup verified. It contains credentials: do not upload or share it."
            : "Backup restored. Model accounts require independent sign-in; old refresh tokens were not restored.",
    );
}
