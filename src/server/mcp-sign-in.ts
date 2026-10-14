/**
 * Sign-in to the shared agent's MCP servers that use OAuth. The definitions are shared; the sign-in is each member's own:
 * `rotom mcp login` runs in the member's kernel HOME, so the tokens land in that member's `mcp-auth.json` and only
 * their runs send them.
 *
 * `rotom mcp login` waits for the browser on the loopback callback it listens on. A member's browser runs on another
 * machine and cannot reach it, so the member pastes the address the browser ended on, and the server delivers it to
 * that callback: only to that callback's own origin and path, never to another address.
 */
import type { ChildProcess } from "node:child_process";
import { HttpError } from "./errors.ts";
import { startRotomMcp } from "./rotom-kernel.ts";

/** How long a sign-in waits for the member. */
const SIGN_IN_SECONDS = 600;
/** How long Finish waits for the sign-in to end once the callback has its answer. */
const FINISH_MS = 15_000;

/** A server as `rotom mcp list --json` reports it for this member. */
export type McpServerReport = {
    name: string;
    transport: string;
    state: string;
    tools: string[];
    error?: string;
};
export type McpSignInResult =
    | { status: "open"; url: string; callback: string }
    | { status: "done" | "failed"; message: string };
type Output = { code: number; stdout: string; stderr: string };
/** A sign-in waiting for the member's browser. `output` is set once `rotom mcp login` has exited. */
type Pending = { redirect: URL; child: ChildProcess; done: Promise<Output>; output?: Output };

function finished(child: ChildProcess): Promise<Output> {
    let stdout = "",
        stderr = "";

    child.stdout!.on("data", (chunk) => (stdout += chunk));
    child.stderr!.on("data", (chunk) => (stderr += chunk));

    return new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
}

function result(output: Output): McpSignInResult {
    return output.code === 0
        ? { status: "done", message: output.stdout.trim().split("\n").at(-1) ?? "" }
        : { status: "failed", message: output.stderr.trim() || `rotom mcp exited ${output.code}` };
}

function serverName(value: unknown): string {
    if (typeof value !== "string" || !/^[\w.-]{1,64}$/.test(value)) {
        throw new HttpError(400, "An MCP server name is required.");
    }

    return value;
}

export class McpSignIns {
    readonly #teamAgentDir: string;

    constructor(teamAgentDir: string) {
        this.#teamAgentDir = teamAgentDir;
    }

    /** One sign-in per member and project folder at a time. */
    readonly #pending = new Map<string, Pending>();

    async list(
        home: string,
        workspace: string,
    ): Promise<{ servers: McpServerReport[]; errors: string[] }> {
        const output = await finished(
            await startRotomMcp({
                home,
                workspace,
                teamAgentDir: this.#teamAgentDir,
                args: ["list", "--json"],
            }),
        );

        // `list` exits 1 when a server is not connected; its report says which.
        if (output.code !== 0 && output.code !== 1) {
            throw new Error(`rotom mcp list failed: ${output.stderr.trim() || output.code}`);
        }

        const report = JSON.parse(output.stdout) as {
            servers: (McpServerReport & Record<string, unknown>)[];
            errors: string[];
        };

        return {
            servers: report.servers.map(({ name, transport, state, tools, error }) => ({
                name,
                transport,
                state,
                tools,
                ...(error ? { error } : {}),
            })),
            errors: report.errors,
        };
    }

    /** Start a sign-in. It is open until the member finishes it, starts another, or it times out. */
    async start(
        key: string,
        home: string,
        workspace: string,
        server: unknown,
    ): Promise<McpSignInResult> {
        const name = serverName(server);

        this.cancel(key);
        const child = await startRotomMcp({
            teamAgentDir: this.#teamAgentDir,
            home,
            workspace,
            args: ["login", name, "--timeout", String(SIGN_IN_SECONDS)],
        });
        const done = finished(child);
        const authorization = await new Promise<URL | undefined>((resolve) => {
            let text = "";

            child.stdout!.on("data", (chunk) => {
                text += chunk;
                const match = /in your browser:\n(\S+)\n/.exec(text);

                if (match) {
                    resolve(new URL(match[1]!));
                }
            });
            void done.then(
                () => resolve(undefined),
                () => resolve(undefined),
            );
        });

        if (!authorization) {
            return result(await done);
        }

        const redirect = authorization.searchParams.get("redirect_uri");

        // The address comes from the configured server: only a web page is a link to show, and only a loopback
        // callback is somewhere to deliver the answer.
        if (
            !["https:", "http:"].includes(authorization.protocol) ||
            !redirect ||
            new URL(redirect).hostname !== "127.0.0.1"
        ) {
            child.kill();

            return {
                status: "failed",
                message: "The server's sign-in address is not usable here.",
            };
        }

        const pending: Pending = { redirect: new URL(redirect), child, done };

        void done.then((output) => (pending.output = output)).catch(() => undefined);
        this.#pending.set(key, pending);

        return {
            status: "open",
            url: authorization.href,
            callback: `${pending.redirect.origin}${pending.redirect.pathname}`,
        };
    }

    /**
     * Finish the open sign-in with the address the member's browser ended on. Without one it only waits: a browser on
     * this machine reaches the callback by itself.
     */
    async finish(key: string, pasted: unknown): Promise<McpSignInResult> {
        const pending = this.#pending.get(key);

        if (!pending) {
            throw new HttpError(409, "No sign-in is waiting. Start it again.");
        }

        if (typeof pasted === "string" && pasted.trim() && !pending.output) {
            const url = URL.canParse(pasted.trim()) ? new URL(pasted.trim()) : undefined;

            if (
                url?.origin !== pending.redirect.origin ||
                url.pathname !== pending.redirect.pathname
            ) {
                throw new HttpError(
                    400,
                    `Paste the address your browser ended on: it starts with ${pending.redirect.origin}${pending.redirect.pathname}.`,
                );
            }

            // What a browser on this machine would have done. The callback answers with a page for that browser.
            const response = await fetch(url, {
                redirect: "manual",
                signal: AbortSignal.timeout(FINISH_MS),
            });

            await response.body?.cancel();
        }

        const output = await Promise.race([
            pending.done,
            new Promise<undefined>((resolve) => setTimeout(resolve, FINISH_MS)),
        ]);

        if (!output) {
            throw new HttpError(
                409,
                "The sign-in has not finished. Sign in in your browser, then paste the address it ended on.",
            );
        }

        this.#pending.delete(key);

        return result(output);
    }

    async logout(home: string, workspace: string, server: unknown): Promise<McpSignInResult> {
        return result(
            await finished(
                await startRotomMcp({
                    home,
                    workspace,
                    teamAgentDir: this.#teamAgentDir,
                    args: ["logout", serverName(server)],
                }),
            ),
        );
    }

    cancel(key: string): void {
        this.#pending.get(key)?.child.kill();
        this.#pending.delete(key);
    }

    close(): void {
        for (const key of [...this.#pending.keys()]) {
            this.cancel(key);
        }
    }
}
