// Reduce large pasted screenshots before upload. Only the chosen representation is uploaded; no background original.
// Small images, animation, unsupported formats/browsers and failed or unhelpful conversions stay unchanged.
const EDGE = 2000;

async function staticPng(file) {
    const signature = new Uint8Array(await file.slice(0, 8).arrayBuffer());

    if (signature.join() !== "137,80,78,71,13,10,26,10") {
        return false;
    }

    let offset = 8;

    // APNG's animation control precedes the first IDAT. Bound metadata inspection; unknown means keep the file.
    for (let count = 0; count < 128 && offset + 8 <= file.size; count++) {
        const bytes = new Uint8Array(await file.slice(offset, offset + 8).arrayBuffer());
        const length = new DataView(bytes.buffer).getUint32(0);
        const type = String.fromCharCode(...bytes.subarray(4));

        if (offset + 12 + length > file.size || type === "acTL") {
            return false;
        }

        if (type === "IDAT") {
            return true;
        }

        offset += length + 12;
    }

    return false;
}

export async function preparePastedImage(file) {
    if (
        !["image/png", "image/jpeg"].includes(file.type) ||
        typeof createImageBitmap !== "function"
    ) {
        return file;
    }

    let bitmap;

    try {
        if (file.type === "image/png" && !(await staticPng(file))) {
            return file;
        }

        bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
        const edge = Math.max(bitmap.width, bitmap.height);

        if (edge <= EDGE || bitmap.width * bitmap.height > 64_000_000) {
            return file;
        }

        const width = Math.max(1, Math.round((bitmap.width * EDGE) / edge));
        const height = Math.max(1, Math.round((bitmap.height * EDGE) / edge));
        const canvas =
            typeof OffscreenCanvas === "function"
                ? new OffscreenCanvas(width, height)
                : document.createElement("canvas");

        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");

        if (!context) {
            return file;
        }

        context.drawImage(bitmap, 0, 0, width, height);
        const blob = canvas.convertToBlob
            ? await canvas.convertToBlob({ type: "image/png" })
            : await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));

        if (!blob || blob.type !== "image/png" || blob.size >= file.size) {
            return file;
        }

        return new File([blob], `${file.name.replace(/\.[^.]+$/, "") || "image"}.png`, {
            type: "image/png",
            lastModified: file.lastModified,
        });
    } catch {
        return file;
    } finally {
        bitmap?.close();
    }
}
