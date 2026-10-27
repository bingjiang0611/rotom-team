import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import {
    parseSendContext,
    sendPhase,
    sendPhaseChannel,
    sendTraceTag,
    type SendPhaseSignal,
} from "../src/server/send-trace.ts";
import { performanceEnvironment, type PerformanceRecord } from "../src/server/perf-journal.ts";
import { analyseSends } from "./perf/report.ts";

const timings = [{ name: "send.shown" as const, transport: "stream" as const, ms: 123 }];

test("send tags isolate members, conversations and process lifetimes without storing identities", async () => {
    const tag = sendTraceTag("1", "member:private-request");

    assert.match(tag, /^[a-f0-9]{32}$/);
    assert.equal(tag, sendTraceTag("1", "member:private-request"));
    assert.notEqual(tag, sendTraceTag("2", "member:private-request"));
    assert.notEqual(tag, sendTraceTag("1", "another-member:private-request"));
    assert.notEqual(tag, sendTraceTag("1", "member:another-request"));
    const restarted = await import(
        new URL("../src/server/send-trace.ts?new-process-secret", import.meta.url).href
    );

    assert.notEqual(tag, restarted.sendTraceTag("1", "member:private-request"));
    const received: SendPhaseSignal[] = [];
    const listener = (message: unknown) => received.push(message as SendPhaseSignal);

    sendPhaseChannel.subscribe(listener);

    try {
        sendPhase("1", "member:private-request", "dispatch");
    } finally {
        sendPhaseChannel.unsubscribe(listener);
    }

    assert.equal(received.length, 1);
    assert.deepEqual(Object.keys(received[0]!).sort(), ["atMs", "phase", "trace"]);
    assert.equal(received[0]!.trace, tag);
    assert.ok(received[0]!.atMs >= 0);
    assert.doesNotMatch(JSON.stringify(received), /private-request|member/);
});

test("send timing envelopes have a closed bounded schema and bind the authenticated member", () => {
    assert.deepEqual(parseSendContext({ conversationId: 0, requestId: "r" }, "member", timings), {
        conversationId: 0,
        requestKey: "member:r",
    });

    for (const context of [
        null,
        [],
        { conversationId: 1 },
        { conversationId: 1, requestId: "" },
        { conversationId: 1, requestId: "#resume" },
        { conversationId: 1, requestId: "r".repeat(129) },
        { conversationId: -1, requestId: "r" },
        { conversationId: 0.1, requestId: "r" },
        { conversationId: "1", requestId: "r" },
        { conversationId: 1, requestId: "r", text: "private" },
        { conversationId: 1, requestId: "r", trace: "a".repeat(32) },
    ]) {
        assert.equal(parseSendContext(context, "member", timings), null, JSON.stringify(context));
    }

    assert.equal(
        parseSendContext({ conversationId: 1, requestId: "r" }, "member", [
            { name: "reply.first", transport: "stream", ms: 1 },
        ]),
        null,
        "reply detection is not an exact per-request proof",
    );
});

const fixture = (): PerformanceRecord[] => {
    const common = {
        ...performanceEnvironment(),
        schema: 1 as const,
        session: "server-one",
        recordedAt: "2026-10-27T10:00:00.000Z",
    };
    const trace = "a".repeat(32);
    const server = Object.entries({
        entered: 1000,
        admitted: 1010,
        reserved: 1030,
        dispatch: 1050,
        mirrored: 1100,
        returned: 1040,
    }).map(([phase, atMs]) => ({
        ...common,
        observation: { kind: "send-phase", phase, trace, atMs } as PerformanceRecord["observation"],
    }));
    const web = Object.entries({ "send.answered": 50, "send.arrived": 120, "send.shown": 130 }).map(
        ([name, ms]) => ({
            ...common,
            observation: {
                kind: "web",
                name,
                trace,
                ms,
                transport: "stream",
            } as PerformanceRecord["observation"],
        }),
    );

    return [...server, ...web];
};

test("paired sends subtract only same-clock phases; missing, duplicate, hidden and restarted traces stay unpaired", () => {
    const records = fixture();
    const paired = analyseSends(records);

    assert.equal(paired.complete, 1);
    assert.equal(paired.phases.find((p) => p.phase === "server.mirror stream")!.p50, 50);
    assert.equal(paired.phases.find((p) => p.phase === "web.paint stream")!.p50, 10);
    assert.equal(paired.phases.length, 8);
    assert.ok(paired.phases.every((p) => p.few));
    const other = records.map((record) => ({
        ...record,
        observation: {
            ...record.observation,
            trace: "b".repeat(32),
        } as PerformanceRecord["observation"],
    }));

    assert.equal(analyseSends([...records, ...other]).complete, 2);
    assert.equal(analyseSends([...records.slice(0, 6), ...other.slice(6)]).incomplete, 2);
    assert.equal(analyseSends(records.slice(1)).incomplete, 1);
    assert.equal(analyseSends([...records, records[0]!]).ambiguous, 1);
    assert.equal(
        analyseSends(records.map((r, i) => (i >= 6 ? { ...r, session: "restarted" } : r)))
            .incomplete,
        2,
    );
    const hidden = fixture();

    hidden[8]!.observation = {
        kind: "web",
        name: "send.shown",
        trace: "a".repeat(32),
        transport: "stream",
        unavailable: "hidden",
    };
    assert.equal(analyseSends(hidden).hidden, 1);
    const invalid = fixture();

    invalid[8]!.observation = {
        kind: "web",
        name: "send.shown",
        trace: "a".repeat(32),
        transport: "stream",
        ms: 110,
    };
    assert.equal(analyseSends(invalid).invalid, 1);
    const mixed = fixture();

    mixed[8]!.observation = {
        kind: "web",
        name: "send.shown",
        trace: "a".repeat(32),
        transport: "poll",
        ms: 130,
    };
    assert.equal(analyseSends(mixed).ambiguous, 1);
    assert.equal(analyseSends([]).total, 0);
});

test("a tab correlates only its own confirmed entry and never uploads content in a timing envelope", () => {
    const source = readFileSync(new URL("../web/perf.js", import.meta.url), "utf8");
    const reports: { send?: { requestId: string }; timings: { name: string }[] }[] = [];
    const events = new Map<string, () => void>();
    const frames: (() => void)[] = [];
    let now = 0;
    const perf = runInNewContext(
        `${source.replaceAll("export function ", "function ")}\n({sending, observe, sendAnswered})`,
        {
            document: {
                visibilityState: "visible",
                addEventListener: (name: string, fn: () => void) => events.set(name, fn),
            },
            addEventListener: (name: string, fn: () => void) => events.set(name, fn),
            performance: { now: () => now },
            requestAnimationFrame: (fn: () => void) => frames.push(fn),
            setTimeout: (fn: () => void, delay: number) => {
                if (delay === 0) {
                    fn();
                }

                return 1;
            },
            clearTimeout: () => {},
            fetch: (_url: string, init: { body: string }) => {
                reports.push(JSON.parse(init.body));

                return Promise.resolve();
            },
        },
    );
    const view = {
        conversation: { id: 1 },
        kernel: {},
        order: [] as number[],
        entries: new Map<number, { kind: string; requestId: string; text: string }>(),
    };
    const at = perf.sending(view, { requestId: "our-request", echoed: true });

    now = 10;
    perf.observe({ view, pendingSends: [{ conversationId: 1 }] });
    frames.splice(0).forEach((fn) => fn());
    now = 20;
    perf.sendAnswered(at);
    view.order.push(1);
    view.entries.set(1, { kind: "user", requestId: "another-request", text: "private words" });
    now = 30;
    perf.observe({ view });
    frames.splice(0).forEach((fn) => fn());
    events.get("pagehide")!();
    assert.ok(
        !reports
            .flatMap((r) => r.timings)
            .some((t) => t.name === "send.arrived" || t.name === "send.shown"),
    );
    view.order.push(2);
    view.entries.set(2, { kind: "user", requestId: "our-request", text: "private words" });
    now = 50;
    perf.observe({ view });
    frames.splice(0).forEach((fn) => fn());
    events.get("pagehide")!();
    const sent = reports.flatMap((r) => r.timings);

    assert.deepEqual(sent.map((t) => t.name).sort(), [
        "send.answered",
        "send.arrived",
        "send.echoed",
        "send.shown",
    ]);
    assert.ok(reports.every((r) => r.send?.requestId === "our-request"));
    assert.doesNotMatch(JSON.stringify(reports), /private words|another-request/);
});
