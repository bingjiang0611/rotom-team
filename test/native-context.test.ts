/** Browser /context allocation and number formatting against the pinned terminal's actual source. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

const WEB: string = "../web/context-usage.js";
const { buildContextMap, contextTokens, contextPercent, contextSpace } = await import(WEB);
const mapSource = readFileSync(
    new URL(
        "../runtime/rotom/node_modules/@bingjiang0611/rotom/extensions/third-party/node_modules/pi-context-view/src/ui/usage-map.ts",
        import.meta.url,
    ),
    "utf8",
);
const { buildUsageMap } = new Function(
    `${stripTypeScriptTypes(mapSource).replace(/^export /gm, "")}\nreturn {buildUsageMap};`,
)();
const source = readFileSync(
    new URL(
        "../runtime/rotom/node_modules/@bingjiang0611/rotom/extensions/third-party/node_modules/pi-context-view/src/ui/usage-view.ts",
        import.meta.url,
    ),
    "utf8",
);
// Execute the native formatters, not a second hand-authored expectation.
const { formatTokens, formatPercent } = new Function(
    `${stripTypeScriptTypes(source.slice(source.indexOf("export function formatTokens"))).replace(/^export /gm, "")}\nreturn {formatTokens, formatPercent};`,
)();

function usage(tokens: number[], window = 272_000, reserve = 16_384) {
    return {
        estimatedTokens: tokens.reduce((sum, value) => sum + value, 0),
        reported: { contextWindow: window },
        autoCompactReserveTokens: reserve,
        categories: tokens.map((value, index) => ({ id: `category-${index}`, tokens: value })),
    };
}

test("context map matches native cells for empty, mixed, full and overflowing windows", () => {
    const cases = [
        usage([]),
        usage([0]),
        usage([1, 2, 3]),
        usage([4_500, 1_400, 503, 420, 5_700, 69, 1_100, 24_900, 42_100, 178_600]),
        usage([100_000]),
        usage([272_000]),
        usage([300_000, 400_000]),
        usage([1], 1),
        usage([100], 1000, 2000),
        usage([100], 1000, 0),
    ];

    // Deterministic fractional boundaries: catches largest-overlap and 70% mixed-cell regressions.
    for (let i = 1; i <= 128; i++) {
        cases.push(usage([i * 219.7, i * 36.1, 3, i * 1789.3]));
    }

    for (const context of cases) {
        for (const [columns, rows] of [
            [16, 16],
            [4, 4],
            [13, 9],
        ]) {
            assert.deepEqual(
                buildContextMap(context, columns, rows),
                buildUsageMap(context, columns, rows),
                JSON.stringify(context),
            );
        }
    }
});

test("buffer stays at the window end, with free space between it and used cells", () => {
    const context = usage([64], 256, 16);
    const map = buildContextMap(context);

    assert.equal(map.cells.length, 256);
    assert.equal(map.cells[63].fill, "full");
    assert.equal(map.cells[64].fill, "free");
    assert.equal(map.cells[239].fill, "free");
    assert.equal(map.cells[240].fill, "buffer");
    assert.equal(map.cells[255].fill, "buffer");
    assert.deepEqual(contextSpace(context), { buffer: 16, free: 176 });
    assert.deepEqual(contextSpace(usage([250], 256, 16)), { buffer: 6, free: 0 });
    assert.deepEqual(contextSpace(usage([300], 256, 16)), { buffer: 0, free: 0 });
});

test("context numbers retain the terminal's precision, percentages use the true window", () => {
    for (const tokens of [
        0, 69, 951, 999, 1000, 3700, 43_800, 112_400, 272_000, 999_999, 1e6, 1e8,
    ]) {
        assert.equal(contextTokens(tokens), formatTokens(tokens));
        assert.equal(contextPercent(tokens, 272_000), formatPercent(tokens / 272_000));
    }

    assert.equal(contextTokens(112_400), "112.4k");
    assert.equal(contextPercent(4_500, 272_000), "1.7%");
    assert.equal(contextPercent(178_600, 272_000), "66%");
});

test("parity control detects a wrong mixed-cell threshold", () => {
    const webSource = readFileSync(new URL(WEB, import.meta.url), "utf8");
    const { buildContextMap: wrongMap } = new Function(
        `${webSource.replace(/^export /gm, "").replace("largest >= 0.7", "largest >= 0.5")}\nreturn {buildContextMap};`,
    )();
    const context = usage([0.6, 0.4], 256, 0);

    assert.deepEqual(buildContextMap(context), buildUsageMap(context, 16, 16));
    assert.notDeepEqual(wrongMap(context), buildUsageMap(context, 16, 16));
});

test("unknown window does not pretend to be zero or invent a map or percentage", () => {
    for (const window of [undefined, NaN, Infinity, 0, -1]) {
        const context = { ...usage([500]), reported: { contextWindow: window } };

        assert.equal(buildContextMap(context), undefined);
        assert.deepEqual(contextSpace(context), {});
        assert.equal(contextPercent(500, window), "unknown");
    }

    assert.equal(contextTokens(undefined), "unknown");
    assert.equal(contextTokens(NaN), "unknown");
    assert.equal(contextTokens(0), "0");
    assert.equal(contextPercent(0, 272_000), "0%");
});
