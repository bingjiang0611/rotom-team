// The browser /tree selector (web/native-tree.js over src/server/native-tree.ts) against the pinned terminal
// TreeSelectorComponent: the same rows, in the same order, for each filter, a search and a fold.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { nativeSessionManager } from "../src/server/rotom-kernel.ts";
import { nativeTreeNodes } from "../src/server/native-tree.ts";
import type { KernelEntry } from "../src/server/rotom-journal.ts";

type Line = {
    prefix: string;
    fold: string;
    active: string;
    label: string;
    labelTime: string;
    parts: [string, string][];
};
type View = {
    rows: unknown[];
    selected: number;
    line(row: unknown): Line;
    status(): string;
    setFilter(mode: string): void;
    search(query: string): void;
    move(step: number): void;
    foldOrUp(): void;
};
const MODULE: string = "../web/native-tree.js";
const { FILTERS, TreeView } = (await import(MODULE)) as {
    FILTERS: string[];
    TreeView: new (nodes: unknown, leafId: string | null) => View;
};

const packages = join(
    import.meta.dirname,
    "../runtime/rotom/node_modules/@bingjiang0611/rotom/runtime/pi/node_modules/@earendil-works",
);
const load = (path: string) => import(pathToFileURL(join(packages, path)).href);

let clock = Date.parse("2026-01-02T03:04:00Z");
const at = () => new Date((clock += 1000)).toISOString();
const entry = (
    id: string,
    parentId: string | null,
    fields: Record<string, unknown> & { type: string },
): KernelEntry => ({
    id,
    parentId,
    timestamp: at(),
    ...fields,
});
const user = (id: string, parentId: string | null, text: string) =>
    entry(id, parentId, { type: "message", message: { role: "user", content: text } });
const assistant = (id: string, parentId: string, content: unknown[], stopReason = "stop") =>
    entry(id, parentId, { type: "message", message: { role: "assistant", content, stopReason } });
const toolResult = (id: string, parentId: string, toolCallId: string) =>
    entry(id, parentId, {
        type: "message",
        message: { role: "toolResult", toolCallId, toolName: "bash", content: "ok" },
    });

/** Two abandoned branches, tool-only turns, settings entries, a label and a compaction. */
const entries = [
    entry("model", null, { type: "model_change", provider: "p", modelId: "m1" }),
    user("u1", "model", "first\nquestion"),
    assistant(
        "a1",
        "u1",
        [
            {
                type: "toolCall",
                id: "c1",
                name: "bash",
                arguments: { command: "ls -la\t" + "x".repeat(60) },
            },
        ],
        "toolUse",
    ),
    toolResult("r1", "a1", "c1"),
    assistant("a2", "r1", [{ type: "text", text: "first answer" }]),
    user("u2", "a2", "abandoned branch"),
    assistant("a3", "u2", [], "aborted"),
    user("u3", "a2", "second branch"),
    assistant(
        "a4",
        "u3",
        [
            {
                type: "toolCall",
                id: "c2",
                name: "read",
                arguments: { path: "/tmp/x.ts", offset: 5, limit: 10 },
            },
            {
                type: "toolCall",
                id: "c3",
                name: "custom_tool",
                arguments: { query: "y".repeat(50) },
            },
        ],
        "toolUse",
    ),
    toolResult("r2", "a4", "c2"),
    toolResult("r3", "r2", "c3"),
    entry("cmp", "r3", {
        type: "compaction",
        summary: "s",
        tokensBefore: 245_000,
        firstKeptEntryId: "u3",
    }),
    entry("cm", "cmp", {
        type: "custom_message",
        customType: "note",
        content: "custom text",
        display: true,
    }),
    entry("bs", "cm", { type: "branch_summary", fromId: "u2", summary: "branch summary text" }),
    user("u4", "bs", "third branch"),
    entry("lbl", "u4", { type: "label", targetId: "u3", label: "checkpoint" }),
    user("u5", "a2", "latest leaf"),
];

async function terminal(filter: string, keys: string[] = []) {
    const { SessionManager } = await nativeSessionManager();
    const agent = await load("pi-coding-agent/dist/index.js");
    const { KeybindingsManager } = await load("pi-coding-agent/dist/core/keybindings.js");
    const tui = await load("pi-tui/dist/index.js");

    agent.initTheme("dark", false);
    tui.setKeybindings(new KeybindingsManager());
    const manager = SessionManager.inMemory("/tmp", undefined, structuredClone(entries));
    const selector = new agent.TreeSelectorComponent(
        manager.getTree(),
        manager.getLeafId(),
        400,
        () => {},
        () => {},
        undefined,
        undefined,
        filter,
    );

    for (const key of keys) {
        selector.handleInput(key);
    }

    return selector
        .getTreeList()
        .render(1000)
        .map((line: string) => tui.stripAnsi?.(line) ?? line.replace(/\x1b\[[0-9;]*m/g, ""))
        .map((line: string) => line.trimEnd());
}

function browser(view: View) {
    const rows = view.rows.map((row, index) => {
        const line = view.line(row);

        return (
            (index === view.selected ? "› " : "  ") +
            line.prefix +
            line.fold +
            line.active +
            line.label +
            line.labelTime +
            line.parts.map(([, text]) => text).join("")
        ).trimEnd();
    });

    return [...rows, `  (${view.selected + 1}/${view.rows.length})${view.status()}`];
}

test("browser /tree rows match the pinned terminal selector for every filter", async () => {
    const { nodes, leafId } = nativeTreeNodes(entries);

    assert.equal(leafId, "u5");
    assert.ok(
        !JSON.stringify(nodes).includes("x".repeat(60)),
        "full tool arguments stay on the server",
    );

    for (const filter of FILTERS) {
        const view: View = new TreeView(nodes, leafId);

        if (filter !== "default") {
            view.setFilter(filter);
        }

        assert.deepEqual(browser(view), await terminal(filter), filter);
    }
});

test("browser /tree search and fold follow the terminal keys", async () => {
    const { nodes, leafId } = nativeTreeNodes(entries);
    const searched = new TreeView(nodes, leafId);

    searched.search("branch");
    assert.deepEqual(browser(searched), await terminal("default", [..."branch"]));
    assert.ok(browser(searched).some((line) => line.includes("[checkpoint] user: second branch")));

    const folded = new TreeView(nodes, leafId);

    folded.move(1);
    folded.foldOrUp();
    assert.deepEqual(browser(folded), await terminal("default", ["\x1b[B", "\x1b[1;3D"]));
    assert.ok(!browser(folded).some((line) => line.includes("(aborted)")), "the branch is folded");
    assert.ok(
        browser(folded).some((line) => line.includes("⊞")),
        "the fold is visible",
    );
});
