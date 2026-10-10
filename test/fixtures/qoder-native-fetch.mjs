/** Test-only transport interception, installed solely in the disposable native HOME. */
import { existsSync, readFileSync } from "node:fs";

export default function (pi) {
    const gate = JSON.parse(readFileSync(process.env.ROTOM_TEAM_KERNEL_GATE, "utf8"));
    const original = globalThis.fetch;

    globalThis.fetch = async (url, options) => {
        if (String(url) === gate.url) {
            return original(url, options);
        }

        if (String(url) !== "https://api2-v2.qoder.sh/model/v1/chat/completions") {
            throw new Error("Fixture refused unexpected network");
        }

        if (
            !new Headers(options.headers)
                .get("authorization")
                ?.startsWith("Bearer synthetic-native-")
        ) {
            throw new Error("Fixture refused non-synthetic auth");
        }

        const body = JSON.parse(options.body);
        const compact = !body.tools?.length;
        const summarySeen = JSON.stringify(body.messages).includes("NATIVE_QODER_SUMMARY");
        const done =
            compact || summarySeen || body.messages.some((message) => message.role === "tool");

        if (compact && existsSync(".fixture-compact-error")) {
            return new Response("fixture unavailable", { status: 503 });
        }

        const delta = compact
            ? { role: "assistant", content: "NATIVE_QODER_SUMMARY: wrote qoder-proof.txt" }
            : done
              ? { role: "assistant", content: "NATIVE_QODER_FINISHED" }
              : {
                    role: "assistant",
                    tool_calls: [
                        {
                            index: 0,
                            id: "fixture_write",
                            type: "function",
                            function: {
                                name: "write",
                                arguments: JSON.stringify({
                                    path: "qoder-proof.txt",
                                    content: "QODER_NATIVE_OK\n",
                                }),
                            },
                        },
                    ],
                };

        pi.appendEntry("fixture-qoder-network", { model: body.model, compact, summarySeen });
        const frames = [
            { id: "fixture", choices: [{ index: 0, delta, finish_reason: null }] },
            {
                id: "fixture",
                choices: [{ index: 0, delta: {}, finish_reason: done ? "stop" : "tool_calls" }],
                usage: {
                    prompt_tokens: 2,
                    completion_tokens: 3,
                    total_tokens: 5,
                    credits: 0.125,
                    billable: true,
                },
            },
        ];

        return new Response(
            frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") +
                "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
        );
    };
}
