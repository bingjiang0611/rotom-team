/**
 * Concurrent identical requests joined into one run without serving anything older than the request: a caller joins a
 * run only if it has not started yet, so every answer reflects the state at or after the call.
 */
type Slot<T> = { running?: Promise<T>; next?: Promise<T> };

const ignore = () => undefined;

export class FreshRuns<T> {
    readonly #slots = new Map<string, Slot<T>>();

    /** Number of keys with a run going or waiting; idle keys are forgotten. */
    get size(): number {
        return this.#slots.size;
    }

    /**
     * `work`'s result for `key`: a new run when none is going, else the one queued behind it, which every caller who
     * arrives meanwhile shares. Callers of one key must ask for the same thing.
     */
    run(key: string, work: () => Promise<T>): Promise<T> {
        let slot = this.#slots.get(key);

        if (slot === undefined) {
            slot = {};
            this.#slots.set(key, slot);
        }

        if (slot.running === undefined) {
            return this.#start(key, slot, work);
        }

        if (slot.next === undefined) {
            const queued = slot;

            slot.next = slot.running.then(ignore, ignore).then(() => {
                queued.next = undefined;

                return this.#start(key, queued, work);
            });
        }

        return slot.next;
    }

    #start(key: string, slot: Slot<T>, work: () => Promise<T>): Promise<T> {
        const running = Promise.resolve()
            .then(work)
            .finally(() => {
                if (slot.running === running) {
                    slot.running = undefined;
                }

                if (slot.running === undefined && slot.next === undefined) {
                    this.#slots.delete(key);
                }
            });

        slot.running = running;

        return running;
    }
}
