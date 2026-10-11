/**
 * A loopback MCP server behind OAuth, for sign-in proofs: discovery, dynamic client registration, PKCE and a token per
 * approval. Its one tool is named after the member whose "browser" approved the token the request carries.
 */
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";

async function body(request: IncomingMessage): Promise<string> {
    let text = "";

    for await (const chunk of request) {
        text += chunk;
    }

    return text;
}

export async function startOAuthMcp() {
    /** Access token → member whose browser approved it. */
    const tokens = new Map<string, string>();
    const codes = new Map<string, { member: string; challenge: string; redirect: string }>();
    const state = {
        origin: "",
        /** The member whose browser approves the next authorization. */
        approving: "",
        /** Which member's token each MCP request carried. */
        callers: [] as string[],
        close: () => {
            server.closeAllConnections();
            server.close();
        },
    };
    const server = createServer(async (request, response) => {
        const url = new URL(request.url!, state.origin);
        const json = (status: number, value: unknown, headers: Record<string, string> = {}) =>
            response
                .writeHead(status, { "Content-Type": "application/json", ...headers })
                .end(JSON.stringify(value));

        if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
            return json(200, {
                resource: `${state.origin}/mcp`,
                authorization_servers: [state.origin],
            });
        }

        if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
            return json(200, {
                issuer: state.origin,
                authorization_endpoint: `${state.origin}/authorize`,
                token_endpoint: `${state.origin}/token`,
                registration_endpoint: `${state.origin}/register`,
                response_types_supported: ["code"],
                grant_types_supported: ["authorization_code", "refresh_token"],
                code_challenge_methods_supported: ["S256"],
                token_endpoint_auth_methods_supported: ["none"],
            });
        }

        if (url.pathname === "/register") {
            return json(201, { ...JSON.parse(await body(request)), client_id: randomUUID() });
        }

        if (url.pathname === "/authorize") {
            const code = randomUUID();
            const redirect = url.searchParams.get("redirect_uri")!;

            codes.set(code, {
                member: state.approving,
                challenge: url.searchParams.get("code_challenge")!,
                redirect,
            });
            const back = new URL(redirect);

            back.searchParams.set("code", code);
            back.searchParams.set("state", url.searchParams.get("state")!);

            return response.writeHead(302, { Location: back.href }).end();
        }

        if (url.pathname === "/token") {
            const form = new URLSearchParams(await body(request));
            const grant = codes.get(form.get("code") ?? "");
            const verifier = createHash("sha256")
                .update(form.get("code_verifier") ?? "")
                .digest("base64url");

            if (
                !grant ||
                grant.challenge !== verifier ||
                grant.redirect !== form.get("redirect_uri")
            ) {
                return json(400, { error: "invalid_grant" });
            }

            codes.delete(form.get("code")!);
            const token = randomUUID();

            tokens.set(token, grant.member);

            return json(200, { access_token: token, token_type: "Bearer", expires_in: 3600 });
        }

        if (url.pathname === "/mcp") {
            const member = tokens.get(request.headers.authorization?.replace(/^Bearer /, "") ?? "");

            if (!member) {
                return json(
                    401,
                    { error: "unauthorized" },
                    {
                        "WWW-Authenticate": `Bearer resource_metadata="${state.origin}/.well-known/oauth-protected-resource/mcp"`,
                    },
                );
            }

            if (request.method !== "POST") {
                return response.writeHead(405).end();
            }

            state.callers.push(member);
            const message = JSON.parse(await body(request));

            if (message.id === undefined) {
                return response.writeHead(202).end();
            }

            const results: Record<string, unknown> = {
                initialize: {
                    protocolVersion: message.params?.protocolVersion,
                    capabilities: { tools: {} },
                    serverInfo: { name: "oauth-fixture", version: "1" },
                },
                "tools/list": {
                    tools: [
                        {
                            name: `whoami_${member}`,
                            description: "Who signed in",
                            inputSchema: { type: "object", properties: {} },
                        },
                    ],
                },
            };

            return json(200, {
                jsonrpc: "2.0",
                id: message.id,
                result: results[message.method] ?? {},
            });
        }

        response.writeHead(404).end();
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    state.origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    return state;
}
