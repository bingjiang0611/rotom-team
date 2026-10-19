/** Large offline payloads use bounded I/O; no production data, provider credentials or model requests. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
    closeSync,
    existsSync,
    ftruncateSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readFileSync,
    readSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { backup, restore } from "../scripts/data.mjs";

const CHUNK_BYTES = 1024 * 1024;
const worker = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    import {backup, restore} from ${JSON.stringify(new URL("../scripts/data.mjs", import.meta.url).href)};
    const readFile = fs.readFileSync;
    const read = fs.readSync;
    const write = fs.writeFileSync;
    let maxRead = 0, maxWrite = 0, changed = false;
    fs.readFileSync = (file, ...args) => {
        const stat = typeof file === 'number' ? fs.fstatSync(file) : fs.statSync(file);
        assert.ok(stat.size <= ${CHUNK_BYTES}, 'never read a large payload in one allocation');
        return readFile(file, ...args);
    };
    fs.readSync = (fd, buffer, offset, length, position) => {
        maxRead = Math.max(maxRead, length);
        assert.ok(length <= ${CHUNK_BYTES}, 'bounded read chunk');
        const count = read(fd, buffer, offset, length, position);
        if (command.startsWith('backup-changing') && count > 0 && !changed) {
            changed = true;
            if (command === 'backup-changing-same-size') {
                const file = fs.openSync(source + '/payload', 'r+');
                fs.writeSync(file, Buffer.from([1]), 0, 1, 0);
                fs.closeSync(file);
                const future = new Date(Date.now() + 10000);
                fs.utimesSync(source + '/payload', future, future);
            } else {
                fs.truncateSync(source + '/payload', 0);
            }
        }
        return count;
    };
    fs.writeFileSync = (file, bytes, ...args) => {
        const length = Buffer.byteLength(bytes);
        maxWrite = Math.max(maxWrite, length);
        assert.ok(length <= ${CHUNK_BYTES}, 'bounded write chunk');
        return write(file, bytes, ...args);
    };
    syncBuiltinESMExports();
    const [command, source, target] = process.argv.slice(1);
    (command.startsWith('backup-changing') ? backup : ({backup, restore})[command])(source, target);
    console.log(JSON.stringify({maxRead, maxWrite, maxRSSKiB:process.resourceUsage().maxRSS}));
`;

function run(command: string, source: string, target: string) {
    return JSON.parse(
        execFileSync(
            process.execPath,
            [
                "--max-old-space-size=64",
                "--input-type=module",
                "-e",
                worker,
                command,
                source,
                target,
            ],
            { encoding: "utf8", timeout: 60_000, stdio: "pipe" },
        ),
    );
}

function hashFile(path: string) {
    const file = openSync(path, "r");
    const hash = createHash("sha256");
    const bytes = Buffer.alloc(CHUNK_BYTES);
    let length;

    try {
        while ((length = readSync(file, bytes, 0, bytes.length, null)) > 0) {
            hash.update(bytes.subarray(0, length));
        }

        return hash.digest("hex");
    } finally {
        closeSync(file);
    }
}

test("a payload above 512 MiB round-trips with 1 MiB I/O, private modes and no revived grants", () => {
    const root = mkdtempSync(join(tmpdir(), "team-streaming-backup-"));
    const data = join(root, "data");
    const archive = join(root, "backup");
    const original = join(root, "retired");
    const size = 512 * 1024 * 1024 + 73;
    const grants = [
        "people/member/auth.json",
        "kernel-homes/member/.pi/agent/auth.json",
        "kernel-homes/member/.pi/agent/mcp-auth.json",
    ];

    try {
        mkdirSync(data, { mode: 0o700 });
        const payload = join(data, "kernel.sqlite");
        const fd = openSync(payload, "wx", 0o600);

        try {
            ftruncateSync(fd, size);

            for (const offset of [0, CHUNK_BYTES - 3, 256 * 1024 * 1024, size - 12]) {
                writeSync(fd, Buffer.from("fixture-data"), 0, 12, offset);
            }
        } finally {
            closeSync(fd);
        }

        for (const name of grants) {
            mkdirSync(dirname(join(data, name)), { recursive: true, mode: 0o700 });
            writeFileSync(join(data, name), '{"refresh":"synthetic-fixture-only"}', {
                mode: 0o600,
            });
        }

        writeFileSync(join(data, "executable"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
        const expected = hashFile(payload);
        const backedUp = run("backup", data, archive);
        const manifest = JSON.parse(readFileSync(join(archive, "manifest.json"), "utf8"));
        const record = manifest.files.find(
            (file: { path: string }) => file.path === "kernel.sqlite",
        );

        assert.equal(record.size, size);
        assert.equal(record.sha256, expected);
        assert.equal(hashFile(join(archive, "data/kernel.sqlite")), expected);
        renameSync(data, original);
        const restored = run("restore", archive, data);

        assert.equal(statSync(payload).size, size);
        assert.equal(hashFile(payload), expected);
        assert.equal(statSync(payload).mode & 0o777, 0o600);
        assert.equal(statSync(join(data, "executable")).mode & 0o777, 0o700);
        assert.equal(statSync(data).mode & 0o777, 0o700);

        for (const name of grants) {
            assert.equal(existsSync(join(data, name)), false, name);
        }

        for (const usage of [backedUp, restored]) {
            assert.equal(usage.maxRead, CHUNK_BYTES);
            assert.ok(usage.maxWrite <= CHUNK_BYTES);
            assert.ok(usage.maxRSSKiB < 192 * 1024, JSON.stringify(usage));
        }

        rmSync(data, { recursive: true });
        const tampered = openSync(join(archive, "data/kernel.sqlite"), "r+");

        try {
            writeSync(tampered, Buffer.from("tampered"), 0, 8, size - 8);
        } finally {
            closeSync(tampered);
        }

        assert.throws(() => run("restore", archive, data), /Backup digest mismatch/);
        assert.equal(
            existsSync(data),
            false,
            "a corrupt large archive never becomes the destination",
        );
        assert.equal(
            readdirSync(root).some((name) => name.endsWith(".tmp")),
            false,
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

for (const change of ["truncation", "same-size"]) {
    test(`source ${change} aborts without publishing a partial backup or retaining its lock`, () => {
        const root = mkdtempSync(join(tmpdir(), "team-streaming-changing-"));
        const data = join(root, "data");
        const archive = join(root, "backup");

        try {
            mkdirSync(data, { mode: 0o700 });
            writeFileSync(join(data, "payload"), Buffer.alloc(2 * CHUNK_BYTES));
            const command =
                change === "same-size" ? "backup-changing-same-size" : "backup-changing";

            assert.throws(() => run(command, data, archive), /Source file changed/);
            assert.equal(existsSync(archive), false);
            assert.equal(existsSync(join(data, "harness.lock")), false);
            assert.equal(
                readdirSync(root).some((name) => name.endsWith(".tmp")),
                false,
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
}

test("streaming preserves the symlink boundary and verifies even grants that restore omits", () => {
    const root = mkdtempSync(join(tmpdir(), "team-streaming-safety-"));
    const data = join(root, "data");
    const archive = join(root, "backup");

    try {
        mkdirSync(data, { mode: 0o700 });
        writeFileSync(join(root, "outside"), "outside");
        symlinkSync(join(root, "outside"), join(data, "link"));
        assert.throws(() => backup(data, archive), /non-regular/);
        assert.equal(existsSync(archive), false);
        assert.equal(existsSync(join(data, "harness.lock")), false);
        rmSync(join(data, "link"));
        const grant = "people/member/auth.json";

        mkdirSync(dirname(join(data, grant)), { recursive: true });
        writeFileSync(join(data, grant), "original");
        backup(data, archive);
        renameSync(data, join(root, "retired"));
        writeFileSync(join(archive, "data", grant), "tampered");
        assert.throws(() => restore(archive, data), /Backup digest mismatch/);
        assert.equal(existsSync(data), false);
        assert.equal(
            readdirSync(root).some((name) => name.endsWith(".tmp")),
            false,
        );
        rmSync(join(archive, "data", grant));
        symlinkSync(join(root, "outside"), join(archive, "data", grant));
        assert.throws(() => restore(archive, data), /link or escaping path/);
        assert.equal(existsSync(data), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
