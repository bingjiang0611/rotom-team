/** A minimal stdio MCP server for kernel proofs: one `echo` tool that also reports the env value it was given. */
import { createInterface } from "node:readline";

const send = (message) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

for await (const line of createInterface({ input: process.stdin })) {
    const { id, method, params } = JSON.parse(line);

    if (id === undefined) {
        continue;
    }

    if (method === "initialize") {
        send({
            id,
            result: {
                protocolVersion: params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "mcp-echo", version: "1.0.0" },
            },
        });
    } else if (method === "tools/list") {
        send({
            id,
            result: {
                tools: [
                    {
                        name: "echo",
                        description: "Echo the text back.",
                        inputSchema: {
                            type: "object",
                            properties: { text: { type: "string" } },
                            required: ["text"],
                        },
                    },
                ],
            },
        });
    } else if (method === "tools/call") {
        const text = `MCP_ECHO:${params.arguments.text}:leak=${process.env.MCP_PROBE_LEAK ?? ""}`;

        send({ id, result: { content: [{ type: "text", text }] } });
    } else if (method === "ping") {
        send({ id, result: {} });
    } else {
        send({ id, error: { code: -32601, message: `Unknown method ${method}` } });
    }
}
