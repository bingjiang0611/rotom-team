/** Measure NativeTail retained and peak parent memory in fresh, GC-enabled synthetic processes. No model accounts. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    appendFileSync,
    existsSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareCheckout, removeCheckout } from "./checkout.ts";
import { revision } from "./measure.ts";
import type { NativeTail, readNativeSnapshot } from "../../src/server/rotom-executions.ts";

export const MEMORY_CASES = {
    small: { entries: 128, chars: 120 },
    text: { entries: 128, chars: 64 * 1024 },
    images: { entries: 5, chars: 14 * 1024 * 1024 },
} as const;

type Sample = ReturnType<typeof process.memoryUsage> & {
    peakRss: number;
    parses: number;
    parseChars: number;
};

export async function sampleTailMemory(modulePath: string, kind: keyof typeof MEMORY_CASES) {
    // Always load the execution owner before sampling, on both layouts. D6 moves the tail without a re-export barrel.
    const owner = await import(pathToFileURL(modulePath).href);
    const tailModule = join(dirname(modulePath), "rotom-executions", "native-tail.ts");
    const runtime = (
        existsSync(tailModule) ? await import(pathToFileURL(tailModule).href) : owner
    ) as {
        NativeTail: typeof NativeTail;
        readNativeSnapshot: typeof readNativeSnapshot;
    };
    const gc = (globalThis as unknown as { gc?: () => void }).gc;

    assert.ok(gc, "run the probe child with --expose-gc");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tail-memory-")));
    const state = { sessionFile: join(root, "session.jsonl"), sessionId: "memory-fixture" };
    const { entries, chars } = MEMORY_CASES[kind];
    let tail: NativeTail | undefined;
    const parse = JSON.parse;
    let parses = 0;
    let parseChars = 0;

    const sample = (): Sample => {
        return {
            ...process.memoryUsage(),
            peakRss: process.resourceUsage().maxRSS * 1024,
            parses,
            parseChars,
        };
    };

    const idle = async () => {
        // End the async turn so last-call temporaries cannot masquerade as retained tail state. Two collections
        // settle Buffer/external accounting. This is a memory probe, not a timed server-workload shortcut.
        await new Promise<void>((resolve) => setImmediate(resolve));
        gc();
        gc();

        return sample();
    };

    const populate = () => {
        writeFileSync(
            state.sessionFile,
            JSON.stringify({ type: "session", version: 3, id: state.sessionId, cwd: root }) + "\n",
        );

        for (let i = 0; i < entries; i++) {
            appendFileSync(
                state.sessionFile,
                JSON.stringify({
                    type: "custom",
                    id: `entry-${i}`,
                    parentId: i === 0 ? null : `entry-${i - 1}`,
                    data: "A".repeat(chars),
                }) + "\n",
            );
        }
    };

    try {
        populate();
        JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
            parses++;
            parseChars += text.length;

            return parse(text, reviver);
        }) as typeof JSON.parse;
        const before = await idle();

        tail = new runtime.NativeTail(state.sessionFile, state.sessionId, root);
        assert.equal(tail.read().length, entries + 1);
        const afterRead = await idle();
        const atSnapshot: Sample[] = [];
        const afterSnapshot: Sample[] = [];

        for (let i = 0; i < 3; i++) {
            // The pre-reuse API ignores the fourth argument. Both revisions use the identical full-history workload.
            let snapshot: Awaited<ReturnType<typeof readNativeSnapshot>> | undefined =
                await runtime.readNativeSnapshot(
                    {
                        request: async (request) => {
                            assert.equal(request.since, `entry-${entries - 1}`);

                            return { entries: [], leafId: "entry-0" };
                        },
                    },
                    state,
                    root,
                    tail,
                );

            assert.equal(snapshot.entries.length, entries);
            assert.equal(snapshot.leafId, "entry-0");
            atSnapshot.push(sample());
            snapshot = undefined;
        }

        // No snapshot array may remain live at the idle measurement.
        afterSnapshot.push(await idle());
        appendFileSync(
            state.sessionFile,
            JSON.stringify({ type: "custom", id: "last", parentId: "entry-0", data: "end" }) + "\n",
        );
        assert.deepEqual(
            tail.read().map((entry) => entry.id),
            ["last"],
        );
        const afterAppend = await idle();

        tail = undefined;
        const afterRelease = await idle();

        return {
            kind,
            workload: MEMORY_CASES[kind],
            before,
            afterRead,
            atSnapshot,
            afterSnapshot,
            afterAppend,
            afterRelease,
        };
    } finally {
        JSON.parse = parse;
        tail = undefined;
        rmSync(root, { recursive: true, force: true });
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);

    if (args[0] === "--child") {
        const kind = args[2] as keyof typeof MEMORY_CASES;

        assert.ok(kind in MEMORY_CASES);
        console.log(JSON.stringify(await sampleTailMemory(args[1]!, kind)));
    } else {
        const option = (name: string) => args[args.indexOf(name) + 1];
        const ref = option("--ref");
        const runs = Number(option("--runs"));
        const out = option("--out");

        assert.ok(
            args.includes("--ref") && args.includes("--out") && Number.isInteger(runs) && runs > 0,
        );
        const rev = ref === "working" ? revision() : ref;
        const before = loadavg();
        const checkout = prepareCheckout(ref === "working" ? "HEAD" : ref!, {
            workingTree: ref === "working",
        });
        const results = [];

        try {
            for (let i = 0; i < runs; i++) {
                for (const kind of Object.keys(MEMORY_CASES)) {
                    results.push(
                        JSON.parse(
                            execFileSync(
                                process.execPath,
                                [
                                    "--expose-gc",
                                    join(checkout, "test/perf/native-tail-memory.ts"),
                                    "--child",
                                    join(checkout, "src/server/rotom-executions.ts"),
                                    kind,
                                ],
                                { cwd: checkout, encoding: "utf8", maxBuffer: 1024 * 1024 },
                            ),
                        ),
                    );
                }
            }
        } finally {
            removeCheckout(checkout);
        }

        writeFileSync(
            out!,
            JSON.stringify(
                {
                    schema: 1,
                    revision: rev,
                    runs,
                    node: process.versions.node,
                    platform: `${process.platform}-${process.arch}`,
                    cpu: cpus()[0]?.model,
                    load: { before, after: loadavg(), cores: cpus().length },
                    scope: "synthetic NativeTail parent process only; forced-GC retained heap and OS peak RSS, no server/native child/browser",
                    results,
                },
                null,
                2,
            ) + "\n",
        );
        console.log(`Memory report: ${out}`);
    }
}
