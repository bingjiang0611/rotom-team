import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { NATIVE_ENTRY } from "../../src/server/entry-format.ts";
import { sniffImage } from "../../src/server/http/assets.ts";
import { since, snapshot } from "./counters.ts";
import { imageFixture, probeImages } from "./images.ts";
import { measureImageNetwork } from "./image-network.ts";
import { measurePasteNetwork } from "./paste-network.ts";
import { WORKLOAD } from "./workload.ts";
import type { ScenarioContext } from "./scenario-context.ts";

/** Seed and measure the persisted-image retrieval, thumbnail, paste, and image-bearing changes workloads. */
export async function runImageScenarios(context: ScenarioContext): Promise<void> {
    const { app, base, call, inferenceRequests, quiet, raw, root, scenario, setHandler, token } =
        context;
    const imageSession = (await call("sessions", "POST", { title: "Images", backend: "rotom" }))
        .value.id as unknown as ConversationId;
    const images = Array.from({ length: WORKLOAD.imageEntries }, (_, index) =>
        imageFixture(WORKLOAD.imageWidth, WORKLOAD.imageHeight, index),
    );
    const imageEntries = await app.harness.commit(async (tx) => {
        const ids: number[] = [];

        for (const [index, bytes] of images.entries()) {
            const record = await tx.appendEntry(imageSession, {
                kind: NATIVE_ENTRY,
                data: {
                    entry: {
                        type: "message",
                        id: `image-${index}`,
                        parentId: index === 0 ? null : `image-${index - 1}`,
                        message: {
                            role: "user",
                            timestamp: index,
                            content: [
                                {
                                    type: "text",
                                    text: `Image ${index}.`.padEnd(WORKLOAD.answerChars, "."),
                                },
                                {
                                    type: "image",
                                    mimeType: "image/png",
                                    data: bytes.toString("base64"),
                                },
                            ],
                        },
                    },
                } as JsonValue,
            });

            ids.push(record.id as unknown as number);
        }

        return ids;
    }, BACKGROUND_CONTEXT);
    const imageProbe = probeImages(app.transcripts);
    const unprobedHandler = context.getHandler();

    setHandler((request, response) =>
        imageProbe.run(request, response, () => unprobedHandler(request, response)),
    );

    try {
        for (const [name, indices] of [
            ["image.single", [0]],
            [
                "image.concurrent",
                Array.from({ length: WORKLOAD.imageParallel }, (_, index) => index + 1),
            ],
        ] as const) {
            imageProbe.reset();
            let clientMs = 0;

            await scenario(
                name,
                async () => {
                    const beforeInference = inferenceRequests();
                    const beforeWork = snapshot();
                    const sizes = await Promise.all(
                        indices.map(async (index) => {
                            const started = performance.now();
                            const response = await fetch(
                                `${base}/api/c/${imageSession}/image/${imageEntries[index]}/0`,
                                {
                                    headers: { authorization: `Bearer ${token}` },
                                },
                            );
                            const bytes = Buffer.from(await response.arrayBuffer());

                            clientMs += performance.now() - started;
                            assert.equal(response.status, 200);
                            assert.equal(response.headers.get("content-type"), "image/png");
                            assert.equal(
                                response.headers.get("cache-control"),
                                "private, max-age=31536000, immutable",
                            );
                            assert.deepEqual(
                                bytes,
                                images[index],
                                "the actual HTTP body, not just its size or signature",
                            );

                            return bytes.length;
                        }),
                    );

                    await imageProbe.settled();
                    const measured = imageProbe.report(indices.length);

                    assert.equal(
                        inferenceRequests(),
                        beforeInference,
                        "retrieval must not call the model",
                    );
                    assert.equal(
                        since(beforeWork)["subprocess.total"] ?? 0,
                        0,
                        "retrieval must not start a child",
                    );
                    assert.equal(measured.counts["image.lookup.calls"], indices.length);
                    assert.equal(measured.counts["image.decode.calls"], indices.length);
                    assert.equal(
                        measured.counts["image.decode.bytes"],
                        sizes.reduce((a, b) => a + b, 0),
                    );

                    return {
                        ...measured.counts,
                        "http.body.bytes": sizes.reduce((a, b) => a + b, 0),
                    };
                },
                () => ({ ...imageProbe.report(indices.length).timings, imageClientMs: clientMs }),
            );
        }
    } finally {
        setHandler(unprobedHandler);
        imageProbe.restore();
    }

    // Transcript thumbnails: what the browser asks for to show a stored image inline. The body must be a real image of
    // the type it claims; its size is whatever the server chooses to send for a thumbnail.
    for (const name of ["image.thumbs.first", "image.thumbs.again"]) {
        await scenario(name, async () => {
            const beforeInference = inferenceRequests();
            const sizes = await Promise.all(
                Array.from({ length: WORKLOAD.imageParallel }, async (_, offset) => {
                    const index = WORKLOAD.imageParallel + 1 + offset;
                    const response = await fetch(
                        `${base}/api/c/${imageSession}/image/${imageEntries[index]}/0?size=thumb`,
                        { headers: { authorization: `Bearer ${token}` } },
                    );
                    const bytes = Buffer.from(await response.arrayBuffer());

                    assert.equal(response.status, 200);
                    assert.equal(response.headers.get("content-type"), sniffImage(bytes));
                    assert.equal(
                        response.headers.get("cache-control"),
                        "private, max-age=31536000, immutable",
                    );

                    return bytes.length;
                }),
            );

            assert.equal(
                inferenceRequests(),
                beforeInference,
                "thumbnails must not call the model",
            );

            return { "http.body.bytes": sizes.reduce((a, b) => a + b, 0) };
        });
    }

    const imageNetwork = await measureImageNetwork({
        base,
        token,
        paths: Array.from({ length: WORKLOAD.imageParallel }, (_, offset) => {
            const index = 2 * WORKLOAD.imageParallel + 1 + offset;

            return `/api/c/${imageSession}/image/${imageEntries[index]}/0?size=thumb`;
        }),
        profile: join(root, "perf-image-network"),
        quiet,
    });

    context.results.push(
        "unavailable" in imageNetwork
            ? { scenario: "image.thumbs.network", unavailable: imageNetwork.unavailable }
            : {
                  scenario: "image.thumbs.network",
                  ms: imageNetwork.ms,
                  counts: imageNetwork.counts,
              },
    );

    const beforePasteInference = inferenceRequests();
    const pasteNetwork = await measurePasteNetwork({
        base,
        token,
        conversation: imageSession,
        profile: join(root, "perf-paste-network"),
        quiet,
    });

    assert.equal(
        inferenceRequests(),
        beforePasteInference,
        "pasting/uploading must not call the model",
    );
    context.results.push(
        "unavailable" in pasteNetwork
            ? { scenario: "image.paste.network", unavailable: pasteNetwork.unavailable }
            : { scenario: "image.paste.network", ms: pasteNetwork.ms, counts: pasteNetwork.counts },
    );

    const originalTags = images.map(
        (image) => `"sha256-${createHash("sha256").update(image).digest("hex")}"`,
    );

    for (const name of ["image.original.again", "image.original.validated"]) {
        await scenario(name, async () => {
            const beforeInference = inferenceRequests();
            const sizes = await Promise.all(
                Array.from({ length: WORKLOAD.imageParallel }, async (_, offset) => {
                    const index = offset + 1;
                    const response = await fetch(
                        `${base}/api/c/${imageSession}/image/${imageEntries[index]}/0`,
                        {
                            headers: {
                                authorization: `Bearer ${token}`,
                                ...(name.endsWith("validated")
                                    ? { "if-none-match": originalTags[index]! }
                                    : {}),
                            },
                        },
                    );
                    const bytes = Buffer.from(await response.arrayBuffer());

                    assert.ok(
                        response.status === 200 ||
                            (name.endsWith("validated") && response.status === 304),
                    );

                    if (response.status === 304) {
                        assert.equal(response.headers.get("etag"), originalTags[index]);
                        assert.equal(bytes.length, 0);
                    } else {
                        assert.deepEqual(
                            bytes,
                            images[index],
                            "repeated originals must still be byte-identical",
                        );
                    }

                    return bytes.length;
                }),
            );

            assert.equal(inferenceRequests(), beforeInference);

            return { "http.body.bytes": sizes.reduce((a, b) => a + b, 0) };
        });
    }

    // Changes polling on a long history whose entries carry images: four tabs ask at once, then all four ask again
    // with nothing changed (what the browser's 4-8 s poll does while the agent works).
    await scenario("changes.poll.images", async () => {
        let bytes = 0;

        for (let round = 0; round < 2; round++) {
            const answers = await Promise.all(
                Array.from({ length: WORKLOAD.projectionTabs }, () =>
                    call(`c/${imageSession}/changes`),
                ),
            );
            const first = raw.stringify(answers[0]!.value);

            assert.ok(Array.isArray(answers[0]!.value.files), "a changes listing");
            assert.ok(
                answers.every((answer) => raw.stringify(answer.value) === first),
                "every tab sees the same changes",
            );
            bytes += answers.reduce((sum, answer) => sum + answer.bytes, 0);
        }

        return { "http.body.bytes": bytes };
    });
}
