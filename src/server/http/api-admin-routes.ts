import { readdirSync, statSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import QRCode from "qrcode";
import { origin, type Auth, type InviteGrant, type InviteMinutes } from "../auth.ts";
import type { User } from "../config.ts";
import { HttpError } from "../errors.ts";
import type { ApiRequest, HttpOptions } from "./io.ts";
import { json, readJson } from "./io.ts";

export type InviteGrantForUser = (
    user: User,
    body: { role?: unknown; session?: unknown; memberId?: unknown },
) => Promise<InviteGrant>;
export type InviteMinutesForBody = (body: { minutes?: unknown }) => InviteMinutes;

function lanAddresses(): string[] {
    return Object.values(networkInterfaces())
        .flat()
        .filter((net) => net !== undefined && net.family === "IPv4" && !net.internal)
        .map((net) => net!.address);
}

/** Session-adjacent administrative routes kept separate from the API dispatcher. */
export async function apiAdminRoutes(
    route: ApiRequest,
    parts: string[],
    options: HttpOptions,
    auth: Auth,
    requireOwner: (user: User) => void,
    inviteGrant: InviteGrantForUser,
    inviteMinutes: InviteMinutesForBody,
): Promise<boolean> {
    const { app, request, response, url, user } = route;
    const method = request.method ?? "GET";
    const [first, second, third] = parts;

    if (first === "users" && second === undefined && method === "GET") {
        json(response, 200, app.people(user));

        return true;
    }

    if (first === "users" && second !== undefined && third === "remove" && method === "POST") {
        app.removeUser(user, second);
        json(response, 200, { ok: true });

        return true;
    }

    if (first === "users" && second !== undefined && third === undefined && method === "POST") {
        app.setAccess(user, second, await readJson(request));
        json(response, 200, app.people(user));

        return true;
    }

    if (first === "approvals" && second !== undefined && method === "POST") {
        const body = await readJson<{ allow?: boolean }>(request);

        if (!(await app.answerApproval(second, body.allow === true, user))) {
            throw new HttpError(404, "That approval is no longer pending");
        }

        json(response, 200, { ok: true });

        return true;
    }

    if (first === "fs" && method === "GET") {
        app.requireSteer(user);

        if (user.sessions !== undefined) {
            throw new HttpError(403, "You were invited to one session.");
        }

        const requested = url.searchParams.get("path") || "~";
        const path = app.workspace.checkDirectory(requested);
        const showHidden = url.searchParams.get("hidden") === "1";
        const dirs: { name: string; path: string }[] = [];

        for (const entry of readdirSync(path, { withFileTypes: true })) {
            if (!showHidden && entry.name.startsWith(".")) {
                continue;
            }

            let isDir = entry.isDirectory();

            if (entry.isSymbolicLink()) {
                try {
                    isDir = statSync(join(path, entry.name)).isDirectory();
                } catch {
                    isDir = false;
                }
            }

            if (isDir) {
                dirs.push({ name: entry.name, path: join(path, entry.name) });
            }
        }

        dirs.sort((a, b) => a.name.localeCompare(b.name));
        const recent = [...new Set((await app.sessions(user)).map((session) => session.cwd))].slice(
            0,
            8,
        );

        json(response, 200, {
            path,
            parent: dirname(path) === path ? null : dirname(path),
            home: homedir(),
            dirs: dirs.slice(0, 1000),
            recent,
        });

        return true;
    }

    // A new folder, from the folder picker: it opens in the picker, ready to use.
    if (first === "fs" && second === undefined && method === "POST") {
        const body = await readJson<{ path?: unknown }>(request);

        if (typeof body.path !== "string") {
            throw new HttpError(400, "Name the folder to make.");
        }

        json(response, 200, { path: app.workspace.makeFolder(user, body.path) });

        return true;
    }

    if (first === "settings" && method === "POST") {
        const body = await readJson<{ approvalRule?: unknown }>(request);

        if (body.approvalRule !== undefined) {
            await app.setApprovalRule(user, body.approvalRule);
        }

        json(response, 200, { ok: true });

        return true;
    }

    if (first === "extensions" && second === undefined && method === "GET") {
        json(response, 200, await app.extensions(user));

        return true;
    }

    if (
        first === "extensions" &&
        second !== undefined &&
        third === undefined &&
        method === "POST"
    ) {
        requireOwner(user);
        const body = await readJson<{ enabled?: unknown }>(request);

        if (typeof body.enabled !== "boolean") {
            throw new HttpError(400, "enabled must be true or false");
        }

        await app.setExtensionEnabled(user, second, body.enabled);
        json(response, 200, await app.extensions(user));

        return true;
    }

    if (first === "extensions" && second !== undefined && third === "reload" && method === "POST") {
        requireOwner(user);
        await app.reloadExtension(second);
        json(response, 200, await app.extensions(user));

        return true;
    }

    if (first === "providers" && second === undefined && method === "GET") {
        json(response, 200, await app.providers.list(user));

        return true;
    }

    if (first === "providers" && second !== undefined && third === "login" && method === "POST") {
        app.requireSteer(user);
        const body = await readJson<{ type?: string }>(request);

        json(response, 200, {
            flowId: await app.providers.startLogin(
                user,
                second,
                body.type === "oauth" ? "oauth" : "api_key",
            ),
        });

        return true;
    }

    if (first === "providers" && second !== undefined && third === "logout" && method === "POST") {
        app.requireSteer(user);
        await app.providers.logout(user, second);
        json(response, 200, { ok: true });

        return true;
    }

    if (first === "auth" && second !== undefined && third === "cancel" && method === "POST") {
        app.providers.cancelLogin(user, second);
        json(response, 200, { ok: true });

        return true;
    }

    if (first === "auth" && second !== undefined && third !== undefined && method === "POST") {
        const body = await readJson<{ value?: string; cancel?: boolean }>(request);

        app.providers.answerLogin(
            user,
            second,
            third,
            body.cancel === true ? undefined : String(body.value ?? ""),
        );
        json(response, 200, { ok: true });

        return true;
    }

    if (first === "invite" && second === "cancel" && method === "POST") {
        const body = (await readJson(request)) as { code?: unknown };

        if (typeof body.code !== "string") {
            throw new HttpError(400, "Say which invite.");
        }

        // Only whoever made it ends it; for anyone else it stays as it was, and nothing says whether it exists.
        auth.cancelInvite(body.code, user);
        json(response, 200, { ok: true });

        return true;
    }

    if (first === "invite" && second === undefined && method === "POST") {
        const body = (await readJson(request)) as {
            role?: unknown;
            session?: unknown;
            minutes?: unknown;
            memberId?: unknown;
        };
        const grant = await inviteGrant(user, body);
        const invite = auth.createInvite(user, grant, inviteMinutes(body));
        const here = origin(request);
        const loopback = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/.test(here);
        const wildcard = options.listen.host === "0.0.0.0" || options.listen.host === "::";
        const lan =
            loopback && wildcard
                ? lanAddresses().map((address) => `http://${address}:${options.listen.port}`)
                : [];
        // A tunnel the launcher started is the way in for other devices.
        const tunnel = loopback ? app.access?.url : undefined;
        const base = tunnel ?? lan[0] ?? here;
        const link = `${base}/join/${invite.code}`;
        // An invite whose QR code could not be made is never shown: it ends rather than stay live, unseen.
        const svg = await QRCode.toString(link, {
            type: "svg",
            margin: 1,
            color: { dark: "#000000", light: "#ffffff" },
        }).catch((error: unknown) => {
            auth.cancelInvite(invite.code, user);

            throw error;
        });

        json(response, 200, {
            ...invite,
            grant,
            url: link,
            svg,
            alternatives: (tunnel === undefined ? lan.slice(1) : lan).map(
                (address) => `${address}/join/${invite.code}`,
            ),
            // Only this device can open a loopback link.
            local: loopback && lan.length === 0 && tunnel === undefined,
            ...(app.access === undefined ? {} : { access: app.access }),
        });

        return true;
    }

    if (first === "restart" && method === "POST") {
        requireOwner(user);

        if (!app.supervised) {
            throw new HttpError(
                409,
                "Start Pi Pocket with bin/pi-pocket.js to restart from the app.",
            );
        }

        json(response, 200, { ok: true });
        setTimeout(() => options.restart(), 100);

        return true;
    }

    return false;
}
