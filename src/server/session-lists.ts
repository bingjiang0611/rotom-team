/**
 * Session-list pushes: the first is full, later ones carry only rows that changed, with a version local to the
 * connection. The legacy full-array protocol remains available to tabs that did not opt in.
 */
import type { PocketApp } from "./app.ts";
import type { Client } from "./room.ts";

type Row = Awaited<ReturnType<PocketApp["sessions"]>>[number];
type Prepared = { items: Row[]; encoded: Map<number, string> | undefined };
type Sent = { sequence: number; version: string; encoded: Map<number, string> | undefined };

/** Oversized lists still work, but use full snapshots rather than keeping unbounded per-connection baselines. */
const MAX_ROWS = 2048;
const MAX_CHARS = 2 * 1024 * 1024;

export class SessionLists {
    readonly #sent = new WeakMap<Client, Sent>();

    /** Prepare once per user per refresh, after filtering for that user's current permissions. */
    prepare(items: Row[]): Prepared {
        if (items.length > MAX_ROWS) {
            return { items, encoded: undefined };
        }

        const encoded = new Map<number, string>();
        let chars = 0;

        for (const item of items) {
            const json = JSON.stringify(item);

            chars += json.length;

            if (chars > MAX_CHARS) {
                return { items, encoded: undefined };
            }

            encoded.set(item.id, json);
        }

        return { items, encoded };
    }

    send(client: Client, prepared: Prepared, full = false): void {
        if (!client.sessionDeltas) {
            client.send("sessions", prepared.items);

            return;
        }

        const before = this.#sent.get(client);
        const sequence = (before?.sequence ?? 0) + 1;
        const version = `${client.connection}:${sequence}`;
        const { items, encoded } = prepared;

        if (full || before?.encoded === undefined || encoded === undefined) {
            client.send("sessions", { version, items });
        } else {
            const upsert = items.filter(
                (item) => before.encoded!.get(item.id) !== encoded.get(item.id),
            );
            const removed = [...before.encoded.keys()].filter((id) => !encoded.has(id));

            if (upsert.length === 0 && removed.length === 0) {
                return;
            }

            client.send("sessions-delta", { from: before.version, version, upsert, removed });
        }

        this.#sent.set(client, { sequence, version, encoded });
    }

    forget(client: Client): void {
        this.#sent.delete(client);
    }
}
