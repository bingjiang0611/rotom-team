/** Exercise the composer's real send callbacks with a deterministic HTTP/state boundary. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const composer = readFileSync(new URL("../web/composer.js", import.meta.url), "utf8");
const callbacks = composer.slice(
    composer.indexOf("    const runCommand = async"),
    composer.indexOf("    /** Put a message sent before"),
);
const native = readFileSync(new URL("../web/sheets/native-command.js", import.meta.url), "utf8");
const accepted = native
    .slice(
        native.indexOf("export function nativeCommandAccepted"),
        native.indexOf("export function showNativeResult"),
    )
    .replace("export ", "");

function fixture(source: string | null, result: object | Error = { status: "running" }) {
    const command = { command: { name: "fixture", source }, arg: "inspect these images" };
    const text = source === null ? "inspect these images" : "/fixture inspect these images";
    const files = Array.from({ length: 4 }, (_, index) => ({
        state: "done",
        preview: `blob:fixture-${index}`,
        attachment: { path: `/uploads/${index}.png`, mimeType: "image/png" },
    }));
    const state = {
        text,
        files,
        pastes: { "1": "saved paste" } as Record<string, string>,
        revoked: [] as string[],
        submissions: [] as unknown[][],
        remembered: [] as string[],
    };
    const { send } = runInNewContext(`${accepted}\n${callbacks}\n({send});`, {
        text,
        files,
        sending: false,
        parsed: source === null ? null : command,
        parseCommand: () => command,
        expandPastes: (value: string) => value,
        pastes: state.pastes,
        REMEMBER_CHARS: 20_000,
        conversationId: 1,
        drafts: { get: () => state.text },
        store: { state: { view: { kernel: true } } },
        actions: {
            submit: async (...args: unknown[]) => {
                state.submissions.push(args);

                if (result instanceof Error) {
                    throw result;
                }

                return result;
            },
        },
        attempt: async (fn: () => Promise<unknown>) => {
            try {
                return await fn();
            } catch {
                return undefined;
            }
        },
        update: (value: string) => {
            state.text = value;
        },
        setSending: () => {},
        setFiles: (value: typeof files) => {
            state.files = value;
        },
        setPastes: (value: Record<string, string>) => {
            state.pastes = value;
        },
        savePastes: () => {},
        setBrowsing: () => {},
        remember: (value: string) => state.remembered.push(value),
        showNativeResult: () => {},
        URL: { revokeObjectURL: (value: string) => state.revoked.push(value) },
        shell: false,
        busy: false,
        steer: true,
        inlineFiles: false,
        mentionsFiles: false,
        coarse: true,
    });

    return { send, state, files, text };
}

for (const source of ["skill", "prompt", null]) {
    test(`${source ?? "ordinary message"} sends all images and clears the accepted draft`, async () => {
        const { send, state, files, text } = fixture(source);

        await send();
        assert.equal(state.submissions.length, 1);
        assert.equal(state.submissions[0]![0], text);
        const attachments = state.submissions[0]![1] as unknown[];

        assert.equal(attachments.length, 4);

        for (const [index, file] of files.entries()) {
            assert.equal(attachments[index], file.attachment);
        }

        assert.equal(state.text, "");
        assert.equal(state.files.length, 0);
        assert.equal(Object.keys(state.pastes).length, 0);
        assert.deepEqual(
            state.revoked,
            files.map((file) => file.preview),
        );
        assert.deepEqual(state.remembered, [text]);
    });
}

for (const source of ["skill", "prompt"]) {
    for (const [outcome, result] of Object.entries({
        rejected: { status: "rejected" },
        unknown: { status: "unknown" },
        interrupted: { status: "interrupted" },
        cancelled: { status: "handled", nativeResult: { navigation: { cancelled: true } } },
        failed: new Error("network failure"),
    })) {
        test(`${source} preserves the draft and images when ${outcome}`, async () => {
            const { send, state, files, text } = fixture(source, result);

            await send();
            assert.equal(state.submissions.length, 1, "never automatically replay a submission");
            assert.equal((state.submissions[0]![1] as unknown[]).length, 4);
            assert.equal(state.text, text);
            assert.equal(state.files, files);
            assert.equal(state.revoked.length, 0);
            assert.equal(state.pastes["1"], "saved paste");
        });
    }
}

test("non-prompt native commands do not consume the attached images", async () => {
    const { send, state, files } = fixture("extension", { status: "handled" });

    await send();
    assert.equal(state.submissions.length, 1);
    assert.equal((state.submissions[0]![1] as unknown[]).length, 0);
    assert.equal(state.files, files);
    assert.equal(state.revoked.length, 0);
});
