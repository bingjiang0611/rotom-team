import assert from "node:assert/strict";
import { test } from "node:test";
import {
    currentParseWork,
    parseWithWork,
    parseWorkChannel,
    scopedParseObject,
    withParseWork,
} from "../src/server/perf-channels.ts";

test("parse attribution is opt-in, async-local, exclusive and receiver-safe", async () => {
    class Reader {
        #value = 7;
        read() {
            return { value: this.#value, scope: currentParseWork() };
        }
        async delayed(wait: Promise<unknown>) {
            await wait;

            return this.read();
        }
        fail() {
            throw new Error("fixture failure");
        }
    }

    const reader = new Reader();

    assert.equal(scopedParseObject("journal", reader), reader);
    assert.equal(withParseWork("http", currentParseWork), undefined);
    const subscriber = () => undefined;

    parseWorkChannel.subscribe(subscriber);

    try {
        const journal = scopedParseObject("journal", reader);

        assert.deepEqual(journal.read(), { value: 7, scope: "journal" });
        assert.equal(journal.read, journal.read, "wrappers have stable identity");
        assert.throws(() => journal.fail(), /fixture failure/);
        assert.equal(currentParseWork(), undefined);
        assert.equal(
            withParseWork("http", () => withParseWork("journal", currentParseWork)),
            "journal",
        );
        assert.deepEqual(parseWithWork("native-readback", '{"ok":true}'), { ok: true });
        assert.throws(() => parseWithWork("http", "invalid"), SyntaxError);
        assert.equal(currentParseWork(), undefined);
        let release!: () => void;
        const wait = new Promise<void>((resolve) => {
            release = resolve;
        });
        const first = journal.delayed(wait);
        const second = withParseWork("durable-storage", async () => {
            release();
            await wait;

            return currentParseWork();
        });

        assert.deepEqual(await first, { value: 7, scope: "journal" });
        assert.equal(await second, "durable-storage");
        assert.equal(currentParseWork(), undefined);
        const history = scopedParseObject("journal", { entries: currentParseWork });

        assert.equal(history.entries(), "journal-history");
    } finally {
        parseWorkChannel.unsubscribe(subscriber);
    }

    assert.equal(scopedParseObject("journal", reader), reader);
});

test("parse source counters partition calls/chars without changing JSON results", async () => {
    const { snapshot, since } = await import("./perf/counters.ts");
    const before = snapshot();
    const samples = [
        ["durable-storage", "durableStorage"],
        ["journal", "journal"],
        ["journal-history", "journalHistory"],
        ["journal-thinking", "journalThinking"],
        ["journal-segments", "journalSegments"],
        ["native-readback", "nativeReadback"],
        ["http", "http"],
    ] as const;

    for (const [scope] of samples) {
        assert.deepEqual(parseWithWork(scope, '{"value":2}'), { value: 2 });
    }

    assert.equal(JSON.parse("3"), 3);
    const counts = since(before);

    assert.equal(counts["json.parse.calls"], 8);
    assert.equal(counts["json.parse.chars"], 78);

    for (const [, source] of samples) {
        assert.equal(counts[`json.parse.${source}.calls`], 1);
        assert.equal(counts[`json.parse.${source}.chars`], 11);
    }

    assert.equal(counts["json.parse.other.calls"], 1);
    assert.equal(counts["json.parse.other.chars"], 1);
});
