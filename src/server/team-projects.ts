/** Application sharing rights. Native code execution remains a trusted-team OS boundary. */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import type { User } from "./config.ts";
import { HttpError } from "./errors.ts";
export type ProjectGrant = { view: boolean; continue: boolean; fork: boolean };
export type TeamProject = {
    id: string;
    name: string;
    cwd: string;
    members: Record<string, ProjectGrant>;
};
export class TeamProjects {
    readonly #file: string;
    #projects: TeamProject[];
    constructor(data: string) {
        this.#file = join(data, "projects.json");
        this.#projects = existsSync(this.#file) ? JSON.parse(readFileSync(this.#file, "utf8")) : [];
    }
    all(user: User): TeamProject[] {
        return this.#projects
            .filter((project) => user.role === "owner" || project.members[user.id]?.view)
            .map((project) =>
                user.role === "owner"
                    ? structuredClone(project)
                    : { ...project, members: { [user.id]: { ...project.members[user.id]! } } },
            );
    }
    forFolder(cwd: string): TeamProject | undefined {
        const canonical = realpathSync(cwd);

        return [...this.#projects]
            .sort((a, b) => b.cwd.length - a.cwd.length)
            .find(
                (project) => canonical === project.cwd || canonical.startsWith(project.cwd + sep),
            );
    }
    allowed(user: User, id: string | undefined, action: keyof ProjectGrant): boolean {
        return (
            user.role === "owner" ||
            id === undefined ||
            this.#projects.find((project) => project.id === id)?.members[user.id]?.[action] === true
        );
    }
    require(user: User, id: string | undefined, action: keyof ProjectGrant): void {
        if (!this.allowed(user, id, action)) {
            throw new HttpError(403, `This project does not grant ${action} access.`);
        }
    }
    save(user: User, draft: unknown, memberExists: (id: string) => boolean): TeamProject {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can change projects.");
        }

        const value = draft as Partial<TeamProject> | null;

        if (
            !value ||
            typeof value.name !== "string" ||
            !value.name.trim() ||
            value.name.length > 100 ||
            typeof value.cwd !== "string" ||
            typeof value.members !== "object" ||
            value.members === null ||
            Array.isArray(value.members)
        ) {
            throw new HttpError(
                400,
                "A project needs name, server working directory and explicit member grants.",
            );
        }

        if (value.id !== undefined && !this.#projects.some((project) => project.id === value.id)) {
            throw new HttpError(404, "No such project.");
        }

        const members: Record<string, ProjectGrant> = {};

        for (const [id, grant] of Object.entries(value.members)) {
            if (
                !memberExists(id) ||
                !grant ||
                [grant.view, grant.continue, grant.fork].some(
                    (flag) => typeof flag !== "boolean",
                ) ||
                (!grant.view && (grant.continue || grant.fork))
            ) {
                throw new HttpError(
                    400,
                    "Grants need valid members, boolean view/continue/fork, and view for other rights.",
                );
            }

            members[id] = { view: grant.view, continue: grant.continue, fork: grant.fork };
        }

        const project = {
            id: value.id ?? randomUUID(),
            name: value.name.trim(),
            cwd: realpathSync(value.cwd),
            members,
        };

        if (value.id && this.#projects.find((p) => p.id === value.id)!.cwd !== project.cwd) {
            throw new HttpError(
                409,
                "Project directory is fixed; create a new project to move it.",
            );
        }

        if (this.#projects.some((p) => p.id !== project.id && p.cwd === project.cwd)) {
            throw new HttpError(409, "A project already owns this directory.");
        }

        const next = [...this.#projects.filter((p) => p.id !== project.id), project];
        const temporary = `${this.#file}.${randomUUID()}.tmp`;

        writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: "wx" });
        renameSync(temporary, this.#file);
        this.#projects = next;

        return structuredClone(project);
    }
}
