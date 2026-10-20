/**
 * What a reconnecting tab says it already holds of a transcript: a run of the server's entry order, named by the
 * server run that sent it, its first id, its length and a digest of its ids. The server then sends only the rest.
 * A claim can only make the server send less to that tab, never more or anything another person may not see; a
 * mismatched or malformed claim is ignored and the tab gets everything, as before.
 */

/** Must match `web/view-claim.js` (and the benchmark's copy): two FNV-1a 32-bit passes over the ids joined by commas. */
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

export type ViewClaim = { build: string; first: number; count: number; digest: string };

/** `build.first.count.digest`, or undefined. Bounded: a claim is never longer than 64 characters. */
export function parseClaim(raw: string | null): ViewClaim | undefined {
    const match =
        raw === null ? null : /^(\d{1,16})\.(\d{1,15})\.(\d{1,7})\.([0-9a-f]{16})$/.exec(raw);

    if (match === null) {
        return undefined;
    }

    const count = Number(match[3]);

    return count === 0
        ? undefined
        : { build: match[1]!, first: Number(match[2]), count, digest: match[4]! };
}

/**
 * The run of `order` the claim names, when it matches exactly, from this server run. Entry ids are immutable and the
 * projection of an entry depends only on the entry and the server's code, so a matching run is what the tab has.
 */
export function claimedRun(
    claim: ViewClaim,
    build: number,
    order: readonly number[],
): readonly number[] | undefined {
    if (claim.build !== String(build)) {
        return undefined;
    }

    const from = order.indexOf(claim.first);

    if (from < 0 || from + claim.count > order.length) {
        return undefined;
    }

    const run = order.slice(from, from + claim.count);

    return claimDigest(run) === claim.digest ? run : undefined;
}
