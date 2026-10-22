/**
 * Read the daily performance journal (`<data>/performance/`, see src/server/perf-journal.ts): where do people wait?
 *
 *   node test/perf/report.ts snapshot <data-dir> <out-dir>     copy the journal files, never touching the source
 *   node test/perf/report.ts report <dir> [--since ISO] [--release COMMIT] [--json]
 *
 * Work from a snapshot: the running service keeps appending and archiving. The report ranks routes by total time
 * spent (count × duration: what people waited for altogether), and gives native runs (and the phases of prompt
 * runs), browser waits, the event loop, memory, and pushed bytes. A group with fewer than 30 samples is marked: too
 * few to call a change.
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import type { PerformanceObservation, PerformanceRecord } from "../../src/server/perf-journal.ts";

const JOURNAL_FILE = /^performance-(?:0|\d{8}T\d{9}Z-[0-9a-f]{8})\.jsonl(?:\.gz)?$/;

export const FEW = 30;

export function snapshot(dataDir: string, out: string): string[] {
    const source = join(dataDir, "performance");
    const names = readdirSync(source).filter((name) => JOURNAL_FILE.test(name));

    mkdirSync(out, { recursive: true, mode: 0o700 });

    for (const name of names) {
        copyFileSync(join(source, name), join(out, name));
    }

    return names;
}

/** Every complete record in `dir`; a line a crash cut short is counted, not guessed at. */
export function readJournal(dir: string): { records: PerformanceRecord[]; truncated: number } {
    const records: PerformanceRecord[] = [];
    let truncated = 0;

    for (const name of readdirSync(dir)
        .filter((each) => JOURNAL_FILE.test(each))
        .sort()) {
        const bytes = readFileSync(join(dir, name));
        const text = (name.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8");

        for (const line of text.split("\n")) {
            if (line === "") {
                continue;
            }

            try {
                records.push(JSON.parse(line) as PerformanceRecord);
            } catch {
                truncated++;
            }
        }
    }

    records.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));

    return { records, truncated };
}

const quantile = (values: number[], q: number) => {
    if (values.length === 0) {
        return null;
    }

    const sorted = [...values].sort((a, b) => a - b);

    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};

type Stats = {
    count: number;
    p50: number | null;
    p95: number | null;
    max: number | null;
    totalMs: number;
    few: boolean;
};

const stats = (values: number[]): Stats => ({
    count: values.length,
    p50: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    max: values.length === 0 ? null : values.reduce((most, value) => Math.max(most, value)),
    totalMs: Math.round(values.reduce((sum, value) => sum + value, 0)),
    few: values.length < FEW,
});

type Of<K extends PerformanceObservation["kind"]> = Extract<PerformanceObservation, { kind: K }>;

export function analyse(records: PerformanceRecord[]) {
    const of = <K extends PerformanceObservation["kind"]>(kind: K) =>
        records
            .map((record) => record.observation)
            .filter((each): each is Of<K> => each.kind === kind);

    const group = <T>(items: T[], key: (item: T) => string) => {
        const groups = new Map<string, T[]>();

        for (const item of items) {
            const name = key(item);
            const list = groups.get(name);

            if (list === undefined) {
                groups.set(name, [item]);
            } else {
                list.push(item);
            }
        }

        return groups;
    };

    const routes = [...group(of("http"), (each) => `${each.method} ${each.route}`)]
        .map(([route, items]) => ({
            route,
            ...stats(items.map((each) => each.ms)),
            errors: items.filter((each) => each.status >= 500).length,
            meanWireBytes: Math.round(
                items.reduce((sum, each) => sum + (each.wireBytes ?? 0), 0) / items.length,
            ),
        }))
        .sort((a, b) => b.totalMs - a.totalMs);
    const runs = [...group(of("kernel-run"), (each) => each.outcome)]
        .map(([outcome, items]) => ({ outcome, ...stats(items.map((each) => each.ms)) }))
        .sort((a, b) => b.totalMs - a.totalMs);
    // Prompt runs split into phases, apart for a new native process and the session's running one.
    const prompts = [
        ...group(
            of("kernel-run").filter((each) => each.prompt !== undefined),
            (each) => each.prompt!.process,
        ),
    ].map(([process, items]) => {
        const phases = items.map((each) => each.prompt!);
        const totalMs = items.reduce((sum, each) => sum + each.ms, 0);

        return {
            process,
            runs: items.length,
            dispatch: stats(phases.map((each) => each.dispatchMs)),
            firstOutput: stats(phases.flatMap((each) => each.firstOutputMs ?? [])),
            noOutput: phases.filter((each) => each.firstOutputMs === null).length,
            // Share of these runs' time with a tool running; the rest is setup, the model, and finalization.
            toolShare:
                totalMs === 0
                    ? null
                    : Math.round(
                          (phases.reduce((sum, each) => sum + each.toolMs, 0) / totalMs) * 100,
                      ) / 100,
            tools: phases.reduce((sum, each) => sum + each.tools, 0),
        };
    });
    const webTimings = of("web");
    const web = [...group(webTimings, (each) => `${each.name} ${each.transport}`)]
        .map(([wait, items]) => ({
            wait,
            ...stats(items.flatMap((each) => ("ms" in each ? [each.ms] : []))),
            hidden: items.filter((each) => "unavailable" in each).length,
        }))
        .sort((a, b) => a.wait.localeCompare(b.wait));
    const transports = [
        ...group(of("transport"), (each) => `${each.transition} ${each.from}->${each.to}`),
    ]
        .map(([transition, items]) => ({ transition, count: items.length }))
        .sort((a, b) => a.transition.localeCompare(b.transition));
    const samples = of("process");
    const pushes = new Map<string, { count: number; bytes: number; sized: number }>();
    let pushMs = 0;

    for (const push of of("push")) {
        pushMs += push.intervalMs;

        for (const [event, tally] of Object.entries(push.events)) {
            const total = pushes.get(event) ?? { count: 0, bytes: 0, sized: 0 };

            total.count += tally.count;
            total.bytes += tally.bytes;
            total.sized += tally.sized;
            pushes.set(event, total);
        }
    }

    // Push records exist only for minutes with pushes, so "per minute" is per active minute.
    const minutes = pushMs / 60_000;

    return {
        span: { from: records[0]?.recordedAt ?? null, to: records.at(-1)?.recordedAt ?? null },
        sessions: new Set(records.map((record) => record.session)).size,
        releases: [...new Set(records.map((record) => record.release ?? "checkout"))],
        startups: stats(of("startup").map((each) => each.openMs)),
        routes,
        runs,
        prompts,
        web,
        transports,
        eventLoop: {
            samples: samples.length,
            p99Median: quantile(
                samples.map((each) => each.eventLoopDelayMs.p99),
                0.5,
            ),
            p99Worst: quantile(
                samples.map((each) => each.eventLoopDelayMs.p99),
                1,
            ),
            maxWorst:
                samples.length === 0
                    ? null
                    : Math.max(...samples.map((each) => each.eventLoopDelayMs.max)),
            utilizationMedian: quantile(
                samples.map((each) => each.eventLoopUtilization),
                0.5,
            ),
            utilizationWorst: quantile(
                samples.map((each) => each.eventLoopUtilization),
                1,
            ),
            rssWorstBytes:
                samples.length === 0 ? null : Math.max(...samples.map((each) => each.rssBytes)),
        },
        pushes: [...pushes]
            .map(([event, total]) => ({
                event,
                perActiveMinute: minutes === 0 ? null : Math.round(total.count / minutes),
                // Only stream frames are sized; long-polled events are counted without bytes.
                bytesPerActiveMinute: minutes === 0 ? null : Math.round(total.bytes / minutes),
                unsized: total.count - total.sized,
            }))
            .sort((a, b) => (b.bytesPerActiveMinute ?? 0) - (a.bytesPerActiveMinute ?? 0)),
        health: of("health").map((each) => each.droppedRecords),
    };
}

export function format(result: ReturnType<typeof analyse>, truncated: number): string {
    const ms = (value: number | null) => (value === null ? "-" : `${Math.round(value)}`);
    const few = (item: { few: boolean }) => (item.few ? `  (fewer than ${FEW} samples)` : "");

    return [
        `Journal ${result.span.from ?? "-"} → ${result.span.to ?? "-"} · ${result.sessions} server sessions · releases ${result.releases.join(", ")}${truncated > 0 ? ` · ${truncated} cut-off lines` : ""}`,
        `Startup (open ms): p50 ${ms(result.startups.p50)} · max ${ms(result.startups.max)} · ${result.startups.count} starts`,
        "",
        "Where people waited, by route (total ms = count × duration):",
        `  ${"route".padEnd(44)}${"count".padStart(7)}${"p50".padStart(8)}${"p95".padStart(8)}${"max".padStart(8)}${"total ms".padStart(11)}`,
        ...result.routes
            .slice(0, 20)
            .map(
                (each) =>
                    `  ${each.route.padEnd(44)}${String(each.count).padStart(7)}${ms(each.p50).padStart(8)}${ms(each.p95).padStart(8)}${ms(each.max).padStart(8)}${String(each.totalMs).padStart(11)}${each.errors > 0 ? `  ${each.errors}×5xx` : ""}${few(each)}`,
            ),
        "",
        "Native runs, by operation and outcome:",
        ...result.runs.map(
            (each) =>
                `  ${each.outcome.padEnd(28)}${String(each.count).padStart(6)} runs · p50 ${ms(each.p50)} · p95 ${ms(each.p95)} · max ${ms(each.max)} ms${few(each)}`,
        ),
        "",
        "Native prompt runs, by phase (dispatch: admission to prompt; first output: prompt to the model's first output):",
        ...result.prompts.map(
            (each) =>
                `  ${`${each.process} process`.padEnd(18)}${String(each.runs).padStart(6)} runs · dispatch p50 ${ms(each.dispatch.p50)} p95 ${ms(each.dispatch.p95)} · first output p50 ${ms(each.firstOutput.p50)} p95 ${ms(each.firstOutput.p95)}${each.noOutput > 0 ? ` (${each.noOutput} without)` : ""} · tools ${each.tools}, ${each.toolShare === null ? "-" : `${Math.round(each.toolShare * 100)}%`} of run time${few(each.dispatch)}`,
        ),
        "",
        "Browser waits, action to the store state or paint that ends it (by transport):",
        ...result.web.map(
            (each) =>
                `  ${each.wait.padEnd(26)}${String(each.count).padStart(6)} · p50 ${ms(each.p50)} · p95 ${ms(each.p95)} · max ${ms(each.max)} ms${each.hidden > 0 ? ` · ${each.hidden} hidden, unmeasured` : ""}${few(each)}`,
        ),
        "",
        "Browser transport transitions:",
        ...result.transports.map(
            (each) => `  ${each.transition.padEnd(48)}${String(each.count).padStart(6)}`,
        ),
        "",
        `Event loop over ${result.eventLoop.samples} minute samples: delay p99 median ${result.eventLoop.p99Median ?? "-"} ms, worst ${result.eventLoop.p99Worst ?? "-"} ms, longest stall ${result.eventLoop.maxWorst ?? "-"} ms; busy median ${result.eventLoop.utilizationMedian ?? "-"}, worst ${result.eventLoop.utilizationWorst ?? "-"}; RSS worst ${result.eventLoop.rssWorstBytes === null ? "-" : `${Math.round(result.eventLoop.rssWorstBytes / 1048576)} MiB`}`,
        "",
        "Pushed to tabs, per active minute:",
        ...result.pushes.map(
            (each) =>
                `  ${each.event.padEnd(16)}${String(each.perActiveMinute ?? "-").padStart(7)} events  ${String(each.bytesPerActiveMinute ?? "-").padStart(10)} bytes${each.unsized > 0 ? `  (${each.unsized} long-polled, unsized)` : ""}`,
        ),
        ...(result.health.some((dropped) => dropped > 0)
            ? ["", `Dropped records at shutdown: ${result.health.join(", ")}`]
            : []),
    ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const [command, first, second] = process.argv.slice(2);

    const option = (name: string) => {
        const index = process.argv.indexOf(name);

        return index < 0 ? undefined : process.argv[index + 1];
    };

    if (command === "snapshot" && first !== undefined && second !== undefined) {
        console.log(`Copied ${snapshot(first, second).length} journal files to ${second}`);
    } else if (command === "report" && first !== undefined) {
        const { records, truncated } = readJournal(first);
        const since = option("--since");
        const release = option("--release");
        const chosen = records.filter(
            (record) =>
                (since === undefined || record.recordedAt >= since) &&
                (release === undefined || record.release === release),
        );
        const result = analyse(chosen);

        console.log(
            process.argv.includes("--json")
                ? JSON.stringify(result, null, 2)
                : format(result, truncated),
        );
    } else {
        console.error(
            "Usage: node test/perf/report.ts snapshot <data-dir> <out-dir> | report <dir> [--since ISO] [--release COMMIT] [--json]",
        );
        process.exitCode = 1;
    }
}
