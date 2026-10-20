/**
 * Benchmark copy of the transcript-claim digest (`src/server/view-claim.ts`, `web/view-claim.js`). The benchmark is
 * copied into older checkouts, which have neither module, so it carries its own; a test keeps the three equal.
 */
export function claimDigest(ids: readonly number[]): string {
    let a = 0x811c9dc5;
    let b = 0x050c5d1f;
    const text = ids.join(",");

    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);

        a = Math.imul(a ^ code, 0x01000193) >>> 0;
        b = Math.imul(b ^ code, 0x01000193) >>> 0;
    }

    return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** `build.first.count.digest`: the ids order[i..i+count) a tab already holds, from server run `build`. */
export function claimFor(build: string | number, ids: readonly number[]): string {
    return `${build}.${ids[0]}.${ids.length}.${claimDigest(ids)}`;
}
