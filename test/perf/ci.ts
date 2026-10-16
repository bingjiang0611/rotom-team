/**
 * Before and after a change: `npm run perf:ci -- <base-ref> [--runs N] [--out DIR]`.
 *
 * Measures the base revision and this checkout (with its uncommitted edits), each in a temporary checkout with this
 * checkout's benchmark (`checkout.ts`), so both sides use one instrument at paths of one length. Runs alternate (base,
 * head, base, head, …) so that a change in the machine's load falls on both. Then:
 *
 * - the ratchet checks the head report against the head ledger (gating counters fail the change);
 * - the guard checks the ledger edit from base to head (loosening needs approval);
 * - the comparison lists counters that moved and milliseconds past the noise.
 *
 * Exits 1 when the check or the guard fails. A base that predates the benchmark cannot be measured: that is reported,
 * not compared. CI runs this on pull requests (.github/workflows/performance.yml); it runs the same on a laptop.
 */
import { execFileSync } from "node:child_process";
import {
    appendFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { prepareCheckout, removeCheckout, REPO } from "./checkout.ts";
import { buildReport, formatReport, type Report, revision, runOnce } from "./measure.ts";
import { check, compare, formatCheck, formatComparison, guard, type Ledger } from "./ratchet.ts";
import type { ScenarioResult } from "./scenarios.ts";

const args = process.argv.slice(2);

const option = (name: string) => {
    const index = args.indexOf(name);

    return index < 0 ? undefined : args[index + 1];
};

const baseRef = args[0];
const count = Number(option("--runs") ?? 3);
const out = option("--out") ?? join(REPO, "perf-results", "ci");

if (baseRef === undefined || baseRef.startsWith("--") || !Number.isInteger(count) || count < 1) {
    throw new Error("Usage: npm run perf:ci -- <base-ref> [--runs N] [--out DIR]");
}

const git = (...gitArgs: string[]) =>
    execFileSync("git", ["-C", REPO, ...gitArgs], { encoding: "utf8" }).trim();

const summary = (text: string) => {
    console.log(text);

    if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n\`\`\`\n${text}\n\`\`\`\n`);
    }
};

mkdirSync(out, { recursive: true });
const baseCommit = git("rev-parse", "--verify", `${baseRef}^{commit}`);

// The base's own ledger is what the head's ledger edit is guarded against.
let baseLedger: Ledger | undefined;

try {
    baseLedger = JSON.parse(git("show", `${baseCommit}:test/perf/ledger.json`)) as Ledger;
} catch {
    baseLedger = undefined;
}

const headLedger = JSON.parse(
    readFileSync(join(REPO, "test", "perf", "ledger.json"), "utf8"),
) as Ledger;

if (
    baseLedger === undefined ||
    !git("ls-tree", "--name-only", baseCommit, "src/server/perf-channels.ts")
) {
    summary(
        `Base ${baseRef} (${baseCommit.slice(0, 12)}) predates the performance benchmark: there is nothing to compare.`,
    );
    process.exit(0);
}

// Both sides from temporary checkouts at paths of one length (see checkout.ts): the head's carries the uncommitted edits.
const scratch = mkdtempSync(join(tmpdir(), "rotom-team-perf-runs-"));
const checkouts: { base?: string; head?: string } = {};

try {
    checkouts.base = prepareCheckout(baseCommit, { workingTree: false });
    checkouts.head = prepareCheckout("HEAD", { workingTree: true });

    const before = loadavg();
    const runs: { base: ScenarioResult[][]; head: ScenarioResult[][] } = { base: [], head: [] };

    for (let index = 0; index < count; index++) {
        console.error(`Run ${index + 1} of ${count}: base…`);
        runs.base.push(await runOnce(join(scratch, `base-${index}.json`), checkouts.base));
        console.error(`Run ${index + 1} of ${count}: head…`);
        runs.head.push(await runOnce(join(scratch, `head-${index}.json`), checkouts.head));
    }

    const meta = (rev: string) => ({
        revision: rev,
        platform: `${process.platform}-${process.arch}`,
        node: process.versions.node,
        cpu: `${cpus()[0]?.model ?? "unknown"} (${cpus().length} cores)`,
        load: { before, after: loadavg(), cores: cpus().length },
        inject: process.env.ROTOM_TEAM_PERF_INJECT ?? null,
    });
    const base: Report = buildReport(runs.base, meta(baseCommit.slice(0, 12)));
    const head: Report = buildReport(runs.head, meta(revision()));

    writeFileSync(join(out, "base.json"), `${JSON.stringify(base, null, 2)}\n`);
    writeFileSync(join(out, "head.json"), `${JSON.stringify(head, null, 2)}\n`);

    const checked = check(headLedger, head);
    const guarded = guard(
        baseLedger,
        headLedger,
        process.env.ROTOM_TEAM_PERF_RAISE_APPROVED === "1",
    );

    summary(formatReport(head));
    summary(formatComparison(compare(base, head, headLedger), base, head));
    summary(formatCheck(checked, head));
    summary(
        guarded.passed
            ? "Ledger guard: passed"
            : `Ledger guard: FAILED\n${guarded.violations.map((each) => `  ${each.key}: ${each.kind} (${each.reason})`).join("\n")}`,
    );
    console.log(`\nReports: ${out}`);
    process.exitCode = checked.passed && guarded.passed ? 0 : 1;
} finally {
    for (const path of [checkouts.base, checkouts.head]) {
        if (path !== undefined) {
            removeCheckout(path);
        }
    }

    rmSync(scratch, { recursive: true, force: true });
}
