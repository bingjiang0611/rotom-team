/**
 * A member's personal rotom layer: `AGENTS.md`, `skills/` and `mcp.json` in their private kernel HOME. Rotom loads it
 * natively next to the project's own AGENTS.md and skills, for every run that member pays for. Nothing else in that
 * HOME (auth, models, settings, sessions, MCP sign-ins) is reachable from here.
 */
import { randomUUID } from "node:crypto";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { HttpError } from "./errors.ts";

/** Skill names as Pi accepts them: lowercase words joined by hyphens. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PATH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._ -]{0,127}$/;

export const MAX_INSTRUCTIONS = 64 * 1024;
const MAX_MCP = 64 * 1024;
const MAX_SKILL_FILES = 256;

export const MAX_SKILL_BYTES = 8 * 1024 * 1024;

export type SkillFiles = Record<string, { text?: string; base64?: string }>;
export type PersonalLayer = {
    instructions: string;
    /** The member's `mcp.json` as written: their own servers, which can hold their own tokens. */
    mcp: string;
    skills: { name: string; description: string; files: number }[];
};

export class KernelProfiles {
    readonly #agentDir: (memberId: string) => string;
    /** `agentDir`: the member's private `HOME/.pi/agent`, created canonical and 0700 by the caller. */
    constructor(agentDir: (memberId: string) => string) {
        this.#agentDir = agentDir;
    }

    get(memberId: string): PersonalLayer {
        const agent = this.#agentDir(memberId);
        const file = join(agent, "AGENTS.md");
        const mcp = join(agent, "mcp.json");
        const skills = join(agent, "skills");

        return {
            instructions: existsSync(file) ? readFileSync(file, "utf8") : "",
            mcp: existsSync(mcp) ? readFileSync(mcp, "utf8") : "",
            skills: existsSync(skills)
                ? readdirSync(skills, { withFileTypes: true })
                      .filter((entry) => entry.isDirectory() && SKILL_NAME.test(entry.name))
                      .map((entry) => {
                          const folder = join(skills, entry.name);
                          const manifest = join(folder, "SKILL.md");

                          return {
                              name: entry.name,
                              description: existsSync(manifest)
                                  ? (frontmatter(readFileSync(manifest, "utf8")).description ?? "")
                                  : "",
                              files: countFiles(folder),
                          };
                      })
                      .sort((a, b) => a.name.localeCompare(b.name))
                : [],
        };
    }

    setInstructions(memberId: string, instructions: unknown): void {
        this.save(memberId, { instructions });
    }

    /**
     * Replace the given files and leave the others alone; an empty text removes its file. Everything is checked before
     * anything is written. Pi checks each MCP server itself and skips a bad one, so `mcp` only has to be an
     * `mcpServers` object.
     */
    save(memberId: string, changes: { instructions?: unknown; mcp?: unknown }): void {
        const { instructions, mcp } = changes;

        if (instructions === undefined && mcp === undefined) {
            throw new HttpError(400, "Send instructions, mcp, or both.");
        }

        if (
            instructions !== undefined &&
            (typeof instructions !== "string" || Buffer.byteLength(instructions) > MAX_INSTRUCTIONS)
        ) {
            throw new HttpError(400, "instructions must be text of at most 64 KiB.");
        }

        if (mcp !== undefined) {
            if (typeof mcp !== "string" || Buffer.byteLength(mcp) > MAX_MCP) {
                throw new HttpError(400, "mcp must be the text of an mcp.json of at most 64 KiB.");
            }

            if (mcp !== "") {
                let servers: unknown;

                try {
                    servers = (JSON.parse(mcp) as { mcpServers?: unknown } | null)?.mcpServers;
                } catch {
                    throw new HttpError(400, "mcp.json is not valid JSON.");
                }

                if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
                    throw new HttpError(400, 'mcp.json needs an "mcpServers" object.');
                }
            }
        }

        const agent = this.#agentDir(memberId);

        if (typeof instructions === "string") {
            replace(join(agent, "AGENTS.md"), instructions);
        }

        if (typeof mcp === "string") {
            replace(join(agent, "mcp.json"), mcp);
        }
    }

    /** Replace one skill folder as a whole: the new files land beside it, then take its place. */
    putSkill(memberId: string, name: string, files: unknown): void {
        if (!SKILL_NAME.test(name) || name.length > 64) {
            throw new HttpError(400, "A skill name is lowercase letters and digits joined by '-'.");
        }

        if (!files || typeof files !== "object" || Array.isArray(files)) {
            throw new HttpError(400, "files maps relative paths to { text } or { base64 }.");
        }

        const entries = Object.entries(files as SkillFiles);
        const contents = entries.map(([path, value]) => [path, decode(path, value)] as const);
        const total = contents.reduce((sum, [, data]) => sum + data.length, 0);

        if (entries.length === 0 || entries.length > MAX_SKILL_FILES || total > MAX_SKILL_BYTES) {
            throw new HttpError(400, "A skill has 1–256 files and at most 8 MiB in all.");
        }

        const manifest = contents.find(([path]) => path === "SKILL.md")?.[1];

        if (!manifest) {
            throw new HttpError(400, "A skill needs SKILL.md at its top level.");
        }

        const meta = frontmatter(manifest.toString("utf8"));

        if (meta.name !== name || !meta.description) {
            throw new HttpError(
                400,
                `SKILL.md frontmatter needs name: ${name} and a description, as Pi requires.`,
            );
        }

        const skills = join(this.#agentDir(memberId), "skills");

        mkdirSync(skills, { recursive: true, mode: 0o700 });

        if (lstatSync(skills).isSymbolicLink()) {
            throw new HttpError(409, "The personal skills folder must not be a link.");
        }

        const staged = join(skills, `.incoming-${randomUUID()}`);
        const target = join(skills, name);
        const old = join(skills, `.replaced-${randomUUID()}`);

        try {
            for (const [path, data] of contents) {
                const file = join(staged, ...path.split("/"));

                mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
                writeFileSync(file, data, { mode: 0o600, flag: "wx" });
            }

            if (existsSync(target)) {
                renameSync(target, old);
            }

            renameSync(staged, target);
        } finally {
            rmSync(staged, { recursive: true, force: true });
            rmSync(old, { recursive: true, force: true });
        }
    }

    removeSkill(memberId: string, name: string): void {
        if (!SKILL_NAME.test(name)) {
            throw new HttpError(400, "Unknown skill name.");
        }

        rmSync(join(this.#agentDir(memberId), "skills", name), { recursive: true, force: true });
    }
}

/** Write the file whole, or remove it when `text` is empty. */
function replace(file: string, text: string): void {
    if (text === "") {
        rmSync(file, { force: true });

        return;
    }

    const temporary = `${file}.${randomUUID()}.tmp`;

    writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
}

function decode(path: string, value: { text?: unknown; base64?: unknown } | undefined): Buffer {
    const segments = path.split("/");

    if (segments.length > 8 || segments.some((segment) => !PATH_SEGMENT.test(segment))) {
        throw new HttpError(400, `Skill file paths are plain relative names: ${path}`);
    }

    if (typeof value?.text === "string") {
        return Buffer.from(value.text, "utf8");
    }

    if (typeof value?.base64 === "string") {
        return Buffer.from(value.base64, "base64");
    }

    throw new HttpError(400, `Each skill file is { text } or { base64 }: ${path}`);
}

/** The `name` and `description` of a SKILL.md's YAML frontmatter; plain `key: value` lines only. */
function frontmatter(markdown: string): { name?: string; description?: string } {
    const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1] ?? "";
    const value = (key: string) =>
        new RegExp(`^${key}:\\s*(.+)$`, "m")
            .exec(block)?.[1]
            ?.trim()
            .replace(/^["']|["']$/g, "");

    return { name: value("name"), description: value("description") };
}

function countFiles(folder: string): number {
    return readdirSync(folder, { withFileTypes: true, recursive: true }).filter((entry) =>
        entry.isFile(),
    ).length;
}
