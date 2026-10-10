// `rotom-team profile push`: copy your own AGENTS.md and skills to your private layer on a rotom-team server.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

/** Folders a skill never needs on the server. */
const SKIPPED = new Set([".git", "node_modules", ".DS_Store"]);

/** Every file of one skill folder, as the server takes them: relative path → base64. Links are followed. */
function skillFiles(folder) {
    const files = {};

    const walk = (dir) => {
        for (const name of readdirSync(dir)) {
            if (SKIPPED.has(name)) {
                continue;
            }

            const path = join(dir, name);
            const stats = statSync(path);

            if (stats.isDirectory()) {
                walk(path);
            } else if (stats.isFile()) {
                files[relative(folder, path).split("\\").join("/")] = {
                    base64: readFileSync(path).toString("base64"),
                };
            }
        }
    };

    walk(folder);

    return files;
}

/**
 * Replace your AGENTS.md on the server and add or replace each skill found in `agentDir/skills`. Skills already on
 * the server that are not pushed stay. Returns what was sent and what the server refused, skill by skill.
 */
export async function pushProfile({ server, token, agentDir = join(homedir(), ".pi", "agent") }) {
    const call = async (path, method, body) => {
        const response = await fetch(new URL(`/api/${path}`, server), {
            method,
            headers: {
                authorization: `Bearer ${token}`,
                "x-pocket": "1",
                "content-type": "application/json",
            },
            body: JSON.stringify(body),
        });
        const text = await response.text();

        if (!response.ok) {
            throw new Error(`${response.status}: ${JSON.parse(text || "{}").error ?? text}`);
        }

        return JSON.parse(text);
    };

    const report = { instructions: false, skills: [], refused: [] };
    const agents = join(agentDir, "AGENTS.md");

    if (existsSync(agents)) {
        await call("kernel-profile", "POST", { instructions: readFileSync(agents, "utf8") });
        report.instructions = true;
    }

    const skills = join(agentDir, "skills");

    for (const name of existsSync(skills) ? readdirSync(skills).sort() : []) {
        const folder = join(skills, name);

        if (!statSync(folder).isDirectory() || !existsSync(join(folder, "SKILL.md"))) {
            continue;
        }

        try {
            await call(`kernel-profile/skills/${encodeURIComponent(name)}`, "PUT", {
                files: skillFiles(folder),
            });
            report.skills.push(name);
        } catch (error) {
            report.refused.push({ name, error: error.message });
        }
    }

    return report;
}

const usage = `Usage: ROTOM_TEAM_TOKEN=<your sign-in token> rotom-team profile push --server <url> [--agent-dir <dir>]

Copies <dir>/AGENTS.md and each skill folder in <dir>/skills (default ~/.pi/agent) to your private
layer on the server. Create the token from "My instructions & skills" → "Create my private sign-in link".`;

export async function main(args) {
    const option = (name) => {
        const index = args.indexOf(name);

        return index >= 0 ? args[index + 1] : undefined;
    };

    const server = option("--server") ?? process.env.ROTOM_TEAM_URL;
    const token = process.env.ROTOM_TEAM_TOKEN;

    if (args[0] !== "push" || !server || !token) {
        console.error(usage);
        process.exit(2);
    }

    const report = await pushProfile({ server, token, agentDir: option("--agent-dir") });

    console.log(JSON.stringify(report, null, 2));
    process.exit(report.refused.length > 0 ? 1 : 0);
}
