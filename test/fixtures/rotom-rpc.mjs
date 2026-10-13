/** A wire fixture, not a rotom substitute. Real-product proof is a separate opt-in test. */
import { createInterface } from "node:readline";
const mode = process.argv[2];
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");

const input = createInterface({ input: process.stdin });
let cancelCompact;
let promptImages = [];
let compactCount = 0;
let promptMessages = [];
let followupDone = Promise.resolve();

// Keep process startup outside the protocol deadlines measured by the tests.
emit({ type: "fixture_ready" });

for await (const line of input) {
    const command = JSON.parse(line);

    if (command.type === "extension_ui_response") {
        continue;
    }

    const response = (data = {}, success = true) =>
        emit({ type: "response", id: command.id, command: command.type, success, data });

    if (command.type === "abort" && cancelCompact) {
        cancelCompact();
        cancelCompact = undefined;
        response();
        continue;
    }

    if (command.type === "compact") {
        compactCount++;
        cancelCompact = () => response({}, false);

        if (mode === "compact-hang") {
            continue;
        }

        if (mode === "compact-reject") {
            response({}, false);
        } else if (mode === "compact-corrupt") {
            process.stdout.write(
                JSON.stringify({
                    type: "response",
                    id: command.id,
                    command: "compact",
                    success: true,
                    data: {},
                }) + "\nbad-json\n",
            );
        } else {
            setTimeout(() => {
                cancelCompact = undefined;
                response({ summary: "fixture compacted" });
            }, 1200);
        }

        continue;
    }

    if (command.type !== "prompt") {
        response({
            cleanEnvironment: !process.env.OPENAI_API_KEY,
            cwd: process.cwd(),
            ...(mode === "compact-record" ? { compactCount, promptMessages } : {}),
            ...(mode.startsWith("images") ? { promptImages } : {}),
        });
        continue;
    }

    promptImages = command.images ?? [];
    promptMessages.push(command.message);

    if (mode === "handled-followup" && command.message === "/goal run") {
        let finish;

        followupDone = new Promise((resolve) => {
            finish = resolve;
        });
        response({ disposition: "handled" });
        setTimeout(() => {
            emit({ type: "agent_start" });
            emit({ type: "agent_settled" });
            finish();
        }, 20);
        continue;
    }

    if (mode === "handled-followup" && command.message.startsWith("/team-kernel-barrier")) {
        await followupDone;
        const nonce = command.message.slice("/team-kernel-barrier ".length);

        emit({
            type: "extension_ui_request",
            method: "notify",
            message: JSON.stringify({ kind: "team-kernel-barrier-v1", nonce, ok: true }),
        });
        response({ disposition: "handled" });
        continue;
    }

    if (mode === "exit") {
        process.exit(0);
    }

    if (mode === "settled-corrupt") {
        process.stdout.write(
            JSON.stringify({
                type: "response",
                id: command.id,
                command: "prompt",
                success: true,
                data: { disposition: "started" },
            }) + '\n{"type":"agent_settled"}\nbad-json\n',
        );
        continue;
    }

    if (mode === "malformed") {
        process.stdout.write("bad-json\n");
        continue;
    }

    if (mode === "wrong-id") {
        emit({ type: "response", id: "foreign", command: "prompt", success: true });
        continue;
    }

    if (mode === "reject") {
        response({}, false);
        continue;
    }

    if (mode === "handled") {
        response({ disposition: "handled" });
        continue;
    }

    if (mode === "oversized") {
        process.stdout.write("x".repeat(8 * 1024 * 1024 + 1));
        continue;
    }

    if (mode === "hang") {
        response({ disposition: "started" });
        continue;
    }

    if (mode === "unicode") {
        const bytes = Buffer.from(
            JSON.stringify({ type: "message_update", text: "中\u2028间\u2029🙂" }) + "\r\n",
        );

        for (const byte of bytes) {
            process.stdout.write(Buffer.from([byte]));
        }
    }

    emit({ type: "agent_end" });

    if (mode === "fast") {
        emit({ type: "agent_settled" });
        response({ disposition: "started" });
    } else {
        response({ disposition: "started" });
        setTimeout(() => emit({ type: "agent_settled" }), 40);
    }
}
