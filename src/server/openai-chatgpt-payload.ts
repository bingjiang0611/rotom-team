/** Pure SIWC tool-namespace conversion shared by the old adapter and the pinned native kernel. */
export function chatGPTPayload(value: unknown): unknown {
    const payload = value as {
        tools?: { type: string; name?: string; description?: string; tools?: unknown[] }[];
    };

    if (!payload.tools?.length) {
        return value;
    }

    const flat = payload.tools.filter((tool) => tool.type === "function" || tool.type === "custom");
    const groups = payload.tools.filter((tool) => tool.type === "namespace");

    if (flat.length + groups.length !== payload.tools.length) {
        throw new Error("This ChatGPT plan route does not support hosted tools or tool_search.");
    }

    if (!flat.length) {
        return value;
    }

    const functions = groups.find((group) => group.name === "functions");

    return {
        ...payload,
        tools: [
            ...groups.filter((group) => group !== functions),
            {
                ...functions,
                type: "namespace",
                name: "functions",
                description:
                    functions?.description ?? "Local tools executed by the self-hosted app.",
                tools: [...(functions?.tools ?? []), ...flat],
            },
        ],
    };
}
