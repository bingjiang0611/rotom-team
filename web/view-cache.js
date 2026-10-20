// Saved copies of the sessions this browser opened lately, so coming back to one shows its transcript at once, marked as
// being checked, while the server confirms it (and sends only what the copy lacks: `view-claim.js`). Only the newest
// rows, only the last `KEEP` sessions, and only for the person who saved them: sign-out, another person, or a change
// in this person's access clears them all. Where IndexedDB is unavailable or fails, nothing is saved and nothing breaks.

const DB = "rotom-views";
const STORE = "views";

/** Sessions kept. */
export const KEEP = 10;
/** The newest entries of a session kept; earlier ones come from the server as today. */
export const SAVED_ENTRIES = 400;
/** A copy larger than this (JSON characters) is not kept: reading it back would cost more than it saves. */
export const SAVED_CHARS = 4_000_000;

let opening = null;

const available = () => typeof indexedDB !== "undefined";

function database() {
    if (!available()) {
        return Promise.resolve(null);
    }

    opening ??= new Promise((resolve) => {
        try {
            const request = indexedDB.open(DB, 1);

            request.onupgradeneeded = () => {
                const views = request.result.createObjectStore(STORE, { keyPath: "id" });

                views.createIndex("savedAt", "savedAt");
            };

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => resolve(null);
            request.onblocked = () => resolve(null);
        } catch {
            resolve(null);
        }
    });

    return opening;
}

/** Run `work(store)` in one transaction; resolves with its result, or null on any failure. */
async function transact(mode, work) {
    const db = await database();

    if (db === null) {
        return null;
    }

    return new Promise((resolve) => {
        try {
            const tx = db.transaction(STORE, mode);
            let result = null;

            tx.oncomplete = () => resolve(result);
            tx.onerror = () => resolve(null);
            tx.onabort = () => resolve(null);
            work(tx.objectStore(STORE), (value) => (result = value));
        } catch {
            resolve(null);
        }
    });
}

/** What a saved copy must match to be shown: the person and what they may see. */
export function accessOf(me) {
    return JSON.stringify([me.id, me.role, me.sessions ?? null]);
}

/** Session `id`'s saved copy, whoever saved it: start reading before knowing who signed in, then `loadView`. */
export function readView(id) {
    return transact("readonly", (store, done) => {
        const request = store.get(id);

        request.onsuccess = () => done(request.result ?? null);
    });
}

/** The saved copy of session `id` for this person, or null. A copy someone else saved clears every copy. */
export async function loadView(id, me, reading = readView(id)) {
    const record = await reading;

    if (record !== null && record.access !== accessOf(me)) {
        await clearViews();

        return null;
    }

    return record;
}

/**
 * Save session `view` for `me`: its newest entries, as one record. Keeps the `KEEP` newest records. Returns whether
 * it was saved.
 */
export async function saveView(view, me) {
    // The newest run of entries the tab holds: a long session's view sends only its newest (`TRANSCRIPT_TAIL`).
    let from = view.order.length;

    while (
        from > 0 &&
        view.order.length - from < SAVED_ENTRIES &&
        view.entries.has(view.order[from - 1])
    ) {
        from--;
    }

    const order = view.order.slice(from);
    const entries = order.map((id) => view.entries.get(id));

    if (order.length === 0) {
        return false;
    }

    const record = {
        id: view.conversation.id,
        access: accessOf(me),
        build: view.build,
        savedAt: Date.now(),
        conversation: view.conversation,
        order,
        entries,
        authors: view.authors ?? {},
    };

    if (JSON.stringify(record).length > SAVED_CHARS) {
        await dropView(record.id);

        return false;
    }

    const saved = await transact("readwrite", (store, done) => {
        store.put(record);
        // Newest first: everything past the first KEEP goes.
        let seen = 0;
        const cursor = store.index("savedAt").openKeyCursor(null, "prev");

        cursor.onsuccess = () => {
            const at = cursor.result;

            if (at === null) {
                return;
            }

            if (++seen > KEEP) {
                store.delete(at.primaryKey);
            }

            at.continue();
        };

        done(true);
    });

    return saved === true;
}

export function dropView(id) {
    return transact("readwrite", (store) => store.delete(id));
}

/** Keep only the copies of sessions this person still has (`ids`), as the server's full session list says. */
export function keepViews(ids) {
    return transact("readwrite", (store) => {
        const cursor = store.openKeyCursor();

        cursor.onsuccess = () => {
            const at = cursor.result;

            if (at === null) {
                return;
            }

            if (!ids.has(at.primaryKey)) {
                store.delete(at.primaryKey);
            }

            at.continue();
        };
    });
}

export function clearViews() {
    if (!available()) {
        return Promise.resolve(null);
    }

    return transact("readwrite", (store) => store.clear());
}
