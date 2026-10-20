/** A tab's session-list stream, for the rename scenario; accepts the old full lists and the proposed versioned deltas. */
import assert from "node:assert/strict";

type Row = { id: number; title?: string; updatedAt: number; [key: string]: unknown };
type Json = { parse(text: string): any };

/** Open without a conversation: only the session list is relevant; no views or file watches. */
export function sessionListTab(base: string, token: string, json: Json) {
    const controller = new AbortController();
    let rows: Row[] | undefined;
    let version: string | undefined;
    const waiting = new Set<() => void>();
    let failed: unknown;
    const reading = (async () => {
        const response = await fetch(`${base}/api/events?sessions=delta`, {
            headers: { authorization: `Bearer ${token}` },
            signal: controller.signal,
        });

        assert.equal(response.status, 200);
        const decoder = new TextDecoder();
        let buffer = "";

        for await (const chunk of response.body!) {
            buffer += decoder.decode(chunk as Uint8Array, { stream: true });
            let end: number;

            while ((end = buffer.indexOf("\n\n")) >= 0) {
                const frame = buffer.slice(0, end);

                buffer = buffer.slice(end + 2);
                const event = /^event: (.+)$/m.exec(frame)?.[1];

                if (event !== "sessions" && event !== "sessions-delta") {
                    continue;
                }

                const data = json.parse(/^data: (.*)$/m.exec(frame)![1]!);

                if (event === "sessions") {
                    rows = Array.isArray(data) ? data : data.items;
                    version = data.version;
                } else {
                    assert.equal(data.from, version, "no missed delta");
                    const byId = new Map(rows!.map((row) => [row.id, row]));

                    data.removed.forEach((id: number) => byId.delete(id));
                    data.upsert.forEach((row: Row) => byId.set(row.id, row));
                    rows = [...byId.values()].sort(
                        (a, b) => b.updatedAt - a.updatedAt || a.id - b.id,
                    );
                    version = data.version;
                }

                for (const notify of waiting) {
                    notify();
                }
            }
        }
    })().catch((error: Error) => {
        if (error.name !== "AbortError") {
            failed = error;

            for (const notify of waiting) {
                notify();
            }
        }
    });

    /** Wait for a list satisfying `check`, bounded; actual event arrival wakes this, not a polling timer. */
    const until = (check: (rows: readonly Row[]) => boolean) =>
        new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                waiting.delete(notify);
                reject(new Error("Session-list event did not arrive"));
            }, 20_000);

            const notify = () => {
                if (failed || (rows !== undefined && check(rows))) {
                    clearTimeout(timer);
                    waiting.delete(notify);

                    if (failed) {
                        reject(failed);
                    } else {
                        resolve();
                    }
                }
            };

            waiting.add(notify);
            notify();
        });

    return {
        until,
        get rows() {
            return rows;
        },
        async close() {
            controller.abort();
            await reading;
        },
    };
}
