/** Decode Team's existing notify envelopes once per RPC event; ordinary notifications stay ordinary. */
import type { RpcRecord } from "./rotom-rpc.ts";
import { parseWithWork } from "./perf-channels.ts";

export type NativeControl =
    | { kind: "team-kernel-children-v1"; pending: number }
    | { kind: "team-kernel-policy-v1"; nonce: string; ready: boolean }
    | { kind: "team-kernel-barrier-v1"; nonce: string; ok: true }
    | { kind: "team-kernel-context-v1"; nonce: string; result: Record<string, unknown> }
    | {
          kind: "team-kernel-tree-v1";
          nonce: string;
          result: { cancelled: boolean; editorText?: string; summaryEntry?: RpcRecord };
      };

// RPC dispatch hands the same unchanged event to its readers. Weak keys retain no past event history.
const decoded = new WeakMap<RpcRecord, NativeControl | undefined>();
const reservedPrefix = /^\s*\{\s*"kind"\s*:\s*"team-kernel-/;

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reserved malformed/unknown controls throw; callers must not treat them as successful native outcomes. */
export function decodeNativeControl(event: RpcRecord): NativeControl | undefined {
    if (
        event.type !== "extension_ui_request" ||
        event.method !== "notify" ||
        typeof event.message !== "string" ||
        !event.message.trimStart().startsWith("{")
    ) {
        return undefined;
    }

    if (decoded.has(event)) {
        return decoded.get(event);
    }

    let value: unknown;

    try {
        value = parseWithWork("native-rpc-notify", event.message);
    } catch {
        if (reservedPrefix.test(event.message)) {
            throw new Error("Malformed native control notification");
        }

        decoded.set(event, undefined);

        return undefined;
    }

    if (
        !object(value) ||
        typeof value.kind !== "string" ||
        !value.kind.startsWith("team-kernel-")
    ) {
        decoded.set(event, undefined);

        return undefined;
    }

    let valid = false;
    const nonce = typeof value.nonce === "string" && value.nonce.length > 0;

    switch (value.kind) {
        case "team-kernel-children-v1":
            valid = Number.isSafeInteger(value.pending) && (value.pending as number) >= 0;
            break;
        case "team-kernel-policy-v1":
            valid = nonce && typeof value.ready === "boolean";
            break;
        case "team-kernel-barrier-v1":
            valid = nonce && value.ok === true;
            break;
        case "team-kernel-context-v1":
            valid = nonce && object(value.result);
            break;

        case "team-kernel-tree-v1": {
            const result = value.result;

            valid =
                nonce &&
                object(result) &&
                typeof result.cancelled === "boolean" &&
                (result.editorText === undefined || typeof result.editorText === "string") &&
                (result.summaryEntry === undefined ||
                    (object(result.summaryEntry) && result.summaryEntry.type === "branch_summary"));
            break;
        }
    }

    if (!valid) {
        // Do not include private context/credentials from the native payload in an error or notice.
        throw new Error("Invalid or unknown native control notification");
    }

    const control = value as NativeControl;

    decoded.set(event, control);

    return control;
}
