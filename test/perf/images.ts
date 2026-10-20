/** Benchmark-only image phase probes. No journal changes, production hooks, model requests, or fixture shortcuts. */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import { crc32, deflateSync } from "node:zlib";
import type { Transcripts } from "../../src/server/transcripts.ts";

/** A valid, deterministic RGB PNG; level-zero deflate keeps its byte size independent of compressibility. */
export function imageFixture(width: number, height: number, seed: number): Buffer {
    const pixels = Buffer.alloc(height * (1 + width * 3));
    let value = seed + 1;

    for (let row = 0; row < height; row++) {
        for (let column = 1; column <= width * 3; column++) {
            value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
            pixels[row * (1 + width * 3) + column] = value >>> 24;
        }
    }

    const chunk = (kind: string, data: Buffer) => {
        const body = Buffer.concat([Buffer.from(kind), data]);
        const frame = Buffer.alloc(4);
        const checksum = Buffer.alloc(4);

        frame.writeUInt32BE(data.length);
        checksum.writeUInt32BE(crc32(body));

        return Buffer.concat([frame, body, checksum]);
    };

    const header = Buffer.alloc(13);

    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 2;

    return Buffer.concat([
        Buffer.from("89504e470d0a1a0a", "hex"),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(pixels, { level: 0 })),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

type Sample = {
    started: number;
    lookupMs: number;
    decodeMs: number;
    lookupCalls: number;
    decodeCalls: number;
    decodeChars: number;
    decodeBytes: number;
    endAt?: number;
    finishedAt?: number;
    status?: number;
    aborted?: boolean;
};
type Scope = { sample: Sample; image?: boolean; lookup?: boolean };

/** Install once, restore in finally. AsyncLocalStorage keeps overlapping image requests separate. */
export function probeImages(
    transcripts: Pick<Transcripts, "visibleEntry" | "entryImage"> &
        Partial<Pick<Transcripts, "storedImage">>,
) {
    const scope = new AsyncLocalStorage<Scope>();
    const samples: Sample[] = [];
    const visibleEntry = transcripts.visibleEntry;
    const entryImage = transcripts.entryImage;
    const storedImage = transcripts.storedImage;
    const from = Buffer.from;

    transcripts.visibleEntry = async function (...args) {
        const active = scope.getStore();

        if (!active) {
            return visibleEntry.apply(this, args);
        }

        const started = performance.now();

        active.sample.lookupCalls++;

        try {
            return await scope.run({ ...active, lookup: true }, () =>
                visibleEntry.apply(this, args),
            );
        } finally {
            // Includes harness mutation-queue waiting, SQL, parsing, and fork traversal, not just storage CPU.
            active.sample.lookupMs += performance.now() - started;
        }
    };

    // Older baselines decode inside entryImage; newer code shares storedImage with the media cache. Scope both
    // entry points without counting either call: only actual Buffer.from(base64) work inside the scope is counted,
    // so entryImage delegating to storedImage is not counted twice.
    transcripts.entryImage = function (...args) {
        const active = scope.getStore();

        return active
            ? scope.run({ ...active, image: true }, () => entryImage.apply(this, args))
            : entryImage.apply(this, args);
    };

    if (storedImage !== undefined) {
        transcripts.storedImage = function (...args) {
            const active = scope.getStore();

            return active
                ? scope.run({ ...active, image: true }, () => storedImage.apply(this, args))
                : storedImage.apply(this, args);
        };
    }

    Buffer.from = function (...args: unknown[]) {
        const active = scope.getStore();
        const measured =
            active?.image && !active.lookup && typeof args[0] === "string" && args[1] === "base64";
        const started = measured ? performance.now() : 0;
        const result = Reflect.apply(from, Buffer, args) as Buffer;

        if (measured) {
            active.sample.decodeMs += performance.now() - started;
            active.sample.decodeCalls++;
            active.sample.decodeChars += (args[0] as string).length;
            active.sample.decodeBytes += result.length;
        }

        return result;
    } as typeof Buffer.from;

    return {
        run<T>(request: IncomingMessage, response: ServerResponse, action: () => T): T {
            if (!/^\/api\/c\/\d+\/image\//.test(request.url ?? "")) {
                return action();
            }

            const sample: Sample = {
                started: performance.now(),
                lookupMs: 0,
                decodeMs: 0,
                lookupCalls: 0,
                decodeCalls: 0,
                decodeChars: 0,
                decodeBytes: 0,
            };
            const end = response.end;

            samples.push(sample);
            response.end = function (this: ServerResponse, ...args: unknown[]) {
                sample.endAt ??= performance.now();

                return Reflect.apply(end, this, args);
            } as typeof response.end;
            response.once("finish", () => {
                sample.finishedAt = performance.now();
                sample.status = response.statusCode;
            });
            response.once("close", () => {
                if (sample.finishedAt === undefined) {
                    sample.aborted = true;
                }
            });

            return scope.run({ sample }, action);
        },
        reset() {
            assert.ok(samples.every((sample) => sample.finishedAt !== undefined || sample.aborted));
            samples.length = 0;
        },
        report(expected: number) {
            assert.equal(samples.length, expected, "every image request must be observed");

            for (const sample of samples) {
                assert.ok(
                    !sample.aborted &&
                        sample.finishedAt !== undefined &&
                        sample.endAt !== undefined,
                    "unfinished/aborted image phases are unavailable, not zero",
                );
                assert.equal(
                    sample.status,
                    200,
                    "do not time an error response as successful retrieval",
                );
            }

            const sum = (value: (sample: Sample) => number) =>
                samples.reduce((total, sample) => total + value(sample), 0);

            return {
                counts: {
                    "image.lookup.calls": sum((s) => s.lookupCalls),
                    "image.decode.calls": sum((s) => s.decodeCalls),
                    "image.decode.chars": sum((s) => s.decodeChars),
                    "image.decode.bytes": sum((s) => s.decodeBytes),
                },
                // Sums of per-request durations, not batch wall time; concurrent lookup queue waits overlap.
                timings: {
                    imageLookupMs: sum((s) => s.lookupMs),
                    imageDecodeMs: sum((s) => s.decodeMs),
                    imageSendFinishMs: sum((s) => s.finishedAt! - s.endAt!),
                    imageServerMs: sum((s) => s.finishedAt! - s.started),
                },
            };
        },
        restore() {
            transcripts.visibleEntry = visibleEntry;
            transcripts.entryImage = entryImage;

            if (storedImage !== undefined) {
                transcripts.storedImage = storedImage;
            }

            Buffer.from = from;
            scope.disable();
        },
    };
}
