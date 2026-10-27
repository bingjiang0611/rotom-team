/** Bounded on-disk ledger parts; the ratchet still consumes the unchanged schema-1 metric map. */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validateLedger, type Entry, type Ledger } from "./ratchet-core.ts";

export const LEDGER = fileURLToPath(new URL("ledger.json", import.meta.url));
const MAX_BYTES = 20_000;

type Index = { schema: 2; fragments: string[] };

function fragmentName(name: string): string {
    if (
        typeof name !== "string" ||
        isAbsolute(name) ||
        normalize(name) !== name ||
        name.startsWith(`..${sep}`) ||
        !name.endsWith(".json")
    ) {
        throw new Error(`Invalid ledger fragment path: ${name}`);
    }

    return name;
}

/** Legacy blobs are needed for guard against pre-migration Git revisions and saved ledger snapshots. */
export function parseLedger(text: string, readFragment: (name: string) => string): Ledger {
    const document = JSON.parse(text) as Ledger | Index | null;

    if (document?.schema === 1) {
        return validateLedger(document);
    }

    if (document?.schema !== 2 || !Array.isArray(document.fragments)) {
        throw new Error("Unsupported ledger index schema");
    }

    const metrics: Ledger["metrics"] = {};
    const files = new Set<string>();

    for (const fragment of document.fragments) {
        fragmentName(fragment);

        if (files.has(fragment)) {
            throw new Error(`Duplicate ledger fragment: ${fragment}`);
        }

        files.add(fragment);
        const part = validateLedger(JSON.parse(readFragment(fragment)) as Ledger);

        for (const [key, entry] of Object.entries(part.metrics)) {
            if (Object.hasOwn(metrics, key)) {
                throw new Error(`Duplicate ledger metric: ${key}`);
            }

            metrics[key] = entry;
        }
    }

    return validateLedger({ schema: 1, metrics });
}

export function readLedger(path = LEDGER): Ledger {
    return parseLedger(readFileSync(path, "utf8"), (name) =>
        readFileSync(join(dirname(path), name), "utf8"),
    );
}

/** Each part owns a scenario and a counter responsibility, never an arbitrary range of entries. */
function domain(entry: Entry): string {
    if (entry.layer === "storage" || entry.layer === "process") {
        return "system";
    }

    if (["push", "http", "web"].includes(entry.layer)) {
        return "delivery";
    }

    if (entry.metric.startsWith("native.rpc.")) {
        return "native-runtime";
    }

    if (entry.metric.startsWith("json.parse.")) {
        const scope = entry.metric.split(".")[2]!;

        if (
            ["nativeReadback", "nativeJsonl", "nativeJsonlIngest", "nativeJsonlSnapshot"].includes(
                scope,
            )
        ) {
            return "native-history";
        }

        if (scope.startsWith("native")) {
            return "native-runtime";
        }

        if (scope === "durableStorage" || scope.startsWith("journal")) {
            return "journal";
        }
    }

    return "cpu";
}

/** Update an existing ledger. Validate every bounded output before changing any file; publish the index last. */
export function writeLedger(path: string, ledger: Ledger): void {
    validateLedger(ledger);
    const previous = JSON.parse(readFileSync(path, "utf8")) as Ledger | Index;
    const previousFiles = previous.schema === 2 ? previous.fragments.map(fragmentName) : [];
    const folder = basename(path, extname(path));
    const groups = new Map<string, Ledger["metrics"]>();

    for (const [key, entry] of Object.entries(ledger.metrics)) {
        const name = `${folder}/${encodeURIComponent(entry.scenario)}.${domain(entry)}.json`;
        let metrics = groups.get(name);

        if (!metrics) {
            metrics = {};
            groups.set(name, metrics);
        }

        metrics[key] = entry;
    }

    const files = [...groups.keys()].sort();
    const contents = files.map(
        (name) =>
            [
                name,
                `${JSON.stringify({ schema: 1, metrics: groups.get(name) }, null, 4)}\n`,
            ] as const,
    );
    const index = `${JSON.stringify({ schema: 2, fragments: files } satisfies Index, null, 4)}\n`;

    for (const [name, content] of [[basename(path), index], ...contents]) {
        if (Buffer.byteLength(content) > MAX_BYTES) {
            throw new Error(
                `Ledger domain exceeds ${MAX_BYTES} bytes: ${name}; split its responsibility`,
            );
        }
    }

    mkdirSync(join(dirname(path), folder), { recursive: true });

    for (const [name, content] of contents) {
        writeFileSync(join(dirname(path), name), content);
    }

    writeFileSync(path, index);

    for (const name of previousFiles) {
        if (!groups.has(name)) {
            rmSync(join(dirname(path), name));
        }
    }
}
