/** Disposable, offline two-person demo. No provider credentials, provider requests, or inference charges. */
import { cleanUp, context, root, work, owner, scriptedModel } from "./helpers.ts";
import { createServer } from "node:http";
import { join } from "node:path";
import { PocketApp } from "../src/server/app.ts";
import { createHandler } from "../src/server/http.ts";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";

const app = await PocketApp.open({
    dataDir: join(root, "team-demo"),
    defaultCwd: work,
    supervised: false,
    browser: null,
    configureUserModels(models, user) {
        const fake = scriptedModel(() =>
            fauxAssistantMessage([
                fauxText(
                    `Demo response for ${user.name}. This is a scripted offline model; no subscription quota was used.`,
                ),
            ]),
        );

        models.registerNativeProvider(fake.provider);
    },
});
const guest = app.config.addUser("Teammate", "guest");

await app.hello(guest.user);
const created = await app.commands.createSession(owner(app), {
    title: "Shared task · offline demo",
});
const submitted = await app.commands.submit(created.id, owner(app), {
    text: "Start our shared task",
    requestId: "demo-seed",
});

await (await app.harness.submission(submitted.submissionId, context))!.wait(context);
const host = "127.0.0.1";
const port = Number(process.argv[2] ?? 8790);
const server = createServer(createHandler({ app, listen: { host, port }, restart: () => {} }));

await new Promise<void>((resolve) => server.listen(port, host, resolve));
console.log(`rotom-team offline demo (temporary data, no real accounts). PID ${process.pid}`);
console.log(`owner: http://${host}:${port}/login?token=${app.config.ownerToken}`);
console.log(`member: http://${host}:${port}/login?token=${guest.token}`);

const stop = async () => {
    server.closeAllConnections();
    server.close();
    await app.close();
    cleanUp();
    process.exit(0);
};

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
