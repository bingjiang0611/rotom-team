// Browser counterpart of the native Goal manager. Actions keep using the native command grammar and payer gate.
import { useState } from "preact/hooks";
import { actions, attempt, closeSheet, store } from "../store.js";
import { html, Sheet } from "../ui.js";
import { NativeSelector } from "./native-selector.js";
import { nativeCommandAccepted, showNativeResult } from "./native-command.js";

/** Match the pinned Goal budget grammar, including its positive safe-integer limit. */
export function validGoalBudget(text) {
    const match = /^(\d+(?:\.\d+)?)([km])?$/iu.exec(text.trim());

    if (!match) {
        return false;
    }

    const scale =
        match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2]?.toLowerCase() === "k" ? 1_000 : 1;
    const tokens = Math.floor(Number(match[1]) * scale);

    return Number.isSafeInteger(tokens) && tokens > 0;
}

/** One literal token in Goal's quote-aware grammar. This is not a shell command. */
export function quoteGoalObjective(text) {
    return text
        .split("'")
        .map((part) => `'${part}'`)
        .join(`"'"`);
}

export function NativeGoalSheet() {
    const goal = store.state.view.nativeGoal?.goal;
    const [form, setForm] = useState(null);
    const [objective, setObjective] = useState("");
    const [budget, setBudget] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const openForm = (kind, withBudget = false) => {
        setObjective(kind === "edit" ? goal.text : "");
        setBudget(withBudget ? String(goal?.tokenBudget ?? "100k") : "");
        setError("");
        setForm({ kind, withBudget });
    };

    const execute = (args) =>
        attempt(async () => {
            setBusy(true);

            try {
                const wait = ["pause", "clear", "status"].includes(args);
                const result = await actions.submit(`/goal ${args}`, [], "steer", false, wait);

                if (nativeCommandAccepted(result)) {
                    closeSheet();
                }

                showNativeResult(result);
            } finally {
                setBusy(false);
            }
        });
    const items = [];
    const add = (value, label, description = "", disabled = false) =>
        items.push({ value, label, description, disabled });

    if (!goal || goal.status === "complete") {
        add("start", "Start a goal…");
        add("budget", "Start with token budget…");
    } else if (goal.waiting || goal.status !== "active") {
        if (goal.status === "budget_limited") {
            add(
                "editBudget",
                "Increase budget…",
                "Update the objective's token budget, then explicitly Resume.",
            );
        }

        add("resume", "Resume goal");
    } else {
        add("pause", "Pause goal");
    }

    if (goal && goal.status !== "complete") {
        add("edit", "Edit goal…");
        add("replace", "Replace goal…");
    }

    add("status", "View full status");
    add(
        "settings",
        "Settings…",
        "Native Goal safety settings have no Team RPC editor. Existing limits remain enforced.",
        true,
    );
    add("help", "Help");

    if (goal) {
        add("clear", "Clear goal…");
    }

    add("close", "Close");

    const choose = (item) => {
        switch (item.value) {
            case "start":
            case "replace":
                openForm("start");
                break;
            case "budget":
                openForm("start", true);
                break;
            case "edit":
                openForm("edit");
                break;
            case "editBudget":
                openForm("edit", true);
                break;
            case "clear":
                setForm({ kind: "clear" });
                break;
            case "help":
                setForm({ kind: "help" });
                break;
            case "close":
                closeSheet();
                break;
            default:
                return execute(item.value);
        }
    };

    const save = (event) => {
        event.preventDefault();

        if (form.withBudget && !validGoalBudget(budget)) {
            setError("Use a native token budget such as 25000, 100k or 1m.");

            return;
        }

        const value = objective.trim();
        const reserved = [
            "pause",
            "resume",
            "clear",
            "stop",
            "status",
            "edit",
            "add",
            "prioritize",
            "drop-last",
            "skip",
            "push",
            "unshift",
            "pop",
            "shift",
        ];

        if (
            !form.withBudget &&
            (value === "--tokens" || (form.kind === "start" && reserved.includes(value)))
        ) {
            setError(
                "That single-word objective is a native Goal control. Add context or choose Start with token budget.",
            );

            return;
        }

        const args = `${form.kind === "edit" ? "edit " : ""}${form.withBudget ? `--tokens ${budget.trim()} ` : ""}${quoteGoalObjective(value)}`;

        void execute(args);
    };

    const title = form
        ? form.kind === "clear"
            ? "Clear goal?"
            : form.kind === "help"
              ? "Goal help"
              : form.kind === "edit"
                ? "Edit goal"
                : "Start a goal"
        : `Goal · ${goal?.waiting ? "Waiting" : (goal?.status ?? "No recorded goal")}`;

    return html`<${Sheet} title=${title} onClose=${closeSheet}>
        ${
            !form &&
            html`
            ${goal && html`<p class="native-goal-objective">${goal.text}</p>`}
            ${goal?.waiting && html`<p class="muted">${goal.waiting.reason}</p>`}
            <${NativeSelector} items=${items} onChoose=${choose} searchable=${false} label="Goal actions" />
        `
        }
        ${
            form?.kind === "clear" &&
            html`
            <p>Clear the current goal? Conversation history is retained.</p>
            <button class="button" disabled=${busy} onClick=${() => execute("clear")}>Clear goal</button>
        `
        }
        ${
            form?.kind === "help" &&
            html`
            <pre class="native-command-output">${"/goal <objective>\n/goal --tokens 100k <objective>\n/goal pause\n/goal resume\n/goal edit <objective>\n/goal clear\n/goal status"}</pre>
            <p class="muted">Start and Resume use your selected model and account. Native safety limits and unknown-outcome fences remain enforced.</p>
        `
        }
        ${
            ["start", "edit"].includes(form?.kind) &&
            html`<form class="native-goal-form" onSubmit=${save}>
            <label class="field">Objective
                <textarea required maxlength="4000" value=${objective} onInput=${(event) => setObjective(event.currentTarget.value)} rows="4" />
            </label>
            ${
                form.withBudget &&
                html`<label class="field">Token budget
                <input required value=${budget} placeholder="100k" onInput=${(event) => setBudget(event.currentTarget.value)} />
            </label>`
            }
            <p class="muted small">Uses your selected model and account. The objective is sent as literal text; use the separate budget field for a token limit.</p>
            <button class="button primary" type="submit" disabled=${busy || !objective.trim()}>${busy ? "Working…" : form.kind === "edit" ? "Update goal" : "Start goal"}</button>
        </form>`
        }
        ${error && html`<p role="alert" class="tone-error">${error}</p>`}
        ${
            form &&
            html`<button class="link" disabled=${busy} onClick=${() => {
                setError("");
                setForm(null);
            }}>Back</button>`
        }
    <//>`;
}
