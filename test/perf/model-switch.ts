/** Real configure HTTP requests and pinned native model readback; synthetic accounts, no inference. */
import { openNativeApp, scriptedModel, owner, root } from "../helpers.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { createHandler } from "../../src/server/http.ts";
import type { ConversationId } from "@earendil-works/pi-durable";

type Scenario = (name: string, action: () => Promise<void>) => Promise<void>;

export async function measureModelSwitch(scenario: Scenario): Promise<void> {
    const app = await openNativeApp(scriptedModel(), join(realpathSync(root), "model-switch"));
    const user = owner(app);
    const token = app.config.addDevice(user.id).token;
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/`;

    const call = async (path: string, body: object) => {
        const response = await fetch(base + path, {
            method: "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "x-pocket": "1",
                "content-type": "application/json",
            },
            body: JSON.stringify(body),
        });
        const text = await response.text();

        assert.equal(response.status, 200, text);

        return JSON.parse(text);
    };

    try {
        await app.hello(user);
        const { id } = (await call("sessions", {
            title: "Model switch benchmark",
            backend: "rotom",
        })) as { id: ConversationId };
        const journal = app.kernel!.executions.journal;
        const original = await journal.session(String(id));

        const switchTo = async (modelId: string) => {
            const { receipt } = await call(`c/${id}/configure`, {
                model: { provider: "openai", modelId },
            });

            assert.equal(receipt.status, "handled");
            const session = await journal.session(String(id));

            assert.equal(session.segmentId, original.segmentId);
            assert.equal(session.binding.memberId, user.id);
            assert.equal(session.binding.model, modelId);
            const info = await app.kernel!.roomInfo(id);

            assert.equal(info.agent.model?.modelId, modelId);
        };

        await scenario("model.switch.cold", () => switchTo("faux-2"));
        const cold = await journal.session(String(id));

        await scenario("model.switch.warm", () => switchTo("faux-1"));
        const warm = await journal.session(String(id));

        assert.equal(warm.kernelSessionId, cold.kernelSessionId);
        assert.equal(warm.sessionFile, cold.sessionFile);
    } finally {
        await app.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}
