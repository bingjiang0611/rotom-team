/** Uploaded files as readable paths, and supported images as real model input. */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import type { Attachment } from "./commands.ts";
import { ATTACHMENTS_HEADING } from "./entry-format.ts";
import { HttpError } from "./errors.ts";

export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const MAX_INLINE_IMAGE = 5 * 1024 * 1024;
const MAX_INLINE_IMAGES_TOTAL = 20 * 1024 * 1024;

/** An image bounded to the same dimensions as Pi's read tool. */
export async function modelImage(path: string, mimeType: string): Promise<ImageContent> {
    const image = await resizeImage(readFileSync(path), mimeType);

    if (image === null) {
        throw new Error("it could not be made small enough for the model");
    }

    return { type: "image", mimeType: image.mimeType, data: image.data };
}

/** Reject foreign paths and forged metadata instead of silently dropping attachments. */
export function uploadedAttachments(directory: string, value: unknown): Attachment[] {
    if (value === undefined) {
        return [];
    }

    if (!Array.isArray(value) || value.length > 10) {
        throw new HttpError(400, "Send at most 10 attachments at a time.");
    }

    const root = resolve(directory) + sep;
    const realRoot = value.length === 0 ? root : realpathSync(directory) + sep;

    return value.map((file) => {
        if (
            !file ||
            typeof file.path !== "string" ||
            typeof file.name !== "string" ||
            typeof file.mime !== "string" ||
            !Number.isSafeInteger(file.size) ||
            file.size < 0 ||
            !resolve(file.path).startsWith(root)
        ) {
            throw new HttpError(400, "Invalid uploaded attachment.");
        }

        const path = realpathSync(file.path);
        const stat = statSync(path);

        if (!path.startsWith(realRoot) || !stat.isFile() || stat.size !== file.size) {
            throw new HttpError(400, "Invalid uploaded attachment.");
        }

        return { path, name: file.name, mime: file.mime, size: stat.size };
    });
}

export function attachmentText(text: string, files: Attachment[]): string {
    return files.length === 0
        ? text
        : `${text}${ATTACHMENTS_HEADING}${files
              .map(
                  (file) =>
                      `- ${file.path} (${file.name}, ${file.mime || "unknown type"}, ${file.size} bytes)`,
              )
              .join("\n")}`.trim();
}

/** Do not claim an image was sent when the model cannot see it. Non-images stay readable file paths. */
export async function attachmentImages(
    files: Attachment[],
    acceptsImages: boolean,
): Promise<ImageContent[]> {
    const images: ImageContent[] = [];
    let total = 0;

    for (const file of files) {
        if (!IMAGE_TYPES.has(file.mime)) {
            continue;
        }

        if (!acceptsImages) {
            throw new HttpError(
                400,
                "This model does not accept images. Choose an image-capable model.",
            );
        }

        total += file.size;

        if (file.size > MAX_INLINE_IMAGE || total > MAX_INLINE_IMAGES_TOTAL) {
            throw new HttpError(
                413,
                "Images sent to the model can be up to 5 MB each and 20 MB total. Compress them first.",
            );
        }

        images.push(await modelImage(file.path, file.mime));
    }

    return images;
}
