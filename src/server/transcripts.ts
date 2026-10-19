/**
 * A conversation's stored history, as people read it: single entries (its own, or ones a fork inherited), the images
 * in them, what came before the active context, and the whole session as Markdown.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
    ConversationId,
    ConversationRecord,
    Cursor,
    EntryId,
    EntryRecord,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { AuthorsDoc } from "./docs.ts";
import { transcriptMarkdown } from "./export.ts";
import { homePath } from "./paths.ts";
import { type ClientEntry, nativeModel, projectEntry } from "./projection.ts";

const context = BACKGROUND_CONTEXT;

/**
 * Whether an entry owned by `owner` is visible from `id`. Walk up the forks: each one inherits its parent's entries
 * through `parent.at`, and no later ones.
 */
async function visibleFrom(
    tx: { conversation(id: ConversationId): Promise<ConversationRecord | undefined> },
    id: ConversationId,
    entryId: number,
    owner: ConversationId,
): Promise<boolean> {
    let conversation = id;
    let through = Number.POSITIVE_INFINITY;

    for (;;) {
        if (owner === conversation) {
            return entryId <= through;
        }

        const parent: ConversationRecord["parent"] = (await tx.conversation(conversation))?.parent;

        if (parent === undefined) {
            return false;
        }

        through = Math.min(through, parent.at as unknown as number);
        conversation = parent.conversationId;
    }
}

export class Transcripts {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** An image part of a stored message: a pasted image, or an image a tool returned. */
    async entryImage(
        id: ConversationId,
        entryId: number,
        index: number,
    ): Promise<{ mimeType: string; data: Buffer } | undefined> {
        const image = await this.storedImage(id, entryId, index);

        return image === undefined ? undefined : { mimeType: image.mimeType, data: image.data };
    }

    /** `entryImage`, with the session that owns the entry (for `MediaStore`'s record of it). */
    async storedImage(
        id: ConversationId,
        entryId: number,
        index: number,
    ): Promise<{ mimeType: string; data: Buffer; owner: number } | undefined> {
        if (!Number.isInteger(entryId) || !Number.isInteger(index) || index < 0) {
            return undefined;
        }

        const entry = await this.visibleEntry(id, entryId);

        if (entry === undefined) {
            return undefined;
        }

        const content = (nativeModel(entry).model?.[0] as { content?: unknown } | undefined)
            ?.content;

        if (!Array.isArray(content)) {
            return undefined;
        }

        const part = (content as { type?: string; data?: unknown; mimeType?: unknown }[]).filter(
            (each) => each?.type === "image",
        )[index];

        if (typeof part?.data !== "string" || typeof part.mimeType !== "string") {
            return undefined;
        }

        return {
            mimeType: part.mimeType,
            data: Buffer.from(part.data, "base64"),
            owner: entry.conversationId as unknown as number,
        };
    }

    async fullEntry(id: ConversationId, entryId: number): Promise<ClientEntry | undefined> {
        const entry = await this.visibleEntry(id, entryId);

        return entry === undefined ? undefined : projectEntry(entry, true);
    }

    /**
     * An entry of a conversation's history: its own, or one it inherited as a fork (the fork's parent's entries up to
     * the fork point, and so on up the line). Undefined for an entry of any other conversation.
     */
    async visibleEntry(id: ConversationId, entryId: number): Promise<EntryRecord | undefined> {
        if (!Number.isInteger(entryId)) {
            return undefined;
        }

        return this.#app.harness.commit(async (tx) => {
            const entry = await tx.entry(entryId as unknown as EntryId);

            if (entry === undefined) {
                return undefined;
            }

            return (await visibleFrom(tx, id, entryId, entry.conversationId)) ? entry : undefined;
        }, context);
    }

    /**
     * Whether entry `entryId`, owned by session `owner`, is visible from `id`: `visibleEntry`'s check without reading
     * the entry. Entries never move between sessions, so a remembered owner stays right.
     */
    async entryVisible(id: ConversationId, entryId: number, owner: number): Promise<boolean> {
        if (!Number.isInteger(entryId)) {
            return false;
        }

        return this.#app.harness.commit(
            (tx) => visibleFrom(tx, id, entryId, owner as unknown as ConversationId),
            context,
        );
    }

    /** Entries before the active context: what compaction or a reset hid from the model. Oldest first. */
    async history(id: ConversationId, before: number, limit = 400): Promise<ClientEntry[]> {
        const conversation = await this.#app.conversation(id);
        const out: ClientEntry[] = [];
        let cursor: Cursor | undefined;

        do {
            const page = await conversation.entries(
                { maxEntryId: (before - 1) as unknown as EntryId },
                256,
                cursor,
                context,
            );

            for (const entry of page.items) {
                const projected = projectEntry(entry);

                if (projected !== undefined) {
                    out.push(projected);
                }
            }

            cursor = page.next;
        } while (cursor !== undefined && out.length < limit);

        return out.slice(0, limit).reverse();
    }

    /** A conversation's whole history, oldest first, as browsers get it (`full`: nothing clipped). */
    async allEntries(id: ConversationId, full: boolean): Promise<ClientEntry[]> {
        const conversation = await this.#app.conversation(id);
        const entries: ClientEntry[] = [];
        let cursor: Cursor | undefined;

        do {
            const page = await conversation.entries({}, 256, cursor, context);

            for (const entry of page.items) {
                const projected = projectEntry(entry, full);

                if (projected !== undefined) {
                    entries.push(projected);
                }
            }

            cursor = page.next;
        } while (cursor !== undefined);

        return entries.reverse();
    }

    /** A session as a Markdown file: its whole history, with who wrote what. */
    async exportMarkdown(
        id: ConversationId,
        user: User,
    ): Promise<{ filename: string; markdown: string }> {
        this.#app.requireSee(user, id);
        const entries = await this.allEntries(id, true);
        const authors: Record<number, string> = {};

        for (const [entryId, userId] of Object.entries(
            (await this.#app.harness.snapshot(AuthorsDoc, id, context))?.entries ?? {},
        )) {
            authors[Number(entryId)] = this.#app.config.userById(userId)?.name ?? "Someone";
        }

        const agent = await this.#app.agentState(id);
        const title = await this.#app.conversationTitle(id);
        const markdown = transcriptMarkdown({
            title,
            cwd: homePath(this.#app.cwdOf(id)),
            ...(agent?.model === undefined
                ? {}
                : { model: `${agent.model.provider}/${agent.model.modelId}` }),
            exportedAt: new Date(),
            entries,
            authors,
        });
        const slug =
            title
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "")
                .slice(0, 60) || "session";

        return { filename: `${slug}.md`, markdown };
    }
}
