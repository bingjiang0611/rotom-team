/** `/api/c/:id`: one conversation's routes, for people the API has checked may see it. */
import type { ConversationId } from "@earendil-works/pi-durable";
import type { SubmitRequest } from "../commands.ts";
import { HttpError } from "../errors.ts";
import { ARCHIVE_COPY } from "../constants/copy.ts";
import { uploadedAttachments } from "../attachments.ts";
import { teamCommandUsesAdapter } from "../team-command-policy.ts";
import { serveDownload, serveImage } from "./assets.ts";
import { type ApiRequest, json, readJson, send } from "./io.ts";
import { ENTRY_IMAGE_TYPES } from "../media.ts";
import { sendStoredImage } from "./stored-image.ts";
import { conversationUpload } from "./conversation-routes/upload.ts";

/** The most entries one page of a view's earlier entries holds (`GET /api/c/:id/entries`). */
const EARLIER_PAGE = 200;

export async function conversationRoutes(
    api: ApiRequest,
    id: ConversationId,
    parts: string[],
): Promise<void> {
    const { app, request, response, url, user } = api;
    const method = request.method ?? "GET";
    const [, , third, fourth] = parts;

    const rejectRetired = (): never => {
        app.requireArchiveWriteAllowed(id);

        throw new HttpError(409, ARCHIVE_COPY.executionRetired);
    };

    if (third === "seen" && method === "POST" && fourth === undefined) {
        const body = await readJson<{ finishedAt: number }>(request);

        if (!body || typeof body !== "object" || Array.isArray(body)) {
            throw new HttpError(400, "A finishedAt value is required.");
        }

        await app.markRunSeen(id, user, body.finishedAt);

        return json(response, 200, { seen: true });
    }

    if (app.sessionMeta(id)?.backend === "rotom") {
        if (!app.kernel) {
            throw new HttpError(
                409,
                "This native session is paused: rotom backend disabled. It will not run on Durable.",
            );
        }

        if (
            third === "native-settings" &&
            fourth === undefined &&
            (method === "GET" || method === "POST")
        ) {
            const patch =
                method === "POST" ? await readJson<Record<string, unknown>>(request) : undefined;

            if (
                patch !== undefined &&
                (!patch || typeof patch !== "object" || Array.isArray(patch))
            ) {
                throw new HttpError(400, "A settings object is required.");
            }

            return json(response, 200, await app.kernel.nativeSettings(id, user, patch));
        }

        if (third === "native-export" && method === "GET" && fourth === undefined) {
            const format = url.searchParams.get("format") ?? "html";
            const bytes = await app.kernel.nativeExport(id, user, format);

            response.writeHead(200, {
                "Content-Type":
                    format === "jsonl" ? "application/x-ndjson" : "text/html; charset=utf-8",
                "Content-Disposition": `attachment; filename="session-${id}.${format}"`,
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "sandbox",
            });
            response.end(bytes);

            return;
        }

        if (third === "kernel" && method === "GET" && fourth === undefined) {
            return json(response, 200, await app.kernel.snapshot(id, user));
        }

        if (third === "configuration" && method === "POST" && fourth === undefined) {
            const body = await readJson<{
                activate: string;
                requestId: string;
                expectedHead: string;
            }>(request);

            if (
                !body ||
                typeof body !== "object" ||
                Array.isArray(body) ||
                body.activate !== "mine" ||
                Object.keys(body).some(
                    (key) => !["activate", "requestId", "expectedHead"].includes(key),
                )
            ) {
                throw new HttpError(
                    400,
                    "Explicit activate: mine, requestId and expectedHead are required.",
                );
            }

            return json(
                response,
                200,
                await app.kernel.configure(id, user, body.requestId, body.expectedHead),
            );
        }

        if (third === "kernel-request" && method === "GET" && fourth === undefined) {
            return json(
                response,
                200,
                await app.kernel.lookup(
                    id,
                    user,
                    url.searchParams.get("requestId") ?? "",
                    url.searchParams.get("operation") ?? "",
                ),
            );
        }

        if (third === "submit" && method === "POST" && fourth === undefined) {
            const body = await readJson<{
                text: string;
                requestId: string;
                attachments?: unknown;
                mode?: unknown;
                inlineFiles?: unknown;
                wait?: unknown;
            }>(request);

            if (!body || typeof body !== "object" || Array.isArray(body)) {
                throw new HttpError(400, "A JSON object is required.");
            }

            if (
                Object.keys(body).some(
                    (key) =>
                        ![
                            "text",
                            "requestId",
                            "attachments",
                            "mode",
                            "inlineFiles",
                            "wait",
                        ].includes(key),
                ) ||
                (body.attachments !== undefined && !Array.isArray(body.attachments)) ||
                (body.inlineFiles !== undefined && body.inlineFiles !== false) ||
                (body.wait !== undefined && typeof body.wait !== "boolean")
            ) {
                throw new HttpError(
                    400,
                    "Rotom sessions take text only: attachments and inline files are not supported yet.",
                );
            }

            if (typeof body.requestId === "string" && body.requestId.startsWith("#")) {
                throw new HttpError(400, "Request ids starting with # belong to the server.");
            }

            const attachments = uploadedAttachments(
                app.workspace.uploadDirectory(id),
                body.attachments,
            );

            // While Pi works, the composer's message joins the run (steer) or waits for it (followUp).
            if (
                app.kernel.isRunning(id) &&
                (body.mode === "steer" || body.mode === "followUp") &&
                !teamCommandUsesAdapter(body.text)
            ) {
                return json(
                    response,
                    200,
                    await app.kernel.queue(id, user, body.text, body.mode, attachments),
                );
            }

            const result = await app.kernel.submit(
                id,
                user,
                body.requestId,
                body.text,
                body.wait !== false,
                attachments,
            );

            if (result.status === "rejected" && body.text.trimStart().startsWith("/")) {
                throw new HttpError(400, "Unknown or unavailable native slash command.");
            }

            return json(response, 200, result);
        }

        if (third === "mcp" && method === "GET" && fourth === undefined) {
            return json(response, 200, await app.kernel.mcp(id, user, "list"));
        }

        if (third === "mcp" && method === "POST" && fourth !== undefined) {
            return json(
                response,
                200,
                await app.kernel.mcp(id, user, fourth, await readJson(request)),
            );
        }

        if (third === "prompts" && method === "POST" && fourth === undefined) {
            const body = await readJson<{ requestId: string }>(request);

            return json(response, 200, await app.kernel.discoverCommands(id, user, body.requestId));
        }

        if (third === "prompts" && method === "GET") {
            return json(response, 200, await app.kernel.nativeCommands(id, user));
        }

        if (third === "dialog" && method === "POST" && fourth === undefined) {
            return json(
                response,
                200,
                await app.kernel.answerDialog(id, user, await readJson(request)),
            );
        }

        if (third === "configure" && method === "POST" && fourth === undefined) {
            return json(
                response,
                200,
                await app.kernel.chooseModel(id, user, await readJson(request)),
            );
        }

        // Reading, people's chat, and the folder do not run Pi: they work as in any session.
        const shared =
            (method === "HEAD" && third === "image") ||
            (method === "GET" &&
                [
                    "image",
                    "entry",
                    "entries",
                    "export",
                    "file",
                    "download",
                    "file-locations",
                    "files",
                    "view",
                    "changes",
                    "branches",
                ].includes(third ?? "")) ||
            (method === "POST" &&
                ["chat", "react", "pin", "typing", "upload"].includes(third ?? ""));

        if (
            (third === "handoff" || third === "compact" || third === "fork") &&
            method === "POST" &&
            fourth === undefined
        ) {
            const body = await readJson<{
                requestId: string;
                expectedHead: string;
                instructions?: string;
            }>(request);
            const allowed =
                third === "compact" ? ["requestId", "instructions"] : ["requestId", "expectedHead"];

            if (
                !body ||
                typeof body !== "object" ||
                Array.isArray(body) ||
                Object.keys(body).some((key) => !allowed.includes(key))
            ) {
                throw new HttpError(
                    400,
                    "Invalid native operation fields; payer is always your own account.",
                );
            }

            return json(
                response,
                200,
                third === "fork"
                    ? await app.kernel.fork(id, user, body.requestId, body.expectedHead)
                    : third === "handoff"
                      ? await app.kernel.handoff(id, user, body.requestId, body.expectedHead)
                      : await app.kernel.compact(
                            id,
                            user,
                            body.requestId,
                            body.instructions === undefined ? "" : body.instructions,
                        ),
            );
        }

        if (third === "warm" && method === "POST" && fourth === undefined) {
            return json(response, 200, await app.kernel.warm(id, user));
        }

        if (third === "abort" && method === "POST" && fourth === undefined) {
            await app.kernel.abort(id, user);

            return json(response, 200, { requested: true });
        }

        if (!shared && !(third === "configuration" && method === "GET" && fourth === undefined)) {
            throw new HttpError(
                409,
                "This operation is not implemented for the native backend; no Durable fallback is allowed.",
            );
        }
    }

    if (third === "configuration" && method === "GET") {
        return json(response, 200, (await app.configuration(id)) ?? null);
    }

    if (third === "configuration" && method === "POST") {
        const body = await readJson<{ activate?: string }>(request);

        if (body.activate !== "mine") {
            throw new HttpError(
                400,
                "Explicitly choose activate: mine to change this shared session's configuration.",
            );
        }

        return rejectRetired();
    }

    if (third === "submit" && method === "POST") {
        const body = await readJson<SubmitRequest>(request);

        if (typeof body.text !== "string" || typeof body.requestId !== "string") {
            throw new HttpError(400, "text and requestId are required");
        }

        if (body.attachments !== undefined && !Array.isArray(body.attachments)) {
            throw new HttpError(400, "attachments must be a list");
        }

        return rejectRetired();
    }

    if (third === "chat" && method === "POST") {
        const body = await readJson<{
            text?: unknown;
            requestId?: unknown;
            quote?: { entryId?: unknown };
        }>(request);

        if (typeof body.text !== "string" || typeof body.requestId !== "string") {
            throw new HttpError(400, "text and requestId are required");
        }

        const quote =
            typeof body.quote === "object" && body.quote !== null
                ? { entryId: body.quote.entryId }
                : undefined;

        return json(
            response,
            200,
            await app.collab.postChat(id, user, {
                text: body.text,
                requestId: body.requestId,
                ...(quote === undefined ? {} : { quote }),
            }),
        );
    }

    if (third === "react" && method === "POST") {
        const body = await readJson<{ entryId?: unknown; emoji?: unknown }>(request);

        await app.collab.react(id, user, Number(body.entryId), String(body.emoji ?? ""));

        return json(response, 200, { ok: true });
    }

    if (third === "pin" && method === "POST") {
        return json(response, 200, await app.collab.pin(id, user, await readJson(request)));
    }

    if (third === "notes" && method === "POST") {
        const body = await readJson<{ text?: unknown; rev?: unknown }>(request);

        if (typeof body.text !== "string" || typeof body.rev !== "number") {
            throw new HttpError(400, "text and rev are required");
        }

        return json(response, 200, await app.collab.saveNotes(id, user, body.text, body.rev));
    }

    if (third === "turns" && method === "POST") {
        await app.collab.turns(id, user, await readJson(request));

        return json(response, 200, { ok: true });
    }

    if (third === "typing" && method === "POST") {
        const body = await readJson<{ where?: unknown }>(request);

        app.collab.setTyping(id, user, body.where);

        return json(response, 200, { ok: true });
    }

    if (third === "abort" && method === "POST") {
        return rejectRetired();
    }

    if (third === "withdraw" && method === "POST") {
        await readJson<{ submissionId?: number }>(request);

        return rejectRetired();
    }

    if (third === "configure" && method === "POST") {
        await readJson(request);

        return rejectRetired();
    }

    if (third === "reset" && method === "POST") {
        await readJson<{ note?: unknown }>(request);

        return rejectRetired();
    }

    if (third === "instructions" && method === "POST") {
        await readJson<{ text?: unknown }>(request);

        return rejectRetired();
    }

    if (third === "plan" && method === "POST") {
        await readJson<{ on?: unknown; approve?: unknown }>(request);

        return rejectRetired();
    }

    if (third === "schedules" && fourth === undefined && method === "POST") {
        await readJson(request);

        return rejectRetired();
    }

    if (
        third === "schedules" &&
        fourth !== undefined &&
        parts[4] === "cancel" &&
        method === "POST"
    ) {
        return rejectRetired();
    }

    if (third === "goal" && method === "POST") {
        await readJson<{ command?: unknown; clear?: unknown }>(request);

        return rejectRetired();
    }

    if (third === "worktree" && method === "POST") {
        const body = await readJson<{ remove?: unknown; force?: unknown }>(request);

        if (body.remove !== true) {
            throw new HttpError(400, "Only removing a worktree is asked for here");
        }

        return rejectRetired();
    }

    if (third === "fork" && method === "POST") {
        await readJson(request);

        return rejectRetired();
    }

    if (third === "resend" && method === "POST") {
        await readJson(request);

        return rejectRetired();
    }

    if (third === "compact" && method === "POST") {
        const body = await readJson<{ instructions?: unknown }>(request);

        if (
            body.instructions !== undefined &&
            body.instructions !== null &&
            typeof body.instructions !== "string"
        ) {
            throw new HttpError(400, "instructions must be text");
        }

        return rejectRetired();
    }

    if (third === "image" && fourth !== undefined && (method === "GET" || method === "HEAD")) {
        const entryId = Number(fourth);
        const index = Number(parts[4] ?? 0);
        const size = url.searchParams.get("size");

        if (size !== null && size !== "thumb" && size !== "preview" && size !== "original") {
            throw new HttpError(400, "size is thumb, preview or original");
        }

        // Authorization is deliberately before validators/Range: even a 304 or HEAD must not reveal a foreign image.
        const cached = await app.media.image(
            id as unknown as number,
            entryId,
            index,
            size ?? "original",
        );

        if (cached === undefined) {
            throw new HttpError(404, "No such image");
        }

        if (cached !== "original") {
            return sendStoredImage(request, response, cached);
        }

        const image = await app.transcripts.entryImage(id, entryId, index);

        if (image === undefined || !ENTRY_IMAGE_TYPES.has(image.mimeType)) {
            throw new HttpError(404, "No such image");
        }

        return sendStoredImage(request, response, image);
    }

    if (third === "file" && method === "GET") {
        const requested = url.searchParams.get("path") ?? "";

        if (requested.trim() === "") {
            throw new HttpError(400, "path is required");
        }

        return serveImage(
            request,
            response,
            await app.workspace.conversationFile(user, id, requested),
        );
    }

    if (third === "download" && method === "GET") {
        const requested = url.searchParams.get("path") ?? "";

        if (requested.trim() === "") {
            throw new HttpError(400, "path is required");
        }

        return serveDownload(response, await app.workspace.readableFile(user, id, requested));
    }

    if (third === "entry" && fourth !== undefined && method === "GET") {
        const entry = await app.transcripts.fullEntry(id, Number(fourth));

        if (entry === undefined) {
            throw new HttpError(404, "No such entry");
        }

        return json(response, 200, entry);
    }

    if (third === "export" && method === "GET") {
        const { filename, markdown } = await app.transcripts.exportMarkdown(id, user);

        return send(response, 200, markdown, "text/markdown; charset=utf-8", {
            "content-disposition": `attachment; filename="${filename}"`,
        });
    }

    if (third === "changes" && fourth === undefined && method === "GET") {
        return json(response, 200, await app.workspace.changes(id, user));
    }

    if (third === "changes" && fourth === "diff" && method === "GET") {
        return send(
            response,
            200,
            await app.workspace.changeDiff(id, user, url.searchParams.get("path") ?? ""),
            "text/plain; charset=utf-8",
        );
    }

    // The folder's files for `@` mentions. A browser that has the newest list says so with `since` and gets only
    // that; a whole list goes compressed when the browser takes it so.
    if (third === "files" && method === "GET") {
        const listing = await app.workspace.fileList(id, user);

        if (url.searchParams.get("since") === listing.version) {
            return json(response, 200, { version: listing.version, same: true });
        }

        if (!/\bgzip\b/.test(String(request.headers["accept-encoding"] ?? ""))) {
            return send(response, 200, listing.json, "application/json");
        }

        return send(response, 200, await listing.gzipped(), "application/json", {
            "content-encoding": "gzip",
            vary: "accept-encoding",
        });
    }

    // The pinned native registry is the source of truth for slash-command suggestions.
    if (third === "prompts" && method === "GET") {
        if (app.kernel) {
            return json(response, 200, await app.kernel.nativeCommands(id, user));
        }

        return json(response, 200, []);
    }

    if (third === "file-locations" && method === "GET") {
        return json(
            response,
            200,
            await app.workspace.fileLocations(id, user, url.searchParams.get("path") ?? ""),
        );
    }

    if (third === "view" && method === "GET") {
        const requested = url.searchParams.get("path") ?? "";

        if (requested.trim() === "") {
            throw new HttpError(400, "path is required");
        }

        return json(response, 200, await app.workspace.viewFile(id, user, requested));
    }

    if (third === "changes" && fourth === "revert" && method === "POST") {
        const body = await readJson<{ path?: unknown }>(request);

        if (typeof body.path !== "string" || body.path === "") {
            throw new HttpError(400, "path is required");
        }

        await app.workspace.revertChange(id, user, body.path);

        return json(response, 200, { ok: true });
    }

    if (third === "branches" && fourth === undefined && method === "GET") {
        return json(response, 200, await app.workspace.branches(id, user));
    }

    if (third === "branch" && fourth === undefined && method === "POST") {
        return json(
            response,
            200,
            await app.workspace.switchBranch(id, user, (await readJson(request)) ?? {}),
        );
    }

    if (third === "shell" && fourth === undefined && method === "POST") {
        await readJson(request);

        return rejectRetired();
    }

    if (third === "shell" && fourth !== undefined && parts[4] === "stop" && method === "POST") {
        return rejectRetired();
    }

    if (third === "entries" && method === "GET" && fourth === undefined) {
        const before = Number(url.searchParams.get("before"));
        const limit = Number(url.searchParams.get("limit") ?? EARLIER_PAGE);

        if (!Number.isSafeInteger(before) || before < 1) {
            throw new HttpError(400, "before must be an entry id.");
        }

        if (!Number.isSafeInteger(limit) || limit < 1 || limit > EARLIER_PAGE) {
            throw new HttpError(400, `limit must be 1 to ${EARLIER_PAGE}.`);
        }

        const room = await app.room(id);

        try {
            return json(response, 200, { entries: room.earlier(before, limit) });
        } finally {
            app.releaseRoom(room);
        }
    }

    if (third === "history" && method === "GET") {
        return json(
            response,
            200,
            await app.transcripts.history(
                id,
                Number(url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER),
            ),
        );
    }

    if (third === "upload" && method === "POST") {
        app.requireArchiveWriteAllowed(id);
    }

    return conversationUpload(api, id, third, method);
}
