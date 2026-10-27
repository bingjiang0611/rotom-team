/** Per-send correlation without retaining request identities or creating an in-flight cache. */
import { createHmac, randomBytes } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import type { WebTimingSignal } from "./perf-channels.ts";

// Never persisted. Tags cannot be matched across server restarts or derived from known request identities.
const secret = randomBytes(32);

export const sendPhaseChannel = channel("rotom-team:send-phase");
export type SendPhase = "entered" | "admitted" | "reserved" | "dispatch" | "mirrored" | "returned";
export type SendPhaseSignal = {
    trace: string;
    phase: SendPhase;
    /** Process-monotonic timestamp, not a browser duration. Subtract server phases only. */
    atMs: number;
};

/** `requestKey` is the existing member-prefixed native request identity, used only as HMAC input. */
export function sendTraceTag(sessionId: string, requestKey: string): string {
    return createHmac("sha256", secret)
        .update(JSON.stringify([sessionId, requestKey]))
        .digest("hex")
        .slice(0, 32);
}

export function sendPhase(sessionId: string, requestKey: string, phase: SendPhase): void {
    if (sendPhaseChannel.hasSubscribers) {
        sendPhaseChannel.publish({
            trace: sendTraceTag(sessionId, requestKey),
            phase,
            atMs: performance.now(),
        } satisfies SendPhaseSignal);
    }
}

/** Private HTTP envelope only. None of these raw fields may reach a diagnostics channel or the journal. */
export function parseSendContext(
    value: unknown,
    memberId: string,
    timings: WebTimingSignal[],
): { conversationId: number; requestKey: string } | null {
    const item = value as Record<string, unknown> | null;

    if (
        Object.keys(item ?? {})
            .sort()
            .join(",") !== "conversationId,requestId" ||
        !Number.isSafeInteger(item?.conversationId) ||
        (item!.conversationId as number) < 0 ||
        typeof item?.requestId !== "string" ||
        item.requestId.length === 0 ||
        item.requestId.startsWith("#") ||
        `${memberId}:${item.requestId}`.length > 128 ||
        timings.some((timing) => !timing.name.startsWith("send."))
    ) {
        return null;
    }

    return {
        conversationId: item!.conversationId as number,
        requestKey: `${memberId}:${item.requestId}`,
    };
}
