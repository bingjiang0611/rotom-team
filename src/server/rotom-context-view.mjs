/** Pure native context projection; the policy extension retains capture and lifecycle ownership. */
import {
    buildFallbackInjectionsSnapshot,
    buildInjectionsSnapshot,
} from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/extensions/third-party/node_modules/pi-context-view/src/injections.ts";
import { collectPromptSources } from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/extensions/third-party/node_modules/pi-context-view/src/prompt-additions.ts";
import { applyRequestSnapshot } from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/extensions/third-party/node_modules/pi-context-view/src/projection.ts";
import { buildUsageSnapshot } from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/extensions/third-party/node_modules/pi-context-view/src/replay.ts";
import { readAutoCompactReserveTokens } from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/extensions/third-party/node_modules/pi-context-view/src/settings.ts";

import {
    computeUsage,
    toReportedUsage,
} from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/extensions/third-party/node_modules/pi-context-view/src/usage.ts";

function contextCategory(category) {
    return {
        id: category.id,
        label: category.label,
        tokens: category.tokens,
        ...(category.children?.length ? { children: category.children.map(contextCategory) } : {}),
    };
}

function contextItem(item) {
    return {
        label: item.label,
        tokens: item.tokens,
        ...(item.change ? { change: item.change } : {}),
        ...(item.dropped ? { dropped: true } : {}),
        ...(item.moved ? { moved: true } : {}),
        ...(item.requestOnly ? { requestOnly: true } : {}),
        ...(item.children?.length ? { children: item.children.map(contextItem) } : {}),
    };
}

function contextInputs(pi, ctx) {
    return {
        entries: ctx.sessionManager.getEntries(),
        options: ctx.getSystemPromptOptions(),
        allTools: pi.getAllTools(),
        activeToolNames: pi.getActiveTools(),
        promptSources: collectPromptSources(pi.getAllTools(), pi.getCommands()),
        systemPrompt: ctx.getSystemPrompt(),
    };
}

export function contextResult(pi, ctx, view, snapshot, filterMessages) {
    const common = contextInputs(pi, ctx);

    if (view === "injections") {
        const injections = snapshot
            ? buildInjectionsSnapshot({
                  ...common,
                  snapshot,
                  filterMessages: filterMessages,
              })
            : buildFallbackInjectionsSnapshot(common);

        return {
            type: "native-context",
            title: "Context injections",
            view,
            captured: Boolean(snapshot),
            totalTokens: injections.totalTokens,
            hiddenTools: injections.hiddenTools ?? [],
            groups: injections.groups.map((group) => ({
                source: group.source.label,
                native: group.source.native,
                totalTokens: group.totalTokens,
                items: group.items.map(contextItem),
            })),
        };
    }

    const applied = applyRequestSnapshot({
        snapshot,
        entries: common.entries,
        leafId: ctx.sessionManager.getLeafId(),
        filterMessages: filterMessages,
    });
    const current = buildUsageSnapshot({
        ...common,
        messages: applied.messages,
        systemChanges: applied.systemChanges,
        forcedPrompt: applied.forcedPrompt,
    });
    const usage = computeUsage({
        snapshot: current,
        messages: applied.messages,
        reported: toReportedUsage(ctx.getContextUsage()),
        modelLabel: ctx.model?.id,
        autoCompactReserveTokens: readAutoCompactReserveTokens(pi, ctx.model),
    });

    return {
        type: "native-context",
        title: "Context usage",
        view: "usage",
        captured: Boolean(snapshot),
        model: usage.modelLabel,
        reported: usage.reported,
        estimatedTokens: usage.estimatedTokens,
        autoCompactReserveTokens: usage.autoCompactReserveTokens,
        categories: usage.categories.map(contextCategory),
    };
}
