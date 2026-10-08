import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { ConfigStore } from "../src/server/config.ts";
import { createHandler } from "../src/server/http.ts";
import { cleanUp, openApp, root, scriptedModel } from "./helpers.ts";
after(cleanUp);

test("browser devices retain the member identity through restart, revocation and owner rotation", () => {
    const folder = join(root, "device-config");
    const config = new ConfigStore(folder);
    const member = config.addUser("Member", "viewer");
    const device = config.addDevice(member.user.id);

    assert.equal(config.userByToken(device.token)?.id, member.user.id);
    assert.equal(config.userByToken(device.token)?.role, "viewer");
    assert.equal(readFileSync(config.file, "utf8").includes(device.token), false);
    const reopened = new ConfigStore(folder);

    assert.equal(reopened.userByToken(device.token)?.id, member.user.id);
    reopened.revokeDevice(member.user.id, device.id);
    assert.equal(reopened.userByToken(device.token), undefined);
    assert.equal(reopened.userByToken(member.token)?.id, member.user.id);
    const removed = reopened.addDevice(member.user.id);

    reopened.removeUser(member.user.id);
    assert.equal(reopened.userByToken(removed.token), undefined);
    const owner = reopened.users.find((user) => user.role === "owner")!;
    const ownerDevice = reopened.addDevice(owner.id);

    reopened.rotateOwnerToken();
    assert.equal(reopened.userByToken(ownerDevice.token), undefined);
});

test("device API only issues current-member credentials and cannot revoke another member's device", async () => {
    const app = await openApp(scriptedModel());
    const a = app.config.addUser("A", "viewer"),
        b = app.config.addUser("B", "guest");
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const request = (token: string, path: string, method = "GET", body?: object) =>
        fetch(`${base}/api/${path}`, {
            method,
            headers: {
                authorization: `Bearer ${token}`,
                "x-pocket": "1",
                "content-type": "application/json",
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });

    try {
        const response = await request(a.token, "devices", "POST", { userId: b.user.id });

        assert.equal(response.status, 200);
        const device = (await response.json()) as { token: string; id: string };

        assert.equal(app.config.userByToken(device.token)?.id, a.user.id);
        assert.equal((await request(device.token, "profile")).status, 200);
        const foreign = app.config.addDevice(b.user.id);

        assert.equal((await request(a.token, `devices/${foreign.id}`, "DELETE")).status, 200);
        assert.equal(app.config.userByToken(foreign.token)?.id, b.user.id);
        assert.equal((await request(a.token, `devices/${device.id}`, "DELETE")).status, 200);
        assert.equal((await request(device.token, "profile")).status, 401);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
        await app.close();
    }
});
