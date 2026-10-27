/** Focused version of the model-switch scenarios. The full suite runs the same fixture. */
import { raw, snapshot, since, nativeTimingSnapshot, nativeTimingSince } from "./counters.ts";
import { measureModelSwitch } from "./model-switch.ts";
import { SCENARIOS } from "./workload.ts";
import { buildReport, formatReport, revision } from "./measure.ts";
import { prepareCheckout, removeCheckout } from "./checkout.ts";
import { cleanUp } from "../helpers.ts";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import type { ScenarioResult } from "./scenarios.ts";

process.umask(0o077);

if (process.argv[2] === "--sample") {
    const results: ScenarioResult[] = [];

    const quiet = async () => {
        const started = performance.now();
        let last = snapshot();
        let calmSince = performance.now();

        while (performance.now() - calmSince < 400) {
            if (performance.now() - started > 20_000) {
                throw new Error("Model-switch fixture did not become quiet");
            }

            await new Promise((resolve) => setTimeout(resolve, 50));
            const now = snapshot();

            if (
                now["push.events"] !== last["push.events"] ||
                now["sql.statements"] !== last["sql.statements"]
            ) {
                calmSince = performance.now();
            }

            last = now;
        }
    };

    await measureModelSwitch(async (scenario, action) => {
        await quiet();
        const before = snapshot();
        const nativeBefore = nativeTimingSnapshot();
        const started = performance.now();

        await action();
        const ms = performance.now() - started;
        const extra = nativeTimingSince(nativeBefore);

        await quiet();
        results.push({ scenario, ms, counts: since(before), extra });
    });

    for (const scenario of Object.keys(SCENARIOS)) {
        if (!results.some((result) => result.scenario === scenario)) {
            results.push({ scenario, unavailable: "not part of the focused model-switch run" });
        }
    }

    writeFileSync(process.argv[3]!, raw.stringify(results));
    cleanUp();
} else {
    const out = process.argv[2];
    const count = Number(process.argv[3] ?? 5);

    if (!out || !Number.isInteger(count) || count < 1) {
        throw new Error(
            "Usage: node test/perf/model-switch-measure.ts <out.json> [runs=5] [base-ref]",
        );
    }

    const scratch = mkdtempSync(join(tmpdir(), "model-switch-measure-"));
    const baseRef = process.argv[4];
    const checkout = prepareCheckout(baseRef ?? "HEAD", { workingTree: baseRef === undefined });
    const before = loadavg();
    const runs: ScenarioResult[][] = [];

    try {
        for (let index = 0; index < count; index++) {
            const file = join(scratch, `${index}.json`);
            const child = spawn(
                process.execPath,
                [join(checkout, "test/perf/model-switch-measure.ts"), "--sample", file],
                { cwd: checkout, stdio: "inherit" },
            );
            const code = await new Promise((resolve) => child.once("exit", resolve));

            if (code !== 0) {
                throw new Error(`Model-switch sample failed: ${code}`);
            }

            runs.push(raw.parse(readFileSync(file, "utf8")));
        }

        const report = buildReport(runs, {
            revision: baseRef ?? revision(),
            platform: `${process.platform}-${process.arch}`,
            node: process.versions.node,
            cpu: `${cpus()[0]!.model} (${cpus().length} cores)`,
            load: { before, after: loadavg(), cores: cpus().length },
            inject: null,
        });

        writeFileSync(out, raw.stringify(report, null, 2));
        console.log(formatReport(report));
    } finally {
        removeCheckout(checkout);
        rmSync(scratch, { recursive: true, force: true });
    }
}
