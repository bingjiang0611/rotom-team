/**
 * Run the controlled benchmarks and write a report: `npm run perf:measure -- [--runs N] [--out FILE]`.
 *
 * The runs use a temporary checkout of what is on disk (`checkout.ts`): counters depend on the checkout's path length.
 * Each run is a fresh process (`scenarios.ts`) on fresh temporary data, so one run's caches never help the next. The
 * report has every reported counter of every run (the ledger's observations), and each scenario's milliseconds.
 * Milliseconds move with machine load: the report records the load average before and after, and only counters can
 * fail a check (`ratchet.ts`).
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareCheckout, removeCheckout, REPO } from "./checkout.ts";
import type { ScenarioResult } from "./scenarios.ts";
import { metricSpec, REPORTED, SCENARIOS, WORKLOAD } from "./workload.ts";

export type Observation = {
    scenario: string;
    metric: string;
    layer: string;
    unit: string;
    workload: string;
    source: string;
} & (
    { availability: "measured"; runs: number[] } | { availability: "unavailable"; reason: string }
);

export type Timing = { scenario: string; metric: string; runs: number[]; median: number };

export type Report = {
    schema: 1;
    revision: string;
    platform: string;
    node: string;
    cpu: string;
    load: { before: number[]; after: number[]; cores: number };
    runs: number;
    /** A deliberate regression the runs carried (`ROTOM_TEAM_PERF_INJECT`), or null: such a report proves a check fails. */
    inject: string | null;
    workload: typeof WORKLOAD;
    observations: Observation[];
    timings: Timing[];
};

const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const round = (value: number) => Math.round(value * 10) / 10;

export function revision(cwd = REPO): string {
    const head = execFileSync("git", ["-C", cwd, "rev-parse", "--short=12", "HEAD"], {
        encoding: "utf8",
    }).trim();
    const dirty = execFileSync("git", ["-C", cwd, "status", "--porcelain"], {
        encoding: "utf8",
    }).trim();

    return dirty === "" ? head : `${head}-dirty`;
}

/** Turn runs into a report. A scenario missing from any run is unavailable, with the run's reason. */
export function buildReport(
    runs: ScenarioResult[][],
    meta: Omit<Report, "schema" | "observations" | "timings" | "runs" | "workload">,
): Report {
    const observations: Observation[] = [];
    const timings: Timing[] = [];

    for (const [scenario, workload] of Object.entries(SCENARIOS)) {
        const results = runs.map((run) => run.find((result) => result.scenario === scenario));
        const missing = results.find((result) => result === undefined || "unavailable" in result);
        const reason =
            missing === undefined
                ? undefined
                : "unavailable" in missing
                  ? missing.unavailable
                  : "the scenario did not run";
        const measured = results as Extract<ScenarioResult, { ms: number }>[];

        for (const metric of REPORTED[scenario]!) {
            const spec = metricSpec(metric);
            const base = { scenario, metric, ...spec, workload };

            observations.push(
                reason === undefined
                    ? {
                          ...base,
                          availability: "measured",
                          // A counter that never moved did no work: the counter was on, so that is a real zero.
                          runs: measured.map((result) => result.counts[metric] ?? 0),
                      }
                    : { ...base, availability: "unavailable", reason },
            );
        }

        if (reason !== undefined) {
            continue;
        }

        // Preserve transport/serialization work without changing the workload or its ratcheted keys.
        const storageMetrics = new Set(
            measured
                .flatMap((result) => Object.keys(result.counts))
                .filter(
                    (metric) => metric.startsWith("storage.worker.") || metric.startsWith("v8."),
                ),
        );

        for (const metric of storageMetrics) {
            const values = measured.map((result) => result.counts[metric]);
            const base = {
                scenario,
                metric,
                layer: "cpu",
                unit: metric.toLowerCase().endsWith("bytes") ? "bytes" : "count",
                source: "parent/worker V8 calls and encoded transport bytes (test/perf/counters.ts)",
                workload,
            };

            observations.push(
                values.every((value) => value !== undefined)
                    ? { ...base, availability: "measured", runs: values }
                    : {
                          ...base,
                          availability: "unavailable",
                          reason: "counter missing from a run",
                      },
            );
        }

        const ms = measured.map((result) => round(result.ms));

        timings.push({ scenario, metric: "ms", runs: ms, median: median(ms) });

        for (const name of Object.keys(measured[0]!.extra ?? {})) {
            if (name.endsWith("Ms")) {
                const values = measured.map((result) => round(result.extra?.[name] ?? 0));

                timings.push({ scenario, metric: name, runs: values, median: median(values) });
            }
        }
    }

    return { schema: 1, ...meta, runs: runs.length, workload: WORKLOAD, observations, timings };
}

/** One run, in a fresh process, of the prepared checkout at `repo` (`checkout.ts`). */
export async function runOnce(file: string, repo: string): Promise<ScenarioResult[]> {
    const preload =
        process.env.ROTOM_PERF_STORAGE_WORKER === "1"
            ? ["--import", join(repo, "test", "perf", "storage-worker-preload.ts")]
            : [];
    const child = spawn(
        process.execPath,
        [...preload, join(repo, "test", "perf", "scenarios.ts"), file],
        {
            cwd: repo,
            stdio: ["ignore", "inherit", "inherit"],
        },
    );
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));

    if (code !== 0) {
        throw new Error(`A benchmark run failed (exit ${code}); see its output above.`);
    }

    return (JSON.parse(readFileSync(file, "utf8")) as { results: ScenarioResult[] }).results;
}

export function formatReport(report: Report): string {
    const lines = [
        `Revision ${report.revision} · ${report.platform} · node ${report.node} · ${report.runs} runs${report.inject === null ? "" : ` · INJECTED: ${report.inject}`}`,
        `Load ${report.load.before.map(round).join("/")} → ${report.load.after.map(round).join("/")} on ${report.load.cores} cores`,
        "",
        "scenario           ms (median of runs)",
    ];

    for (const timing of report.timings.filter((each) => each.metric === "ms")) {
        lines.push(
            `  ${timing.scenario.padEnd(17)}${String(timing.median).padStart(9)}   ${timing.runs.join(", ")}`,
        );
    }

    const unavailable = report.observations.filter((each) => each.availability === "unavailable");

    for (const scenario of new Set(unavailable.map((each) => each.scenario))) {
        lines.push(
            `  ${scenario.padEnd(17)}  unavailable: ${(unavailable.find((each) => each.scenario === scenario) as { reason: string }).reason}`,
        );
    }

    return lines.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);

    const option = (name: string) => {
        const index = args.indexOf(name);

        return index < 0 ? undefined : args[index + 1];
    };

    const count = Number(option("--runs") ?? 3);
    const rev = revision();
    const out = option("--out") ?? join(REPO, "perf-results", `${rev}.json`);

    if (!Number.isInteger(count) || count < 1) {
        throw new Error("--runs takes a whole number");
    }

    const scratch = mkdtempSync(join(tmpdir(), "rotom-team-perf-runs-"));
    const checkout = prepareCheckout("HEAD", { workingTree: true });
    const before = loadavg();
    const runs: ScenarioResult[][] = [];

    try {
        for (let index = 0; index < count; index++) {
            console.error(`Run ${index + 1} of ${count}…`);
            runs.push(await runOnce(join(scratch, `run-${index}.json`), checkout));
        }
    } finally {
        removeCheckout(checkout);
        rmSync(scratch, { recursive: true, force: true });
    }

    const report = buildReport(runs, {
        revision: rev,
        platform: `${process.platform}-${process.arch}`,
        node: process.versions.node,
        cpu: `${cpus()[0]?.model ?? "unknown"} (${cpus().length} cores)`,
        load: { before, after: loadavg(), cores: cpus().length },
        inject: process.env.ROTOM_TEAM_PERF_INJECT ?? null,
    });

    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(formatReport(report));
    console.log(`\nReport: ${out}`);
}
