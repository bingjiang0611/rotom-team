// Native command selections. Options and actions come from the authorized Team adapter.
import {
    actions,
    attempt,
    closeSheet,
    drafts,
    insertIntoComposer,
    navigate,
    notify,
    openSheet,
    store,
} from "../store.js";
import { html, Sheet } from "../ui.js";
import { useEffect, useState } from "preact/hooks";

export function nativeCommandAccepted(result) {
    return (
        !["unknown", "rejected", "interrupted"].includes(result.status) &&
        !result.nativeResult?.navigation?.cancelled
    );
}

export function showNativeResult(result) {
    if (["unknown", "rejected", "interrupted"].includes(result.status)) {
        notify(
            "warning",
            `Native command outcome: ${result.status}. Do not replay an unknown operation.`,
        );

        return;
    }

    const navigation = result.nativeResult?.navigation;

    if (navigation?.cancelled) {
        notify("warning", "Native tree navigation was cancelled.");

        return;
    }

    const editorText = result.editorText ?? navigation?.editorText;

    if (typeof editorText === "string") {
        drafts.set(result.conversationId ?? store.state.conversationId, editorText);
    }

    if (result.conversationId !== undefined) {
        navigate(result.conversationId);
    }

    if (typeof editorText === "string") {
        insertIntoComposer(editorText, [], { replace: true });
    }

    if (result.interaction) {
        openSheet(result.interaction);
    }

    if (result.nativeResult) {
        if (typeof result.nativeResult.clipboard === "string") {
            attempt(() => navigator.clipboard.writeText(result.nativeResult.clipboard));
        } else if (!navigation) {
            openSheet({ type: "native-info", result: result.nativeResult });
        }
    }

    if (result.download) {
        const link = document.createElement("a");

        link.href = result.download;
        link.download = "";
        link.click();
    }
}

export function NativeInfoSheet() {
    return html`<${Sheet} title="Native command result" onClose=${closeSheet}>
        <pre>${JSON.stringify(store.state.sheet.result, null, 2)}</pre>
    <//>`;
}

export function NativeSettingsSheet({ scope = false }) {
    const [settings, setSettings] = useState(null);

    useEffect(() => {
        attempt(async () => setSettings(await actions.nativeSettings()));
    }, []);
    const save = (patch) => attempt(async () => setSettings(await actions.nativeSettings(patch)));

    const toggle = (name) => {
        const selected = settings.models
            .filter((model) => model.selected)
            .map((model) => model.nativeName);

        return save({
            enabledModels: selected.includes(name)
                ? selected.filter((item) => item !== name)
                : [...selected, name],
        });
    };

    const cycle = () =>
        attempt(async () => {
            const models = settings.models.filter(
                (model) => settings.enabledModels.length === 0 || model.selected,
            );
            const current = store.state.view.agent?.model;
            const index = models.findIndex(
                (model) => model.provider === current?.provider && model.id === current?.modelId,
            );
            const next = models[(index + 1) % models.length];

            if (next) {
                await actions.configure({
                    model: { provider: next.provider, modelId: next.id },
                    ...(next.thinkingLevel ? { thinkingLevel: next.thinkingLevel } : {}),
                });
            }
        });

    return html`<${Sheet} title=${scope ? "Native model cycle scope" : "Native execution settings"} onClose=${closeSheet}>
        ${
            !settings
                ? html`<p>Loading…</p>`
                : scope
                  ? html`
            <p class="muted">Select models for cycling. An empty selection means all your available models.</p>
            ${settings.models.map(
                (model) => html`<label class="field">
                <input type="checkbox" checked=${model.selected} onChange=${() => toggle(model.nativeName)} />
                ${model.name}
            </label>`,
            )}
            ${settings.scopeWarnings.map((warning) => html`<p class="muted">${warning}</p>`)}
            <button class="button" onClick=${cycle}>Cycle model</button>
        `
                  : html`
            <p class="muted">Saved with native SettingsManager for your next run. Project settings take precedence. Team keeps automatic retries and automatic compaction off.</p>
            ${["steeringMode", "followUpMode"].map(
                (key) => html`<label class="field">
                ${key}
                <select value=${settings[key]} onChange=${(event) => save({ [key]: event.currentTarget.value })}>
                    <option value="one-at-a-time">One at a time</option>
                    <option value="all">All</option>
                </select>
            </label>`,
            )}
            ${["imageAutoResize", "blockImages", "enableSkillCommands"].map(
                (key) => html`<label class="field">
                <input type="checkbox" checked=${settings[key]} onChange=${(event) => save({ [key]: event.currentTarget.checked })} />
                ${key}
            </label>`,
            )}
        `
        }
    <//>`;
}

export function NativeCommandSheet() {
    const sheet = store.state.sheet;
    const [summarize, setSummarize] = useState(false);
    const choose = (text) =>
        attempt(async () => {
            const result = await actions.submit(
                `${text}${sheet.command === "tree" && summarize ? " --summarize" : ""}`,
                [],
                "steer",
                false,
                true,
            );

            closeSheet();
            showNativeResult(result);
        });

    return html`<${Sheet} title=${sheet.title} onClose=${closeSheet}>
        ${
            sheet.command === "tree" &&
            html`<p class="muted">The transcript retains immutable audit history. Labels below identify the active native branch.</p>
            <label class="field"><input type="checkbox" checked=${summarize} onChange=${(event) => setSummarize(event.currentTarget.checked)} /> Summarize the abandoned branch using my selected model and account</label>`
        }
        ${sheet.options.length === 0 && html`<p class="muted">No native entries yet.</p>`}
        ${sheet.options.map(
            (option) => html`<button
            class="button wide"
            data-entry-id=${option.entryId}
            onClick=${() => choose(option.text)}
        >${option.label}</button>`,
        )}
    <//>`;
}
