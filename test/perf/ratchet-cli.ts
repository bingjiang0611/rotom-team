import { readFileSync } from "node:fs";
import { check, propose, register, guard } from "./ratchet-core.ts";
import { compare, formatCheck, formatComparison } from "./ratchet-comparison.ts";
import { LEDGER, readLedger, writeLedger } from "./ledger.ts";
import type { Report } from "./measure.ts";

const readJson = <T>(path: string) => JSON.parse(readFileSync(path, "utf8")) as T;

export function runRatchetCli(): void {
    const [command, first, second] = process.argv.slice(2);
    const usage =
        "Usage: node test/perf/ratchet.ts check <report> | propose <report> [--write] | register <report…> [--write] | guard <base-ledger> <head-ledger> | compare <base-report> <head-report>";

    try {
        if (command === "check" && first !== undefined) {
            const report = readJson<Report>(first);
            const result = check(readLedger(LEDGER), report);

            console.log(formatCheck(result, report));
            process.exitCode = result.passed ? 0 : 1;
        } else if (command === "propose" && first !== undefined) {
            const { ledger, changes } = propose(readLedger(LEDGER), readJson<Report>(first));

            console.log(JSON.stringify(changes, null, 2));

            if (process.argv.includes("--write")) {
                writeLedger(LEDGER, ledger);
                console.log(`Wrote ${LEDGER}`);
            }
        } else if (command === "register" && first !== undefined) {
            const paths = process.argv.slice(3).filter((arg) => arg !== "--write");
            const { ledger, added } = register(
                readLedger(LEDGER),
                paths.map((path) => readJson<Report>(path)),
            );

            console.log(JSON.stringify(added, null, 2));

            if (process.argv.includes("--write")) {
                writeLedger(LEDGER, ledger);
                console.log(`Wrote ${LEDGER}`);
            }
        } else if (command === "guard" && first !== undefined && second !== undefined) {
            const result = guard(
                readLedger(first),
                readLedger(second),
                process.env.ROTOM_TEAM_PERF_RAISE_APPROVED === "1",
            );

            console.log(JSON.stringify(result, null, 2));
            process.exitCode = result.passed ? 0 : 1;
        } else if (command === "compare" && first !== undefined && second !== undefined) {
            const base = readJson<Report>(first);
            const head = readJson<Report>(second);

            const ledger = readLedger(LEDGER);

            console.log(formatComparison(compare(base, head, ledger), base, head));
        } else {
            throw new Error(usage);
        }
    } catch (error) {
        console.error((error as Error).message);
        process.exitCode = 1;
    }
}
