// Executed in the real app's Chromium page by media-ui.test.ts. No model call, and one real clipboard upload.
(async () => {
    const { preparePastedImage: prepare } = await import("/pasted-image.js");

    const check = (condition, message) => {
        if (!condition) {
            throw new Error(message);
        }
    };

    const canvas = new OffscreenCanvas(3000, 1500);
    const context = canvas.getContext("2d");
    const pixels = context.createImageData(3000, 1500);
    let state = 137;

    for (let i = 0; i < pixels.data.length; i += 4) {
        for (let j = 0; j < 3; j++) {
            state ^= state << 13;
            state ^= state >>> 17;
            state ^= state << 5;
            pixels.data[i + j] = state & 255;
        }

        pixels.data[i + 3] = i < 3000 * 100 * 4 ? 0 : 255;
    }

    context.putImageData(pixels, 0, 0);
    const original = new File(
        [await canvas.convertToBlob({ type: "image/png" })],
        "clipboard.png",
        { type: "image/png", lastModified: 1234 },
    );
    const copy = await prepare(original);
    const bitmap = await createImageBitmap(copy);
    const sample = new OffscreenCanvas(1, 1).getContext("2d");

    sample.drawImage(bitmap, 0, 0);
    check(copy !== original && copy.size < original.size, "large paste should shrink");
    check(bitmap.width === 2000 && bitmap.height === 1000, "aspect ratio and 2000 px limit");
    check(
        copy.name === "clipboard.png" && copy.type === "image/png" && copy.lastModified === 1234,
        "file metadata",
    );
    check(sample.getImageData(0, 0, 1, 1).data[3] === 0, "transparency survives");
    bitmap.close();
    const smallCanvas = new OffscreenCanvas(32, 16);

    smallCanvas.getContext("2d");
    const small = new File([await smallCanvas.convertToBlob({ type: "image/png" })], "small.png", {
        type: "image/png",
    });

    check((await prepare(small)) === small, "small images stay byte-identical");

    for (const type of ["image/gif", "image/webp", "image/svg+xml", "application/pdf"]) {
        const file = new File(["not decoded"], "file", { type });

        check((await prepare(file)) === file, type + " must not be flattened or decoded");
    }

    const broken = new File(["broken"], "broken.png", { type: "image/png" });

    check((await prepare(broken)) === broken, "broken inputs fall back");
    // An acTL chunk before IDAT must short-circuit before decode (test marker, not a claim of a valid animation).
    const bytes = new Uint8Array(await original.arrayBuffer());
    const marker = new Uint8Array([0, 0, 0, 0, 97, 99, 84, 76, 0, 0, 0, 0]);
    const animated = new File([bytes.subarray(0, 33), marker, bytes.subarray(33)], "animated.png", {
        type: "image/png",
    });

    check((await prepare(animated)) === animated, "APNG is not flattened");
    const jpeg = new File(
        [await canvas.convertToBlob({ type: "image/jpeg", quality: 0.05 })],
        "compressed.jpg",
        { type: "image/jpeg" },
    );

    check((await prepare(jpeg)) === jpeg, "do not replace efficient JPEG with a larger PNG");
    const convert = OffscreenCanvas.prototype.convertToBlob;

    try {
        OffscreenCanvas.prototype.convertToBlob = async () => {
            throw new Error("fixture conversion failure");
        };

        check((await prepare(original)) === original, "conversion failure falls back");
    } finally {
        OffscreenCanvas.prototype.convertToBlob = convert;
    }

    const decode = window.createImageBitmap;

    try {
        window.createImageBitmap = undefined;
        check((await prepare(original)) === original, "unsupported browser fallback");
    } finally {
        window.createImageBitmap = decode;
    }

    const Offscreen = window.OffscreenCanvas;

    try {
        window.OffscreenCanvas = undefined;
        check((await prepare(original)).size < original.size, "HTML canvas fallback");
    } finally {
        window.OffscreenCanvas = Offscreen;
    }

    const fetch = window.fetch;
    let uploads = 0;
    const uploaded = new Promise((resolve, reject) => {
        window.fetch = async (...args) => {
            const response = await fetch(...args);

            if (String(args[0]).includes("/upload?")) {
                uploads++;

                try {
                    resolve({ path: String(args[0]), attachment: await response.clone().json() });
                } catch (error) {
                    reject(error);
                }
            }

            return response;
        };
    });

    try {
        const clipboard = new DataTransfer();

        clipboard.items.add(original);
        const textarea = document.querySelector(".composer textarea");

        check(!!textarea, "real composer must exist");
        textarea.dispatchEvent(
            new ClipboardEvent("paste", {
                clipboardData: clipboard,
                bubbles: true,
                cancelable: true,
            }),
        );
        const { path, attachment } = await uploaded;

        check(
            attachment.size === copy.size && attachment.mime === "image/png",
            "server received resized representation",
        );
        check(uploads === 1, "no second/background original upload");

        return {
            width: 2000,
            height: 1000,
            bytes: copy.size,
            originalBytes: original.size,
            uploadPath: path,
            uploads,
        };
    } finally {
        window.fetch = fetch;
    }
})();
