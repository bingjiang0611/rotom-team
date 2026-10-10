/** Opt-in localhost-only independent OAuth verification. Never imports original provider credentials. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
const parent = join(homedir(), "Library", "Application Support", "rotom-team-validation");

mkdirSync(parent, { recursive: true, mode: 0o700 });
const resume = process.argv[2];
const nativeReadOnly = process.argv.includes("--kernel-readonly");

if (nativeReadOnly && !resume) {
    throw new Error("Native read-only inspection requires an existing independent fixture.");
}

const data = resume ? realpathSync(resume) : mkdtempSync(join(parent, "independent-auth-"));

if (resume && !existsSync(join(data, "config.json"))) {
    throw new Error("An existing independent fixture is required.");
}

const workspace = join(data, "workspace");

mkdirSync(workspace, { recursive: true, mode: 0o700 });
process.umask(0o077);
process.env.PI_CODING_AGENT_DIR = join(data, "agent");
process.env.PI_POCKET_GUARD = "off";
let nativeId: number | undefined;

if (nativeReadOnly) {
    const report = JSON.parse(
        readFileSync(join(data, "native-acceptance/alice-write-proxy.json"), "utf8"),
    );

    assert.equal(report.status, "passed");
    assert.ok(Number.isSafeInteger(report.conversationId) && report.conversationId > 0);
    nativeId = report.conversationId;
    const { requireNoPendingKernel } = await import("../src/server/rotom-journal.ts");

    requireNoPendingKernel(data);
    const db = new DatabaseSync(join(data, "pocket.sqlite"), { readOnly: true });

    try {
        assert.equal(
            db
                .prepare(
                    "SELECT count(*) n FROM tasks WHERE json_extract(record,'$.state.status') IS NOT 'terminal'",
                )
                .get()!.n,
            0,
            "Reconcile prior work before read-only inspection",
        );
    } finally {
        db.close();
    }
}

const { PocketApp } = await import("../src/server/app.ts");
const { createHandler } = await import("../src/server/http.ts");
const { COOKIE, clearAuthCookie } = await import("../src/server/auth.ts");
const app = await PocketApp.open({
    dataDir: data,
    defaultCwd: workspace,
    supervised: false,
    browser: null,
    kernel: nativeReadOnly,
    log: () => {},
});
const owner = app.config.users.find((user) => user.role === "owner")!;

let bob: { token: string } | undefined;

if (!nativeReadOnly) {
    app.config.updateUser(owner.id, { name: "Alice · independent ChatGPT" });
    const existing = app.config.users.find((user) => user.name === "Bob · independent Qoder");

    bob = existing
        ? { token: app.config.addDevice(existing.id).token }
        : app.config.addUser("Bob · independent Qoder", "guest");
}

const handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });
const bootstrap = nativeReadOnly
    ? ["/validation-readonly"]
    : ["/validation-alice", "/validation-bob"];
const unused = new Set(bootstrap);
const server = createServer((request, response) => {
    if (nativeReadOnly && request.method !== "GET") {
        response.writeHead(403, { "content-type": "application/json" });
        response.end(
            JSON.stringify({ error: "Read-only validation server; execution/mutations disabled." }),
        );

        return;
    }

    if (nativeReadOnly && request.url === "/validation-logout") {
        clearAuthCookie(response);
        response.writeHead(302, { location: "/", "cache-control": "no-store" });
        response.end();

        return;
    }

    // Single-use test bootstrap on loopback, not a product route. Login secrets never enter stdout or screenshots.
    if (request.method === "GET" && unused.delete(request.url ?? "")) {
        const token = request.url === "/validation-bob" ? bob!.token : app.config.ownerToken;

        if (nativeReadOnly) {
            response.setHeader(
                "set-cookie",
                `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=600`,
            );
        }

        response.writeHead(302, {
            location: nativeReadOnly
                ? `/s/${nativeId}`
                : `/login?token=${encodeURIComponent(token)}`,
            "cache-control": "no-store",
        });
        response.end();

        return;
    }

    void handler(request, response);
});

await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
console.log(
    JSON.stringify({
        port: (server.address() as { port: number }).port,
        data,
        authentication: "fresh-independent-grants-only",
        bootstrap,
        nativeReadOnly,
    }),
);
let closing = false;

const close = async () => {
    if (closing) {
        return;
    }

    closing = true;
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await app.close();
    process.exit(0);
};

process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
