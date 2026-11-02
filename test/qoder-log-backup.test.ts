/** Synthetic offline data only. Known log pointers are metadata, never traversal paths. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readlinkSync,
    readdirSync,
    realpathSync,
    renameSync,
    rmSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { backup, restore } from "../scripts/data.mjs";

const linkPath = "kernel-homes/member/.qoder/logs/latest";
const target = "runs/2026-10-30T16-15-50-189+08-00-fixture";

function fixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "qoder-log-backup-")));
    const data = join(root, "data");
    const archive = join(root, "backup");
    const logs = join(data, "kernel-homes/member/.qoder/logs");
    const link = join(data, linkPath);

    mkdirSync(join(logs, target), { recursive: true, mode: 0o700 });
    symlinkSync(target, link);

    return { root, data, archive, logs, link };
}

for (const empty of [false, true]) {
    test(`known Qoder pointer round-trips without following it; empty=${empty}`, (t) => {
        const f = fixture();

        t.after(() => rmSync(f.root, { recursive: true, force: true }));

        if (!empty) {
            writeFileSync(join(f.logs, target, "agent.log"), "SYNTHETIC_LOG", { mode: 0o600 });
        }

        backup(f.data, f.archive);
        const manifest = JSON.parse(readFileSync(join(f.archive, "manifest.json"), "utf8"));

        assert.equal(manifest.format, "rotom-team-backup/v2");
        assert.deepEqual(manifest.logLinks, [{ path: linkPath, target }]);
        assert.equal(existsSync(join(f.archive, "data", linkPath)), false);
        assert.equal(manifest.files.length, empty ? 0 : 1, "log payload is archived only once");
        renameSync(f.data, join(f.root, "retired"));
        restore(f.archive, f.data);
        assert.ok(lstatSync(f.link).isSymbolicLink());
        assert.equal(readlinkSync(f.link), target);
        assert.equal(realpathSync(f.link), join(f.logs, target));
        assert.equal(lstatSync(join(f.logs, target)).mode & 0o777, 0o700);

        if (!empty) {
            assert.equal(readFileSync(join(f.link, "agent.log"), "utf8"), "SYNTHETIC_LOG");
            assert.equal(lstatSync(join(f.link, "agent.log")).mode & 0o777, 0o600);
        }
    });
}

test("backup rejects escaping, dangling, indirect and non-directory log targets", (t) => {
    const f = fixture();

    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const outside = join(f.root, "outside");

    mkdirSync(outside);
    mkdirSync(join(f.logs, "other"));
    symlinkSync(outside, join(f.logs, "runs/indirect"));
    writeFileSync(join(f.logs, "runs/file"), "not a directory");

    for (const value of [
        outside,
        "../outside",
        "runs/../other",
        "runs/missing",
        "runs/indirect",
        "runs/file",
        "latest",
    ]) {
        unlinkSync(f.link);
        symlinkSync(value, f.link);
        assert.throws(() => backup(f.data, f.archive), value);
        assert.equal(existsSync(f.archive), false);
        assert.equal(existsSync(join(f.data, "harness.lock")), false);
        assert.ok(!readdirSync(f.root).some((name) => name.endsWith(".tmp")));
    }
});

test("the allowed pointer cannot hide a symlink in its target path or elsewhere", (t) => {
    const f = fixture();

    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const outside = join(f.root, "outside");

    mkdirSync(outside);
    renameSync(join(f.logs, "runs"), join(outside, "runs"));
    symlinkSync(join(outside, "runs"), join(f.logs, "runs"));
    assert.throws(() => backup(f.data, f.archive), /real directory/);
    unlinkSync(join(f.logs, "runs"));
    renameSync(join(outside, "runs"), join(f.logs, "runs"));
    symlinkSync(outside, join(f.data, "arbitrary"));
    assert.throws(() => backup(f.data, f.archive), /non-regular/);
    assert.equal(existsSync(f.archive), false);
});

test("changing a pointer during backup aborts without publishing a snapshot", (t) => {
    const f = fixture();

    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    mkdirSync(join(f.logs, "runs/changed"));
    const readlink = fs.readlinkSync;
    let changed = false;
    const mock = t.mock.method(fs, "readlinkSync", (...args: Parameters<typeof readlink>) => {
        const result = readlink(...args);

        if (args[0] === f.link && !changed) {
            changed = true;
            unlinkSync(f.link);
            symlinkSync("runs/changed", f.link);
        }

        return result;
    });

    syncBuiltinESMExports();

    try {
        assert.throws(() => backup(f.data, f.archive), /Source log link changed/);
        assert.equal(existsSync(f.archive), false);
        assert.equal(existsSync(join(f.data, "harness.lock")), false);
    } finally {
        mock.mock.restore();
        syncBuiltinESMExports();
    }
});

test("restore refuses malformed, escaping, duplicate, conflicting or downgraded link metadata", (t) => {
    const f = fixture();

    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    backup(f.data, f.archive);
    const manifestFile = join(f.archive, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));

    renameSync(f.data, join(f.root, "retired"));
    const valid = { path: linkPath, target };
    const cases = [
        { ...manifest, logLinks: [{ ...valid, target: "../../outside" }] },
        { ...manifest, logLinks: [{ ...valid, target: "/tmp/outside" }] },
        { ...manifest, logLinks: [{ ...valid, target: "runs/../escape" }] },
        { ...manifest, logLinks: [{ ...valid, path: "kernel-homes/member/.pi/agent/auth.json" }] },
        { ...manifest, logLinks: [{ ...valid, path: `${linkPath}\n` }] },
        { ...manifest, logLinks: [valid, valid] },
        { ...manifest, logLinks: null },
        { ...manifest, format: "rotom-team-backup/v1" },
    ];

    for (const value of cases) {
        writeFileSync(manifestFile, JSON.stringify(value));
        assert.throws(() => restore(f.archive, f.data));
        assert.equal(existsSync(f.data), false, "never publish a partially restored tree");
        assert.ok(!readdirSync(f.root).some((name) => name.endsWith(".tmp")));
    }

    writeFileSync(manifestFile, JSON.stringify(manifest));
    mkdirSync(join(f.archive, "data", linkPath), { recursive: true });
    writeFileSync(join(f.archive, "data", linkPath, "payload"), "conflicting file");
    manifest.files.push({
        path: `${linkPath}/payload`,
        mode: 0o600,
        size: Buffer.byteLength("conflicting file"),
        sha256: createHash("sha256").update("conflicting file").digest("hex"),
    });
    writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.throws(() => restore(f.archive, f.data), /EEXIST/);
    assert.equal(existsSync(f.data), false);
});
