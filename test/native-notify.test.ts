import { cleanUp, fakeTab, noInferenceModels, owner, root, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PocketApp } from "../src/server/app.ts";

test.after(cleanUp);

test(
    "real native notify preserves ordinary notices in the Team tab, not private controls",
    { timeout: 30_000 },
    async () => {
        const data = join(realpathSync(root), "notify-data");
        const extensions = join(data, "team-agent", "extensions");
        const messages = [
            "ordinary notice",
            '{"kind":"custom","message":"ordinary JSON"}',
            '{"ordinary incomplete JSON":',
            'literal text mentions {"kind":"team-kernel-context-v1"}',
        ];

        mkdirSync(extensions, { recursive: true, mode: 0o700 });
        writeFileSync(
            join(extensions, "notify-fixture.js"),
            `export default function(pi) {
        pi.registerCommand("test-notices", {
            description: "Synthetic notices without inference",
            handler: async (_args, ctx) => {
                for (const message of ${JSON.stringify(messages)}) ctx.ui.notify(message, "warning");
            }
        });
    }`,
        );
        const app = await PocketApp.open({
            dataDir: data,
            defaultCwd: realpathSync(work),
            kernel: true,
            supervised: false,
            browser: null,
            log: () => {},
            configureUserModels: noInferenceModels,
        });

        try {
            const user = owner(app);
            const session = await app.commands.createSession(user, { backend: "rotom" });
            const tab = fakeTab(session.id, user);

            await app.attach(tab.client);
            const result = await app.kernel!.submit(session.id, user, "notices", "/test-notices");

            assert.equal(result.status, "handled");
            const notices = tab.events
                .filter((event) => event.event === "notice")
                .map((event) => event.data);

            for (const message of messages) {
                assert.ok(
                    notices.some(
                        (notice) => notice.message === message && notice.level === "warning",
                    ),
                    message,
                );
            }

            assert.ok(
                !notices.some((notice) =>
                    String(notice.message).startsWith('{"kind":"team-kernel-'),
                ),
            );
            app.detach(tab.client);
        } finally {
            await app.close();
        }
    },
);
