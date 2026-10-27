import { randomUUID } from "node:crypto";
import { createWriteStream, rmSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { Attachment } from "../../commands.ts";
import { HttpError } from "../../errors.ts";
import { TYPES } from "../assets.ts";
import { type ApiRequest, json } from "../io.ts";

const MAX_UPLOAD = 50 * 1024 * 1024;

function safeName(name: string): string {
    const base = basename(name)
        .replace(/[^\w.\- ()]+/g, "_")
        .trim();

    return base === "" || base.startsWith(".") ? `upload${base}` : base.slice(0, 120);
}

export async function conversationUpload(
    api: ApiRequest,
    id: ConversationId,
    third: string | undefined,
    method: string,
): Promise<void> {
    const { app, request, response, url, user } = api;

    if (third === "upload" && method === "POST") {
        app.requireSteer(user);

        if (Number(request.headers["content-length"] ?? 0) > MAX_UPLOAD) {
            throw new HttpError(413, "Files can be up to 50 MB");
        }

        await app.conversation(id);
        const name = safeName(url.searchParams.get("name") ?? "upload");
        const directory = app.workspace.uploadDirectory(id);
        // Unique, and never written over: pasted images all arrive as image.png, often at once.
        const file = join(
            directory,
            `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}-${name}`,
        );
        let size = 0;

        request.on("data", (chunk: Buffer) => {
            size += chunk.length;

            if (size > MAX_UPLOAD) {
                request.destroy(new HttpError(413, "Files can be up to 50 MB"));
            }
        });

        try {
            await pipeline(request, createWriteStream(file, { mode: 0o600, flags: "wx" }));
        } catch (error) {
            // A cut-off or oversized upload leaves nothing behind (and a name already taken was never this upload's).
            // Cut off is the client's doing, not a server error.
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                rmSync(file, { force: true });
            }

            if (error instanceof HttpError || request.complete) {
                throw error;
            }

            throw new HttpError(400, "The upload stopped before it finished");
        }

        const mime =
            String(request.headers["content-type"] ?? "") ||
            TYPES[extname(name).toLowerCase()] ||
            "application/octet-stream";
        const attachment: Attachment = {
            path: file,
            name,
            mime: mime.split(";")[0]!.trim(),
            size,
        };

        return json(response, 200, attachment);
    }

    throw new HttpError(404, "Unknown API route");
}
