// Recovery uses isolated members and no real model accounts.
import { type App, cleanUp, openApp, owner, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname } from "node:path";
import { after, before, test } from "node:test";
import { Auth } from "../src/server/auth.ts";
import { ConfigStore, MAX_DEVICES } from "../src/server/config.ts";
import { createHandler } from "../src/server/http.ts";

let app: App;
let server: Server;
let base: string;
let auth: Auth;

before(async () => {
    app = await openApp(scriptedModel());
    auth = new Auth(app.config);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

const post = (path: string, token: string, body: unknown) =>
    fetch(`${base}/api/${path}`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${token}`,
            "x-pocket": "1",
            "content-type": "application/json",
        },
        body: JSON.stringify(body),
    });
const recover = (memberId: string) => auth.createInvite(owner(app), { role: "recovery", memberId });
const redeem = (code: string, headers = {}) =>
    fetch(`${base}/join/${code}`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: "name=MustNotRename",
    });

test("only the owner can issue recovery, and cannot change access or recover the owner", async () => {
    const member = app.config.addUser("Member", "guest");
    const viewer = app.config.addUser("Viewer", "viewer");
    const scoped = app.config.addUser("Scoped", "guest", ["42"]);

    for (const token of ["", member.token, viewer.token, scoped.token]) {
        const response = await post("invite", token, { memberId: member.user.id });

        assert.equal(response.status, token === "" ? 401 : 403);
    }

    for (const [body, status] of [
        [{ memberId: 123 }, 400],
        [{ memberId: "" }, 400],
        [{ memberId: "missing" }, 404],
        [{ memberId: owner(app).id }, 400],
        [{ memberId: member.user.id, role: "owner" }, 400],
        [{ memberId: member.user.id, session: 42 }, 400],
    ] as const) {
        assert.equal((await post("invite", app.config.ownerToken, body)).status, status);
    }

    assert.throws(
        () => auth.createInvite(member.user, { role: "recovery", memberId: viewer.user.id }),
        /Only the owner/,
    );
});

test("recovery confirms identity, preserves the original member, and signs in with a revocable device", async () => {
    const { user, token } = app.config.addUser("Alex <existing>", "guest", ["42"]);
    const count = app.config.users.length;
    const created = await post("invite", app.config.ownerToken, {
        memberId: user.id,
        minutes: 10080,
    });

    assert.equal(created.status, 200);
    const link = (await created.json()) as {
        code: string;
        url: string;
        minutes: number;
        grant: unknown;
    };

    assert.equal(link.minutes, 15);
    assert.equal(link.url, `${base}/join/${link.code}`);
    assert.deepEqual(link.grant, { role: "recovery", memberId: user.id });
    assert.equal(readFileSync(app.config.file, "utf8").includes(link.code), false);
    assert.equal(app.config.devices(user.id).length, 0, "issuing a link does not add a device");

    // The live access policy wins over the access at link creation.
    app.config.updateUser(user.id, {
        role: "viewer",
        sessions: ["43"],
        tunnel: "old.trycloudflare.com",
    });
    const original = structuredClone(user);
    const page = await fetch(link.url, {
        headers: { authorization: `Bearer ${app.config.ownerToken}` },
    });
    const html = await page.text();

    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.match(html, /Sign in as Alex &#60;existing&#62;/);
    assert.doesNotMatch(html, /<existing>/);
    assert.match(html, /Continuing switches it/);
    assert.doesNotMatch(html, /name="name"/);
    assert.equal(app.config.devices(user.id).length, 0, "GET never spends a link");
    assert.equal((await redeem(link.code, { "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal(auth.inviteValid(link.code), true);

    const results = await Promise.all([
        redeem(link.code, {
            "x-forwarded-host": "new.trycloudflare.com",
            "sec-fetch-site": "same-origin",
        }),
        redeem(link.code),
    ]);

    assert.deepEqual(results.map((r) => r.status).sort(), [303, 410]);
    const signed = results.find((r) => r.status === 303)!;
    const cookie = signed.headers.get("set-cookie")!;

    assert.match(cookie, /Max-Age=31536000/);
    assert.equal(app.config.users.length, count);
    assert.deepEqual(
        user,
        original,
        "name, access, tunnel, primary credential and identity are unchanged",
    );
    assert.equal(app.config.userByToken(token)?.id, user.id, "old devices remain signed in");
    const me = await fetch(`${base}/api/me`, { headers: { cookie: cookie.split(";")[0]! } });
    const hello = (await me.json()) as { user: { id: string; role: string } };

    assert.equal(me.status, 200);
    assert.equal(hello.user.id, user.id);
    assert.equal(hello.user.role, "viewer");
    const loaded = new ConfigStore(dirname(app.config.file));
    const recoveredToken = decodeURIComponent(cookie.split(";")[0]!.slice("pocket_auth=".length));

    assert.equal(loaded.userByToken(recoveredToken)?.id, user.id, "device login survives restart");
    assert.equal(readFileSync(app.config.file, "utf8").includes(recoveredToken), false);
    const device = app.config.devices(user.id)[0]!;

    app.config.revokeDevice(user.id, device.id);
    assert.equal(
        (await fetch(`${base}/api/me`, { headers: { cookie: cookie.split(";")[0]! } })).status,
        401,
    );
    assert.equal((await fetch(link.url)).status, 410);
});

test("pending recovery survives restart, expires, cancels, and follows member deletion", async () => {
    const { user } = app.config.addUser("Recoverable", "guest");
    const pending = recover(user.id);
    const loaded = new Auth(new ConfigStore(dirname(app.config.file)));

    assert.deepEqual(loaded.invite(pending.code), { role: "recovery", memberId: user.id });
    auth.cancelInvite(pending.code, user);
    assert.equal(auth.inviteValid(pending.code), true, "only the issuing owner can cancel");
    assert.equal(
        (await post("invite/cancel", app.config.ownerToken, { code: pending.code })).status,
        200,
    );
    assert.equal((await redeem(pending.code)).status, 410);

    app.config.addInvite("expired-recovery", {
        role: "recovery",
        memberId: user.id,
        createdBy: owner(app).id,
        expiresAt: Date.now() - 1,
    });
    assert.equal((await redeem("expired-recovery")).status, 410);
    const deleted = recover(user.id);

    app.config.removeUser(user.id);
    assert.equal((await fetch(`${base}/join/${deleted.code}`)).status, 410);
    assert.equal((await redeem(deleted.code)).status, 410);
    assert.equal(app.config.devices(user.id).length, 0);
});

test("recovery rejects an unauthorized creator and owner token rotation invalidates pending links", async () => {
    const { user } = app.config.addUser("Target", "guest");

    app.config.addInvite("forged-recovery", {
        role: "recovery",
        memberId: user.id,
        createdBy: user.id,
        expiresAt: Date.now() + 60000,
    });
    assert.equal((await fetch(`${base}/join/forged-recovery`)).status, 410);
    assert.equal((await redeem("forged-recovery")).status, 410);
    const pending = recover(user.id);

    app.config.rotateOwnerToken();
    assert.equal((await redeem(pending.code)).status, 410);
});

test("full device capacity fails without consuming recovery, and a freed slot can recover", async () => {
    const { user } = app.config.addUser("Full", "guest");
    const link = recover(user.id);

    for (let i = 0; i < MAX_DEVICES; i++) {
        app.config.addDevice(user.id);
    }

    assert.equal((await redeem(link.code)).status, 409);
    assert.equal(auth.inviteValid(link.code), true);
    assert.equal(app.config.devices(user.id).length, MAX_DEVICES);
    app.config.revokeDevice(user.id, app.config.devices(user.id)[0]!.id);
    assert.equal((await redeem(link.code)).status, 303);
    assert.equal(app.config.devices(user.id).length, MAX_DEVICES);
});
