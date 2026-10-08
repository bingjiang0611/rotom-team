/** Explicit personal configuration; new sessions freeze project rules and complete skill trees. */
import { createHash, randomUUID } from "node:crypto";
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { getAgentDir, loadProjectContextFiles, loadSkills } from "@earendil-works/pi-coding-agent";
import { defineDoc, type ConversationId } from "@earendil-works/pi-durable";
import type { User } from "./config.ts";
import { HttpError } from "./errors.ts";

export type PersonalProfile = { name: string; instructions: string; skillDirectories: string[] };
export type ConfigurationSnapshot = {
    id: string;
    digest: string;
    createdBy: string;
    createdAt: number;
    name: string;
    context: string;
    skills: {
        name: string;
        description: string;
        path: string;
        baseDir: string;
        disableModelInvocation: boolean;
    }[];
};
export const ConfigurationDoc = defineDoc<{ snapshot?: ConfigurationSnapshot }>({
    kind: "rotom-team.configuration",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({}),
});
const MAX_BYTES = 8 * 1024 * 1024;

export class TeamProfiles {
    readonly #data: string;
    readonly #snapshots = new Map<ConversationId, ConfigurationSnapshot>();
    constructor(data: string) {
        this.#data = data;
    }
    note(id: ConversationId, doc: { snapshot?: ConfigurationSnapshot } | null): void {
        if (doc?.snapshot) {
            this.#snapshots.set(id, doc.snapshot);
        } else {
            this.#snapshots.delete(id);
        }
    }
    snapshot(id: ConversationId): ConfigurationSnapshot | undefined {
        const snapshot = this.#snapshots.get(id);

        if (snapshot) {
            this.verify(snapshot);
        }

        return snapshot;
    }
    verify(snapshot: ConfigurationSnapshot): void {
        const hash = createHash("sha256");
        let bytes = Buffer.byteLength(snapshot.context);

        for (const skill of snapshot.skills) {
            const tree = join(realpathSync(this.#data), "configuration-snapshots");
            const base = resolve(tree, snapshot.id, skill.name);

            if (
                realpathSync(skill.baseDir) !== base ||
                realpathSync(skill.path) !== join(base, "SKILL.md") ||
                !base.startsWith(tree + sep)
            ) {
                throw new HttpError(
                    409,
                    "Configuration snapshot paths changed. Restore the verified backup or activate a new profile.",
                );
            }

            const scan = (directory: string): void => {
                if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) {
                    throw new HttpError(409, "Configuration snapshot directory changed.");
                }

                for (const name of readdirSync(directory).sort()) {
                    const file = join(directory, name),
                        stat = lstatSync(file);

                    if (stat.isSymbolicLink()) {
                        throw new HttpError(
                            409,
                            "Configuration snapshot contains a changed symlink.",
                        );
                    }

                    if (stat.isDirectory()) {
                        scan(file);
                        continue;
                    }

                    if (!stat.isFile()) {
                        throw new HttpError(
                            409,
                            "Configuration snapshot contains a nonregular file.",
                        );
                    }

                    const content = readFileSync(file);

                    bytes += content.length;

                    if (bytes > MAX_BYTES) {
                        throw new HttpError(413, "Configuration snapshot exceeds 8 MiB.");
                    }

                    hash.update(skill.name + "/" + relative(base, file)).update(content);
                }
            };

            scan(base);
        }

        hash.update(snapshot.context);

        if (bytes > MAX_BYTES || hash.digest("hex") !== snapshot.digest) {
            throw new HttpError(
                409,
                "Configuration snapshot content changed. Restore the verified backup or explicitly activate a new profile.",
            );
        }
    }
    #file(user: User): string {
        return join(this.#data, "profiles", `${user.id}.json`);
    }
    get(user: User): PersonalProfile {
        const file = this.#file(user);

        return existsSync(file)
            ? JSON.parse(readFileSync(file, "utf8"))
            : { name: "Default", instructions: "", skillDirectories: [] };
    }
    save(user: User, value: unknown): PersonalProfile {
        if (user.role === "viewer") {
            throw new HttpError(403, "Viewers cannot configure execution profiles.");
        }

        const draft = value as Partial<PersonalProfile> | null;

        if (
            !draft ||
            typeof draft.name !== "string" ||
            !draft.name.trim() ||
            draft.name.length > 80 ||
            typeof draft.instructions !== "string" ||
            draft.instructions.length > 16000 ||
            !Array.isArray(draft.skillDirectories) ||
            draft.skillDirectories.length > 32 ||
            draft.skillDirectories.some((path) => typeof path !== "string")
        ) {
            throw new HttpError(
                400,
                "A profile needs a name, instructions (max 16000 characters), and up to 32 skill directories.",
            );
        }

        const profile = {
            name: draft.name.trim(),
            instructions: draft.instructions,
            skillDirectories: draft.skillDirectories.map((path) => this.#source(path)),
        };

        mkdirSync(join(this.#data, "profiles"), { recursive: true, mode: 0o700 });
        const file = this.#file(user),
            temporary = `${file}.${randomUUID()}.tmp`;

        writeFileSync(temporary, JSON.stringify(profile), { mode: 0o600, flag: "wx" });
        renameSync(temporary, file);

        return profile;
    }
    #source(path: string): string {
        const canonical = realpathSync(resolve(path));
        const data = realpathSync(this.#data);

        if (canonical === data || canonical.startsWith(data + sep)) {
            throw new HttpError(400, "Do not import the service's private data as skills.");
        }

        if (
            lstatSync(resolve(path)).isSymbolicLink() ||
            !lstatSync(canonical).isDirectory() ||
            !existsSync(join(canonical, "SKILL.md"))
        ) {
            throw new HttpError(
                400,
                "Each explicit skill directory must contain SKILL.md and must not be a symlink.",
            );
        }

        return canonical;
    }
    capture(user: User, cwd: string, paths: string[]): ConfigurationSnapshot {
        const profile = this.get(user);
        const sources = loadSkills({
            cwd,
            agentDir: getAgentDir(),
            skillPaths: paths,
            includeDefaults: true,
        });

        if (sources.diagnostics.some((d) => d.type === "collision")) {
            throw new HttpError(409, "Resolve duplicate project skills before creating a session.");
        }

        const personal = profile.skillDirectories.map((path) => this.#source(path));
        const loaded = loadSkills({
            cwd,
            agentDir: getAgentDir(),
            skillPaths: personal,
            includeDefaults: false,
        });

        if (loaded.skills.length !== personal.length) {
            throw new HttpError(
                400,
                "Each imported skill needs valid frontmatter and a unique name.",
            );
        }

        const selected = [...sources.skills, ...loaded.skills];

        if (new Set(selected.map((skill) => skill.name)).size !== selected.length) {
            throw new HttpError(
                409,
                "Personal and project skill names collide; select different skills explicitly.",
            );
        }

        const id = randomUUID();
        const folder = join(this.#data, "configuration-snapshots", id);

        mkdirSync(folder, { recursive: true, mode: 0o700 });

        try {
            const hash = createHash("sha256");
            let bytes = 0;
            const skills = selected.map((skill) => {
                if (
                    !skill.name ||
                    skill.name === "." ||
                    skill.name === ".." ||
                    /[/\\\\]/.test(skill.name)
                ) {
                    throw new HttpError(400, "Skill names must be single directory names.");
                }

                const source = realpathSync(skill.baseDir);
                const target = join(folder, skill.name);

                const copy = (directory: string, destination: string): void => {
                    mkdirSync(destination, { recursive: true, mode: 0o700 });

                    for (const name of readdirSync(directory).sort()) {
                        const file = join(directory, name),
                            next = join(destination, name),
                            stat = lstatSync(file);

                        if (stat.isSymbolicLink()) {
                            throw new HttpError(
                                400,
                                `Skill ${skill.name} contains a symlink; use a self-contained directory.`,
                            );
                        }

                        if (stat.isDirectory()) {
                            copy(file, next);
                            continue;
                        }

                        if (!stat.isFile()) {
                            throw new HttpError(400, "Only regular skill files are supported.");
                        }

                        bytes += stat.size;

                        if (bytes > MAX_BYTES) {
                            throw new HttpError(
                                413,
                                "Configuration snapshot exceeds 8 MiB; reduce skill assets.",
                            );
                        }

                        const content = readFileSync(file);

                        hash.update(skill.name + "/" + relative(source, file)).update(content);
                        writeFileSync(next, content, {
                            mode: stat.mode & 0o111 ? 0o700 : 0o600,
                            flag: "wx",
                        });
                    }
                };

                copy(source, target);

                return {
                    name: skill.name,
                    description: skill.description,
                    path: join(target, "SKILL.md"),
                    baseDir: target,
                    disableModelInvocation: skill.disableModelInvocation,
                };
            });
            const files = loadProjectContextFiles({ cwd, agentDir: getAgentDir() });
            const context = [
                ...files.map(
                    (file) => `<file path="${file.path}">\n${file.content.trim()}\n</file>`,
                ),
                ...(profile.instructions
                    ? [
                          `<personal-profile name="${profile.name}">\n${profile.instructions}\n</personal-profile>`,
                      ]
                    : []),
            ].join("\n\n");

            if (Buffer.byteLength(context) + bytes > MAX_BYTES) {
                throw new HttpError(413, "Configuration snapshot exceeds 8 MiB.");
            }

            hash.update(context);
            chmodSync(folder, 0o700);

            return {
                id,
                digest: hash.digest("hex"),
                createdBy: user.id,
                createdAt: Date.now(),
                name: profile.name,
                context,
                skills,
            };
        } catch (error) {
            // A refused capture has no durable reference. Preserve committed snapshots, but not partial trees.
            rmSync(folder, { recursive: true, force: true });

            throw error;
        }
    }
}
