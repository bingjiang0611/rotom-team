/** The web app's own files and the modules it imports, its content security policy, and image files it shows. */
import { createHash } from "node:crypto";
import { closeSync, createReadStream, openSync, readSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, join } from "node:path";
import { APP_ROOT } from "../config.ts";
import { HttpError } from "../errors.ts";
import { send } from "./io.ts";
import { asset, readAsset, sendAsset } from "./static-cache.ts";

export const WEB = join(APP_ROOT, "web");
const MODULES = join(APP_ROOT, "node_modules");

export const VENDOR: Record<string, string> = {
    "preact.mjs": join(MODULES, "preact", "dist", "preact.mjs"),
    "preact-hooks.mjs": join(MODULES, "preact", "hooks", "dist", "hooks.mjs"),
    "htm.mjs": join(MODULES, "htm", "dist", "htm.module.js"),
    "marked.mjs": join(MODULES, "marked", "lib", "marked.esm.js"),
    "purify.mjs": join(MODULES, "dompurify", "dist", "purify.es.mjs"),
};

export const TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
    ".pdf": "application/pdf",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
};

/** File types the image route shows; the bytes must match too (see `sniffImage`). */
const IMAGE_EXTENSIONS = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".avif",
    ".bmp",
    ".ico",
    ".svg",
]);
const MAX_IMAGE_FILE = 25 * 1024 * 1024;
/** Opened on its own, an SVG could run script: give it an opaque origin and nothing to load. */
const IMAGE_CSP =
    "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";

/** The image type of a file's first bytes, or undefined when it is not an image this app shows. */
export function sniffImage(head: Buffer): string | undefined {
    const ascii = (start: number, text: string) =>
        head.subarray(start, start + text.length).toString("latin1") === text;

    if (head[0] === 0x89 && ascii(1, "PNG\r\n\x1a\n")) {
        return "image/png";
    }

    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
        return "image/jpeg";
    }

    if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) {
        return "image/gif";
    }

    if (ascii(0, "RIFF") && ascii(8, "WEBP")) {
        return "image/webp";
    }

    if (ascii(4, "ftypavif") || ascii(4, "ftypavis")) {
        return "image/avif";
    }

    if (ascii(0, "BM")) {
        return "image/bmp";
    }

    if (head[0] === 0 && head[1] === 0 && head[2] === 1 && head[3] === 0) {
        return "image/x-icon";
    }

    const text = head
        .toString("utf8")
        .replace(/^\uFEFF/, "")
        .trimStart();

    if (text.startsWith("<") && /<svg[\s>]/i.test(text)) {
        return "image/svg+xml";
    }

    return undefined;
}

/**
 * The app page's policy. Replies show markdown that Pi wrote, and what Pi writes can be steered by any file or page it
 * reads: nothing on the page may load from, send to, or post to another site. The inline import map is allowed by hash.
 */
function appPolicy(html: string): string {
    // Browsers hash script text after turning CRLF and CR into LF, as their HTML parser does.
    const hashes = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(
        (match) =>
            `'sha256-${createHash("sha256").update(match[1]!.replace(/\r\n?/g, "\n")).digest("base64")}'`,
    );

    return [
        "default-src 'self'",
        ["script-src 'self'", ...hashes].join(" "),
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "media-src 'self' data: blob:",
        "connect-src 'self'",
        "frame-src 'self'",
        "worker-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'self'",
    ].join("; ");
}

let page:
    { sources: Map<string, string>; value: ReturnType<typeof asset>; policy: string } | undefined;
let preparingPage: Promise<NonNullable<typeof page>> | undefined;

/** Static imports only. Preloads fetch modules; the original script/import order still controls evaluation. */
async function appPage() {
    if (page) {
        const unchanged = await Promise.all(
            [...page.sources].map(async ([file, etag]) => (await readAsset(file)).etag === etag),
        );

        if (unchanged.every(Boolean)) {
            return page;
        }
    }

    const index = join(WEB, "index.html");
    const original = await readAsset(index);
    const html = original.body.toString("utf8");
    const importMap = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
    const imports = importMap
        ? (JSON.parse(importMap[1]!) as { imports: Record<string, string> }).imports
        : {};
    const sources = new Map([[index, original.etag]]);
    const urls = new Set<string>();

    const visit = async (url: string): Promise<void> => {
        if (urls.has(url)) {
            return;
        }

        urls.add(url);
        const file = url.startsWith("/vendor/") ? VENDOR[url.slice(8)] : join(WEB, url.slice(1));

        if (!file) {
            throw new Error(`Unknown module preload: ${url}`);
        }

        const module = await readAsset(file);

        sources.set(file, module.etag);

        // The repository uses literal static ESM imports; dynamic imports remain lazy. If the
        // module syntax changes, replace this scanner with a parser, not speculative extra links.
        for (const match of module.body
            .toString("utf8")
            .matchAll(
                /(?:^|\n)\s*(?:import\s*(?:[^'";]*?\sfrom\s*)?|export\s+[^'";]*?\sfrom\s*)["']([^"']+)["']/g,
            )) {
            const name = match[1]!;
            const target =
                imports[name] ??
                (name.startsWith(".") || name.startsWith("/")
                    ? new URL(name, `http://app.local${url}`).pathname
                    : undefined);

            if (target?.startsWith("/") && !target.startsWith("//")) {
                await visit(target);
            }
        }
    };

    for (const match of html.matchAll(/<script\s+type="module"\s+src="([^"]+)"/g)) {
        await visit(match[1]!);
    }

    // After the import map, before the body. No script text or execution order is changed.
    const body = html.replace(
        "</head>",
        `${[...urls].map((url) => `<link rel="modulepreload" href="${url}" />`).join("\n")}\n</head>`,
    );

    page = { sources, value: asset(Buffer.from(body)), policy: appPolicy(body) };

    return page;
}

/** The app page with a revalidated import graph and its unchanged script policy. */
export async function serveApp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    preparingPage ??= appPage().finally(() => {
        preparingPage = undefined;
    });
    const current = await preparingPage;

    await sendAsset(request, response, current.value, "text/html; charset=utf-8", {
        "content-security-policy": current.policy,
    });
}

export async function serveFile(
    request: IncomingMessage,
    response: ServerResponse,
    file: string,
    fallbackType?: string,
): Promise<void> {
    let value: Awaited<ReturnType<typeof readAsset>>;

    try {
        value = await readAsset(file);
    } catch (error) {
        if (
            !["ENOENT", "ENOTDIR", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
        ) {
            throw error;
        }

        send(response, 404, "Not found");

        return;
    }

    await sendAsset(
        request,
        response,
        value,
        fallbackType ?? TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    );
}

/** A delivered regular file. Only PDFs open inline; HTML and all other files download, never run as app pages. */
export function serveDownload(response: ServerResponse, file: string): void {
    let size: number;

    try {
        const stats = statSync(file);

        if (!stats.isFile()) {
            throw new Error("not a file");
        }

        size = stats.size;
    } catch {
        throw new HttpError(404, "File not found");
    }

    const pdf = extname(file).toLowerCase() === ".pdf";
    const name = encodeURIComponent(basename(file)).replace(
        /['()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );

    response.writeHead(200, {
        "content-type": pdf ? "application/pdf" : "application/octet-stream",
        "content-length": String(size),
        "content-disposition": `${pdf ? "inline" : "attachment"}; filename*=UTF-8''${name}`,
        "cache-control": "private, no-store",
        "content-security-policy": "sandbox; default-src 'none'",
    });
    createReadStream(file)
        .on("error", () => response.destroy())
        .pipe(response);
}

/** An image file from this machine, for `![alt](path)` in replies and for uploaded attachments. */
export function serveImage(request: IncomingMessage, response: ServerResponse, file: string): void {
    if (!IMAGE_EXTENSIONS.has(extname(file).toLowerCase())) {
        throw new HttpError(415, "Only image files can be shown");
    }

    let size: number;
    let mtime: number;
    let type: string | undefined;

    try {
        const stats = statSync(file);

        if (!stats.isFile()) {
            throw new Error("not a file");
        }

        size = stats.size;
        mtime = stats.mtimeMs;
        const head = Buffer.alloc(1024);
        const fd = openSync(file, "r");

        try {
            type = sniffImage(head.subarray(0, readSync(fd, head, 0, head.length, 0)));
        } finally {
            closeSync(fd);
        }
    } catch {
        throw new HttpError(404, "Image not found");
    }

    if (type === undefined) {
        throw new HttpError(415, "That file is not an image");
    }

    if (size > MAX_IMAGE_FILE) {
        throw new HttpError(413, "Image too large to show");
    }

    const etag = `"${size.toString(36)}-${Math.floor(mtime).toString(36)}"`;
    const headers = {
        etag,
        "cache-control": "private, no-cache",
        "content-security-policy": IMAGE_CSP,
    };

    if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, headers);
        response.end();

        return;
    }

    response.writeHead(200, {
        ...headers,
        "content-type": type,
        "content-length": String(size),
    });
    createReadStream(file)
        .on("error", () => response.destroy())
        .pipe(response);
}
