/**
 * A session tab that parses its view events (with the benchmark's unwrapped parser) and rebuilds the transcript as
 * the web app does. With `have`, it says which entries it already holds; a server that ignores that sends them again.
 */
import assert from "node:assert/strict";

type Entry = { id: number; [key: string]: unknown };
type Json = { parse(text: string): any };
export type Transcript = { order: number[]; entries: Map<number, Entry> };

export function viewTab(
    base: string,
    token: string,
    json: Json,
    id: number,
    held?: { have: string; entries: ReadonlyMap<number, Entry> },
    /** More of the web app's connection options, such as `tail=240`. */
    extra = "",
) {
    const controller = new AbortController();
    let resolveFull: (value: Transcript & { kept: number }) => void;
    let rejectFull: (error: unknown) => void;
    const full = new Promise<Transcript & { kept: number }>((resolve, reject) => {
        resolveFull = resolve;
        rejectFull = reject;
    });
    const query = `c=${id}&tab=perf-view-${id}-${Date.now()}${held ? `&have=${encodeURIComponent(held.have)}` : ""}${extra}`;
    const reading = (async () => {
        const response = await fetch(`${base}/api/events?${query}`, {
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

                if (!frame.startsWith("event: view\n")) {
                    continue;
                }

                const data = json.parse(/^data: (.*)$/m.exec(frame)![1]!);

                if (!data.full) {
                    continue;
                }

                const order = data.order as number[];
                const entries = new Map<number, Entry>();
                let kept = 0;

                // A claim the server accepted names the slice of its order this tab may keep: as the web app does.
                if (data.kept && held) {
                    const from = order.indexOf(data.kept.first);

                    for (const each of order.slice(from, from + data.kept.count)) {
                        const entry = held.entries.get(each);

                        if (entry !== undefined) {
                            entries.set(each, entry);
                            kept++;
                        }
                    }
                }

                for (const entry of data.entries as Entry[]) {
                    entries.set(entry.id, entry);
                }

                resolveFull!({ order, entries, kept });
            }
        }
    })().catch((error: Error) => {
        if (error.name !== "AbortError") {
            rejectFull!(error);
        }
    });

    return {
        full,
        async close() {
            controller.abort();
            await reading;
        },
    };
}
