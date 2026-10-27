import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
    cpSync,
    existsSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { parseLedger, readLedger, writeLedger } from "./perf/ledger.ts";
import type { Ledger } from "./perf/ratchet.ts";

const sample = (): Ledger => ({
    schema: 1,
    metrics: {
        "git.changes/subprocess.git": {
            scenario: "git.changes",
            metric: "subprocess.git",
            layer: "process",
            unit: "count",
            workload: "fixed git work",
            source: "synthetic git boundary",
            status: "gating",
            tolerance: 0,
            ceiling: 3,
            evidence: { stability: "stable", sensitivity: "sensitive", correlation: "correlated" },
            raise: { from: 2, to: 3, reason: "prior owner-reviewed fixture raise" },
        },
        "turn.warm/sql.rows": {
            scenario: "turn.warm",
            metric: "sql.rows",
            layer: "storage",
            unit: "count",
            workload: "fixed turn work",
            source: "synthetic SQL boundary",
            status: "candidate",
            tolerance: 2,
            ceiling: null,
            baselines: { "darwin-arm64": 100, "linux-x64": 90 },
        },
    },
});

function fixture(t: TestContext) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "perf-ledger-")));
    const path = join(root, "ledger.json");

    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(path, JSON.stringify(sample()));

    return { root, path };
}

test("legacy and bounded ledgers assemble the exact same metric records, with no duplicate ownership", (t) => {
    const { path, root } = fixture(t);
    const before = sample();

    assert.deepEqual(readLedger(path), before);
    assert.deepEqual(
        parseLedger(JSON.stringify(before), () => assert.fail("legacy needs no parts")),
        before,
    );
    writeLedger(path, before);
    assert.deepEqual(readLedger(path), before);
    const index = JSON.parse(readFileSync(path, "utf8")) as { schema: number; fragments: string[] };

    assert.equal(index.schema, 2);
    assert.equal(index.fragments.length, 2);

    for (const name of ["ledger.json", ...index.fragments]) {
        assert.ok(statSync(join(root, name)).size <= 20_000, name);
    }

    const duplicate = { schema: 2, fragments: [index.fragments[0], index.fragments[0]] };

    assert.throws(
        () => parseLedger(JSON.stringify(duplicate), () => JSON.stringify(before)),
        /Duplicate ledger fragment/,
    );
    assert.throws(
        () =>
            parseLedger(JSON.stringify({ schema: 2, fragments: ["a.json", "b.json"] }), () =>
                JSON.stringify(before),
            ),
        /Duplicate ledger metric/,
    );
});

test("missing, malformed and escaping ledger parts fail instead of hiding counters", (t) => {
    const { path, root } = fixture(t);

    for (const fragment of ["../outside.json", "/outside.json", "parts/../outside.json"]) {
        assert.throws(
            () =>
                parseLedger(JSON.stringify({ schema: 2, fragments: [fragment] }), () =>
                    assert.fail("must not read"),
                ),
            /Invalid ledger fragment path/,
        );
    }

    writeFileSync(path, JSON.stringify({ schema: 2, fragments: ["missing.json"] }));
    assert.throws(() => readLedger(path), /ENOENT/);
    writeFileSync(join(root, "broken.json"), JSON.stringify({ schema: 1, metrics: { wrong: {} } }));
    writeFileSync(path, JSON.stringify({ schema: 2, fragments: ["broken.json"] }));
    assert.throws(() => readLedger(path), /Ledger key must be scenario/);
});

test("historical indexed ledgers read fragment blobs from their Git revision, never current disk values", (t) => {
    const { path, root } = fixture(t);
    const before = sample();

    writeLedger(path, before);
    const git = (...args: string[]) =>
        execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });

    git("init", "--quiet");
    git("config", "user.name", "Ledger fixture");
    git("config", "user.email", "ledger@example.invalid");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Indexed ledger fixture");
    const revision = git("rev-parse", "HEAD").trim();
    const next = sample();

    next.metrics["turn.warm/sql.rows"]!.baselines!["darwin-arm64"] = 101;
    writeLedger(path, next);
    const historical = parseLedger(git("show", `${revision}:ledger.json`), (name) =>
        git("show", `${revision}:${name}`),
    );

    assert.deepEqual(historical, before);
    assert.deepEqual(readLedger(path), next);
});

test("an oversized domain is refused before changing any ledger output", (t) => {
    const { path } = fixture(t);
    const before = readFileSync(path, "utf8");
    const large = sample();

    large.metrics["turn.warm/sql.rows"]!.workload = "x".repeat(20_000);
    assert.throws(() => writeLedger(path, large), /Ledger domain exceeds 20000 bytes/);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.equal(existsSync(join(dirname(path), "ledger")), false);
});

test("updating a bounded ledger removes only parts no longer owned by its index", (t) => {
    const { path, root } = fixture(t);
    const before = sample();

    writeLedger(path, before);
    writeFileSync(join(root, "unrelated.json"), "keep");
    const next = sample();

    delete next.metrics["turn.warm/sql.rows"];
    writeLedger(path, next);
    assert.deepEqual(readLedger(path), next);
    assert.equal(existsSync(join(root, "ledger/turn.warm.system.json")), false);
    assert.equal(readFileSync(join(root, "unrelated.json"), "utf8"), "keep");
});

test("real ratchet CLI writes bounded propose/register results and guards legacy and indexed snapshots", (t) => {
    const { path, root } = fixture(t);
    const source = fileURLToPath(new URL("./perf/", import.meta.url));

    for (const name of [
        "ratchet.ts",
        "ratchet-core.ts",
        "ratchet-comparison.ts",
        "ratchet-cli.ts",
        "ledger.ts",
    ]) {
        cpSync(join(source, name), join(root, name));
    }

    const invoke = (...args: string[]) =>
        spawnSync(process.execPath, [join(root, "ratchet.ts"), ...args], { encoding: "utf8" });
    const initial = sample();
    const base = join(root, "base.json");

    writeFileSync(base, JSON.stringify(initial));
    const report = {
        schema: 1,
        revision: "fixture",
        platform: "darwin-arm64",
        inject: null,
        workload: {},
        observations: Object.values(initial.metrics).map((entry) => ({
            scenario: entry.scenario,
            metric: entry.metric,
            layer: entry.layer,
            unit: entry.unit,
            workload: entry.workload,
            source: entry.source,
            availability: "measured",
            runs: [entry.status === "gating" ? 2 : 80],
        })),
        timings: [],
    };
    const reportPath = join(root, "report.json");

    writeFileSync(reportPath, JSON.stringify(report));
    const tightened = invoke("propose", reportPath, "--write");

    assert.equal(tightened.status, 0, tightened.stderr);
    assert.equal(readLedger(path).metrics["git.changes/subprocess.git"]!.ceiling, 2);
    assert.deepEqual(readLedger(path).metrics["turn.warm/sql.rows"]!.baselines, {
        "darwin-arm64": 80,
        "linux-x64": 90,
    });
    assert.equal(invoke("guard", base, path).status, 0);

    report.observations.push({
        scenario: "new.scenario",
        metric: "http.requests",
        layer: "http",
        unit: "count",
        workload: "fixed new work",
        source: "synthetic HTTP boundary",
        availability: "measured",
        runs: [12],
    });
    writeFileSync(reportPath, JSON.stringify(report));
    const registered = invoke("register", reportPath, "--write");

    assert.equal(registered.status, 0, registered.stderr);
    assert.equal(readLedger(path).metrics["new.scenario/http.requests"]!.status, "candidate");
    assert.equal(
        readLedger(path).metrics["new.scenario/http.requests"]!.baselines!["darwin-arm64"],
        12,
    );
    assert.equal(invoke("guard", base, path).status, 0);

    const loosened = readLedger(path);

    loosened.metrics["turn.warm/sql.rows"]!.baselines!["darwin-arm64"] = 101;
    writeLedger(path, loosened);
    const rejected = invoke("guard", base, path);

    assert.equal(rejected.status, 1, rejected.stderr);
    assert.match(rejected.stdout, /needs-approval/);
});
