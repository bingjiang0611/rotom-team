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
import { constants } from "node:fs";
import { lstat, mkdir, opendir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

/** Derived files only: originals stay in Durable. Evicted copies are rebuilt on demand. */
export const MEDIA_LIMITS = { bytes: 256 * 1024 * 1024, files: 8192, pending: 16 };
const READ_PRIVATE = { flag: constants.O_RDONLY | constants.O_NOFOLLOW };
const BLOB = /^[0-9a-f]{64}-(thumb|preview)\.(jpg|png)$/;
const RECORD = /^\d+\.\d+\.json$/;

/** What a stored image is, once seen: who owns its entry, and what each size is (a file, or the original). */
type ImageRecord = {
    version: 1;
    owner: number;
    mimeType: string;
    sha256: string;
    sizes: Partial<
        Record<
            ImageSize,
            | "original"
            | {
                  file: string;
                  mimeType: string;
                  bytes: number;
                  digest: string;
              }
        >
    >;
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

        if (
            !(width > 0 && height > 0) ||
            width * height > 64_000_000 ||
            Math.max(width, height) <= edge
        ) {
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
    readonly #files = new Map<string, { bytes: number; at: number }>();
    #bytes = 0;
    #writes: Promise<void> = Promise.resolve();
    readonly #limits: typeof MEDIA_LIMITS;

    constructor(
        dir: string,
        source: ImageSource,
        /** Undefined: `sips` on macOS. Null: no smaller copies; originals are sent. */
        resize?: Resize | null,
        limits: Partial<typeof MEDIA_LIMITS> = {},
    ) {
        this.#limits = { ...MEDIA_LIMITS, ...limits };
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

        try {
            await this.#prepare();
        } catch {
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
                const path = join(this.#dir, kept.file);
                const info = await lstat(path).catch(() => undefined);
                const data =
                    info?.isFile() && info.size === kept.bytes
                        ? await readFile(path, READ_PRIVATE).catch(() => undefined)
                        : undefined;

                if (
                    data !== undefined &&
                    data.length === kept.bytes &&
                    createHash("sha256").update(data).digest("hex") === kept.digest
                ) {
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

        if (this.#making.size >= this.#limits.pending) {
            return "original";
        }

        // Acquire before reading the source: queued jobs must not retain a full base64 entry per request.
        const making = this.#slot()
            .then(() => this.#make(id, entryId, index, size, key))
            .finally(() => {
                this.#release();
                this.#making.delete(job);
            });

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

        let resized: Resized;

        try {
            await this.#prepare();
            resized = await this.#resize!(image.data, image.mimeType, EDGE[size], this.#tmp);
        } catch (error) {
            console.error(`Could not resize an image (${size}):`, (error as Error).message);
            this.#failed.add(failure);

            if (this.#failed.size > KEEP_RECORDS) {
                this.#failed.delete(this.#failed.values().next().value!);
            }

            return "original";
        }

        let kept: ImageRecord["sizes"][ImageSize];

        if (resized === "original") {
            kept = "original";
        } else {
            const file = `${sha256}-${size}.${resized.mimeType === "image/png" ? "png" : "jpg"}`;

            // A full/read-only cache must not turn a readable original into an HTTP error.
            await this.#writeFile(join(this.#dir, file), resized.data).catch(() => {});
            kept = {
                file,
                mimeType: resized.mimeType,
                bytes: resized.data.length,
                digest: createHash("sha256").update(resized.data).digest("hex"),
            };
        }

        // Another size of the same image may have finished meanwhile: add to its record.
        const record: ImageRecord = this.#records.get(key) ?? {
            version: 1,
            owner: image.owner,
            mimeType: image.mimeType,
            sha256,
            sizes: {},
        };

        record.sizes[size] = kept;
        this.#remember(key, record);
        await this.#writeFile(this.#recordPath(key), Buffer.from(JSON.stringify(record))).catch(
            () => {},
        );

        return resized;
    }

    get #tmp(): string {
        return join(this.#dir, "tmp");
    }

    #recordPath(key: string): string {
        return join(this.#dir, "entries", `${key}.json`);
    }

    async #prepare(): Promise<void> {
        this.#ready ??= this.#open();

        return this.#ready;
    }

    async #open(): Promise<void> {
        for (const dir of [this.#dir, join(this.#dir, "entries"), this.#tmp]) {
            await mkdir(dir, { recursive: true, mode: 0o700 });
            const info = await lstat(dir);

            if (!info.isDirectory() || info.isSymbolicLink()) {
                throw new Error("The media cache requires private regular directories");
            }
        }

        // One streaming directory walk at first use, not a scan on each request. The retained file index is capped as
        // it is populated, even if a previous version or crash left too much behind.
        for (const [dir, pattern] of [
            [this.#dir, BLOB],
            [join(this.#dir, "entries"), RECORD],
        ] as const) {
            for await (const entry of await opendir(dir)) {
                if (!entry.isFile() || !pattern.test(entry.name)) {
                    continue;
                }

                const path = join(dir, entry.name);
                const info = await lstat(path);

                this.#track(path, info.size, info.mtimeMs);
                await this.#trim();
            }
        }

        for await (const entry of await opendir(this.#tmp)) {
            if (entry.isFile()) {
                await rm(join(this.#tmp, entry.name), { force: true });
            }
        }
    }

    async #readRecord(key: string): Promise<ImageRecord | undefined> {
        try {
            const path = this.#recordPath(key);
            const info = await lstat(path);

            if (!info.isFile() || info.size > 2048) {
                return undefined;
            }

            const bytes = await readFile(path, READ_PRIVATE);
            const record = JSON.parse(bytes.toString("utf8")) as ImageRecord;

            if (
                record?.version !== 1 ||
                !Number.isSafeInteger(record.owner) ||
                record.owner <= 0 ||
                !ENTRY_IMAGE_TYPES.has(record.mimeType) ||
                !/^[0-9a-f]{64}$/.test(record.sha256) ||
                record.sizes === null ||
                typeof record.sizes !== "object"
            ) {
                return undefined;
            }

            for (const [size, value] of Object.entries(record.sizes)) {
                if (size !== "thumb" && size !== "preview") {
                    return undefined;
                }

                if (value === "original") {
                    continue;
                }

                if (
                    value === null ||
                    typeof value !== "object" ||
                    !["image/png", "image/jpeg"].includes(value.mimeType) ||
                    !Number.isSafeInteger(value.bytes) ||
                    value.bytes <= 0 ||
                    value.bytes > this.#limits.bytes ||
                    !/^[0-9a-f]{64}$/.test(value.digest) ||
                    value.file !==
                        `${record.sha256}-${size}.${value.mimeType === "image/png" ? "png" : "jpg"}`
                ) {
                    return undefined;
                }
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

    #writeFile(path: string, data: Buffer): Promise<void> {
        const write = this.#writes.then(async () => {
            const temporary = join(this.#tmp, `${randomUUID()}.part`);

            try {
                await writeFile(temporary, data, { mode: 0o600 });
                await rename(temporary, path);
                this.#track(path, data.length, Date.now());
                await this.#trim();
            } finally {
                await rm(temporary, { force: true });
            }
        });

        this.#writes = write.catch(() => {});

        return write;
    }

    #track(path: string, bytes: number, at: number): void {
        this.#bytes += bytes - (this.#files.get(path)?.bytes ?? 0);
        this.#files.set(path, { bytes, at });
    }

    async #trim(): Promise<void> {
        while (this.#bytes > this.#limits.bytes || this.#files.size > this.#limits.files) {
            let oldest: string | undefined;
            let at = Infinity;

            for (const [path, info] of this.#files) {
                if (info.at < at) {
                    oldest = path;
                    at = info.at;
                }
            }

            if (oldest === undefined) {
                break;
            }

            await rm(oldest, { force: true });
            this.#bytes -= this.#files.get(oldest)!.bytes;
            this.#files.delete(oldest);
        }
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
