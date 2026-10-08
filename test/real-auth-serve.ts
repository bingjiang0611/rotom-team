/** Opt-in localhost-only independent OAuth verification. Never imports original provider credentials. */
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
const parent = join(homedir(), "Library", "Application Support", "rotom-team-validation");

mkdirSync(parent, { recursive: true, mode: 0o700 });
const resume = process.argv[2];
const data = resume ? realpathSync(resume) : mkdtempSync(join(parent, "independent-auth-"));

if (resume && !existsSync(join(data, "config.json"))) {
    throw new Error("An existing independent fixture is required.");
}

const workspace = join(data, "workspace");

mkdirSync(workspace, { recursive: true, mode: 0o700 });
process.umask(0o077);
process.env.PI_CODING_AGENT_DIR = join(data, "agent");
process.env.PI_POCKET_GUARD = "off";
const { PocketApp } = await import("../src/server/app.ts");
const { createHandler } = await import("../src/server/http.ts");
const app = await PocketApp.open({
    dataDir: data,
    defaultCwd: workspace,
    supervised: false,
    browser: null,
    log: () => {},
});
const owner = app.config.users.find((user) => user.role === "owner")!;

app.config.updateUser(owner.id, { name: "Alice · independent ChatGPT" });
const existing = app.config.users.find((user) => user.name === "Bob · independent Qoder");
const bob = existing
    ? { user: existing, token: app.config.addDevice(existing.id).token }
    : app.config.addUser("Bob · independent Qoder", "guest");
const handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });
const unused = new Set(["/validation-alice", "/validation-bob"]);
const server = createServer((request, response) => {
    // Single-use test bootstrap on loopback, not a product route. Login secrets never enter stdout or screenshots.
    if (request.method === "GET" && unused.delete(request.url ?? "")) {
        const token = request.url === "/validation-alice" ? app.config.ownerToken : bob.token;

        response.writeHead(302, {
            location: `/login?token=${encodeURIComponent(token)}`,
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
        bootstrap: ["/validation-alice", "/validation-bob"],
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
