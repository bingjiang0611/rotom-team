/**
 * Smaller copies of the images stored in messages, for the transcript (a thumbnail) and the full screen viewer (a
 * preview). People see an image at a few hundred pixels; the original, often a 2–3 MB screenshot, is sent only when
 * they ask for it. A copy is made once per image, by macOS's `sips`, off any other request's path, and kept as a
 * file under `<data>/media/`; entries never change, so a copy never goes stale. Every request still checks that the
 * entry is visible from the session asked about (its own, or inherited through forks), from a small record of
 * which session owns the entry: the image itself is not read again.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Image types a message may carry and the app serves (others are refused, as before). */
export const ENTRY_IMAGE_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
]);

export type ImageSize = "thumb" | "preview";

/** The longest edge of each size, in pixels. */
export const EDGE: Record<ImageSize, number> = { thumb: 480, preview: 1600 };

/** At most this many resizes at a time: a long history opened at once must not start a child per image. */
const SLOTS = 2;
/** Records kept in memory; the files under `media/` are the source, so this only saves a small read. */
const KEEP_RECORDS = 4096;
/** A resize that takes longer than this is abandoned, and the original is sent. */
const RESIZE_TIMEOUT_MS = 20_000;

/** What a stored image is, once seen: who owns its entry, and what each size is (a file, or the original). */
type ImageRecord = {
    owner: number;
    mimeType: string;
    sha256: string;
    sizes: Partial<Record<ImageSize, "original" | { file: string; mimeType: string }>>;
};

export type StoredImage = { owner: number; mimeType: string; data: Buffer };

/** A resized copy, or `original` when no smaller copy is worth sending (already small, animated, or no resizer). */
export type Resized = "original" | { data: Buffer; mimeType: string };

export type Resize = (
    data: Buffer,
    mimeType: string,
    edge: number,
    dir: string,
) => Promise<Resized>;

/** How an image is looked up and checked, as `Transcripts` does it. */
export interface ImageSource {
    /** The image and its entry's owner, when the entry is visible from `id`. */
    stored(id: number, entryId: number, index: number): Promise<StoredImage | undefined>;
    /** Whether an entry owned by `owner` is visible from `id`, without reading the entry. */
    visible(id: number, entryId: number, owner: number): Promise<boolean>;
}

/** Resize with macOS's `sips`: never larger than the original, never upscaled; PNG keeps transparency. */
export const sipsResize: Resize = async (data, mimeType, edge, dir) => {
    // An animated GIF would lose its animation; a small one gains nothing.
    if (mimeType === "image/gif") {
        return "original";
    }

    const input = join(dir, `${randomUUID()}.in`);
    const output = join(dir, `${randomUUID()}.out`);

    await writeFile(input, data, { mode: 0o600 });

    try {
        const info = (
            await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", "-g", "hasAlpha", input], {
                timeout: RESIZE_TIMEOUT_MS,
            })
        ).stdout;
        const field = (name: string) => new RegExp(`${name}: (\\S+)`).exec(info)?.[1];
        const width = Number(field("pixelWidth"));
        const height = Number(field("pixelHeight"));

        if (!(width > 0 && height > 0) || Math.max(width, height) <= edge) {
            return "original";
        }

        const png = field("hasAlpha") === "yes";

        await run(
            "sips",
            [
                "-Z",
                String(edge),
                "-s",
                "format",
                png ? "png" : "jpeg",
                ...(png ? [] : ["-s", "formatOptions", "80"]),
                input,
                "--out",
                output,
            ],
            { timeout: RESIZE_TIMEOUT_MS },
        );
        const resized = await readFile(output);

        return resized.length === 0 || resized.length >= data.length
            ? "original"
            : { data: resized, mimeType: png ? "image/png" : "image/jpeg" };
    } finally {
        await Promise.all([rm(input, { force: true }), rm(output, { force: true })]);
    }
};

/** The smaller copies of stored images, kept under `dir`. */
export class MediaStore {
    readonly #dir: string;
    readonly #source: ImageSource;
    readonly #resize: Resize | undefined;
    readonly #records = new Map<string, ImageRecord>();
    /** One lookup or resize at a time per image and size, shared by every request for it. */
    readonly #making = new Map<string, Promise<Resized | undefined>>();
    /** Resizes that failed in this process: not retried on every request, and not remembered on disk. */
    readonly #failed = new Set<string>();
    #busy = 0;
    readonly #waiting: (() => void)[] = [];
    #ready: Promise<void> | undefined;

    constructor(
        dir: string,
        source: ImageSource,
        /** Undefined: `sips` on macOS. Null: no smaller copies; originals are sent. */
        resize?: Resize | null,
    ) {
        this.#dir = dir;
        this.#source = source;
        this.#resize =
            resize === undefined
                ? process.platform === "darwin"
                    ? sipsResize
                    : undefined
                : (resize ?? undefined);
    }

    /**
     * Image `index` of entry `entryId` at `size`, as seen from session `id`: a smaller copy, `original` when the
     * original should be sent instead (the caller sends it the usual way), or undefined when there is no such image
     * here. Visibility is checked on every call.
     */
    async image(
        id: number,
        entryId: number,
        index: number,
        size: ImageSize,
    ): Promise<Resized | undefined> {
        if (!Number.isInteger(entryId) || !Number.isInteger(index) || index < 0) {
            return undefined;
        }

        if (this.#resize === undefined) {
            return "original";
        }

        const key = `${entryId}.${index}`;
        const known = this.#records.get(key) ?? (await this.#readRecord(key));

        if (known !== undefined) {
            if (!(await this.#source.visible(id, entryId, known.owner))) {
                return undefined;
            }

            const kept = known.sizes[size];

            if (kept === "original") {
                return "original";
            }

            if (kept !== undefined) {
                const data = await readFile(join(this.#dir, kept.file)).catch(() => undefined);

                if (data !== undefined) {
                    return { data, mimeType: kept.mimeType };
                }
            }
        }

        // Shared only between requests from the same session: visibility differs between sessions.
        const job = `${id}:${key}:${size}`;
        const pending = this.#making.get(job);

        if (pending !== undefined) {
            return pending;
        }

        const making = this.#make(id, entryId, index, size, key).finally(() =>
            this.#making.delete(job),
        );

        this.#making.set(job, making);

        return making;
    }

    async #make(
        id: number,
        entryId: number,
        index: number,
        size: ImageSize,
        key: string,
    ): Promise<Resized | undefined> {
        const image = await this.#source.stored(id, entryId, index);

        if (image === undefined || !ENTRY_IMAGE_TYPES.has(image.mimeType)) {
            return undefined;
        }

        const sha256 = createHash("sha256").update(image.data).digest("hex");
        const failure = `${sha256}:${size}`;

        if (this.#failed.has(failure)) {
            return "original";
        }

        await this.#prepare();
        let resized: Resized;

        await this.#slot();

        try {
            resized = await this.#resize!(image.data, image.mimeType, EDGE[size], this.#tmp);
        } catch (error) {
            console.error(`Could not resize an image (${size}):`, (error as Error).message);
            this.#failed.add(failure);

            return "original";
        } finally {
            this.#release();
        }

        let kept: ImageRecord["sizes"][ImageSize];

        if (resized === "original") {
            kept = "original";
        } else {
            const file = `${sha256}-${size}.${resized.mimeType === "image/png" ? "png" : "jpg"}`;

            await this.#atomicWrite(join(this.#dir, file), resized.data);
            kept = { file, mimeType: resized.mimeType };
        }

        // Another size of the same image may have finished meanwhile: add to its record.
        const record: ImageRecord = this.#records.get(key) ?? {
            owner: image.owner,
            mimeType: image.mimeType,
            sha256,
            sizes: {},
        };

        record.sizes[size] = kept;
        this.#remember(key, record);
        await this.#atomicWrite(this.#recordPath(key), Buffer.from(JSON.stringify(record)));

        return resized;
    }

    get #tmp(): string {
        return join(this.#dir, "tmp");
    }

    #recordPath(key: string): string {
        return join(this.#dir, "entries", `${key}.json`);
    }

    async #prepare(): Promise<void> {
        this.#ready ??= Promise.all([
            mkdir(join(this.#dir, "entries"), { recursive: true, mode: 0o700 }),
            mkdir(this.#tmp, { recursive: true, mode: 0o700 }),
        ]).then(() => undefined);

        return this.#ready;
    }

    async #readRecord(key: string): Promise<ImageRecord | undefined> {
        try {
            const record = JSON.parse(await readFile(this.#recordPath(key), "utf8")) as ImageRecord;

            if (
                !Number.isInteger(record?.owner) ||
                typeof record.sha256 !== "string" ||
                typeof record.sizes !== "object"
            ) {
                return undefined;
            }

            this.#remember(key, record);

            return record;
        } catch {
            return undefined;
        }
    }

    #remember(key: string, record: ImageRecord): void {
        this.#records.delete(key);
        this.#records.set(key, record);

        for (const oldest of this.#records.keys()) {
            if (this.#records.size <= KEEP_RECORDS) {
                break;
            }

            this.#records.delete(oldest);
        }
    }

    async #atomicWrite(path: string, data: Buffer): Promise<void> {
        const temporary = join(this.#tmp, `${randomUUID()}.part`);

        await writeFile(temporary, data, { mode: 0o600 });
        await rename(temporary, path);
    }

    async #slot(): Promise<void> {
        if (this.#busy < SLOTS) {
            this.#busy++;

            return;
        }

        await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }

    #release(): void {
        const next = this.#waiting.shift();

        if (next === undefined) {
            this.#busy--;
        } else {
            next();
        }
    }
}
