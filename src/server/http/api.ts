/**
 * `/api`: the routes the web app calls. Each needs a signed-in person, and each but a GET needs the `X-Pocket` header,
 * which a form on another site cannot send. A conversation's routes are in `conversation-routes.ts`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { listAgentResources } from "../agent-resource-list.ts";
import { MAX_PEEKS } from "../app.ts";
import {
    type Auth,
    COOKIE,
    clearAuthCookie,
    INVITE_MINUTES,
    type InviteGrant,
    type InviteMinutes,
    parseCookies,
    quickTunnelHost,
} from "../auth.ts";
import type { User } from "../config.ts";
import { HttpError } from "../errors.ts";
import { desktopTheme, wallpaperFile } from "../omarchy.ts";
import {
    parseTransportSignal,
    parseWebTimings,
    webTimingChannel,
    transportChannel,
} from "../perf-channels.ts";
import { runningNow } from "../running.ts";
import { parseSendContext, sendTraceTag } from "../send-trace.ts";
import { serveImage } from "./assets.ts";
import { apiAdminRoutes } from "./api-admin-routes.ts";
import { browserRoutes } from "./browser-routes.ts";
import { conversationRoutes } from "./conversation-routes.ts";
import { createEventStreams } from "./events.ts";
import { parseClaim } from "../view-claim.ts";
import { SUBSCRIPTION_COPY } from "../constants/copy.ts";
import { type ApiRequest, conversationId, type HttpOptions, json, readJson } from "./io.ts";
import { pushRoutes } from "./push-routes.ts";

/** The `/api` routes. Each HTTP handler makes its own, and its event streams live as long as it does. */
export function createApi(options: HttpOptions, auth: Auth) {
    const { app } = options;
    const { events, poll } = createEventStreams(app);

    const requireUser = (request: IncomingMessage): User => {
        const user = auth.user(request);

        if (user === undefined) {
            throw new HttpError(401, "Sign in first");
        }

        return user;
    };

    const requireOwner = (user: User): void => {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }
    };

    /**
     * What an invite may grant: viewers and people invited to one session cannot invite anyone, and only the owner can
     * sign a device in as the owner (never for one session).
     */
    const inviteGrant = async (
        user: User,
        body: { role?: unknown; session?: unknown; memberId?: unknown },
    ): Promise<InviteGrant> => {
        if (body.memberId !== undefined) {
            requireOwner(user);

            if (typeof body.memberId !== "string" || body.memberId === "") {
                throw new HttpError(400, "Say which member to recover.");
            }

            if (body.role !== undefined || body.session !== undefined) {
                throw new HttpError(400, "Recovery keeps the member's existing access.");
            }

            return { role: "recovery", memberId: body.memberId };
        }

        if (body.role === "owner") {
            requireOwner(user);

            return { role: "owner" };
        }

        if (user.role === "viewer" || user.sessions !== undefined) {
            throw new HttpError(403, "Only people with access to every session can invite others.");
        }

        const role = body.role === "viewer" ? "viewer" : "guest";

        if (body.session === undefined || body.session === null) {
            return { role };
        }

        const session = conversationId(String(body.session));

        if (!(await app.sessions(user)).some((each) => each.id === Number(session))) {
            throw new HttpError(400, "No such session");
        }

        return { role, session: String(session) };
    };

    /** How long an invite lasts, in minutes: one of `INVITE_MINUTES`, 15 when not said. */
    const inviteMinutes = (body: { minutes?: unknown }): InviteMinutes => {
        if (body.minutes === undefined) {
            return 15;
        }

        const minutes = INVITE_MINUTES.find((each) => each === body.minutes);

        if (minutes === undefined) {
            throw new HttpError(400, "An invite lasts 15 minutes, an hour, a day, or a week.");
        }

        return minutes;
    };

    /** A guest signed in by a cookie set on a Cloudflare quick tunnel can only come back through it: remember which one. */
    const noteTunnel = (request: IncomingMessage, user: User): void => {
        if (
            user.role === "owner" ||
            user.tunnel !== undefined ||
            !parseCookies(request.headers.cookie)[COOKIE]
        ) {
            return;
        }

        const tunnel = quickTunnelHost(request);

        if (tunnel !== undefined) {
            app.config.updateUser(user.id, { tunnel });
        }
    };

    /**
     * Folders whose Agent resources this person may list. A session trusts and loads its own folder, registered or
     * not, so the owner gets every session's folder and the default one; a member, only the projects they may view.
     */
    const agentResourceFolders = async (user: User) => {
        const folders = new Map<
            string,
            { path: string; project?: string; isDefault?: boolean; sessions: number }
        >();

        const add = (path: string) => {
            const folder = folders.get(path) ?? { path, sessions: 0 };

            folders.set(path, folder);

            return folder;
        };

        for (const project of app.projects.all(user)) {
            add(project.cwd).project = project.name;
        }

        if (user.role === "owner") {
            add(app.defaultCwd).isDefault = true;
        }

        for (const session of await app.sessions(user)) {
            const folder = user.role === "owner" ? add(session.cwd) : folders.get(session.cwd);

            if (folder) {
                folder.sessions += 1;
            }
        }

        return [...folders.values()].sort(
            (a, b) => Number(!!b.project) - Number(!!a.project) || b.sessions - a.sessions,
        );
    };

    return async (
        request: IncomingMessage,
        response: ServerResponse,
        url: URL,
        parts: string[],
    ): Promise<void> => {
        const method = request.method ?? "GET";
        const user = requireUser(request);

        noteTunnel(request, user);

        const [first, second, third, fourth] = parts;
        // Only stored images implement read-only HEAD. Do not exempt unrelated methods/routes from the write guard.
        const imageHead =
            method === "HEAD" && first === "c" && third === "image" && fourth !== undefined;

        if (method !== "GET" && !imageHead && request.headers["x-pocket"] !== "1") {
            throw new HttpError(403, "Missing X-Pocket header");
        }

        const route: ApiRequest = { app, request, response, url, user };

        if (first === "events" && method === "GET") {
            return events(request, response, url, user);
        }

        if (first === "poll" && method === "GET") {
            return poll(request, response, url, user);
        }

        if (first === "subscribe" && method === "POST") {
            const body = await readJson<{
                connection?: unknown;
                generation?: unknown;
                conversationId?: unknown;
                have?: unknown;
            }>(request);

            if (
                !body ||
                typeof body.connection !== "string" ||
                body.connection.length > 64 ||
                typeof body.generation !== "number" ||
                !Number.isSafeInteger(body.generation) ||
                body.generation < 1 ||
                (body.conversationId !== null &&
                    (typeof body.conversationId !== "number" ||
                        !Number.isSafeInteger(body.conversationId) ||
                        body.conversationId < 0)) ||
                (body.have !== undefined &&
                    body.have !== null &&
                    (typeof body.have !== "string" || body.have.length > 160))
            ) {
                throw new HttpError(400, SUBSCRIPTION_COPY.invalidRequest);
            }

            return json(
                response,
                200,
                await app.subscribe(
                    user,
                    body.connection,
                    body.generation,
                    body.conversationId === null
                        ? undefined
                        : conversationId(String(body.conversationId)),
                    parseClaim(typeof body.have === "string" ? body.have : null),
                ),
            );
        }

        if (first === "me" && method === "GET") {
            return json(response, 200, await app.hello(user));
        }

        if (first === "projects" && method === "GET") {
            return json(response, 200, app.projects.all(user));
        }

        if (first === "projects" && method === "POST") {
            requireOwner(user);
            const project = app.projects.save(
                user,
                await readJson(request),
                (id) => app.config.userById(id) !== undefined,
            );

            await app.projectsChanged();

            return json(response, 200, project);
        }

        if (first === "agent-resources" && second === undefined && method === "GET") {
            if (!app.kernel) {
                throw new HttpError(404, "Agent resources are listed only on a Team server.");
            }

            const folder = url.searchParams.get("folder");

            // Only folders this person may view; any other path reads as unknown.
            if (
                folder !== null &&
                !(await agentResourceFolders(user)).some((each) => each.path === folder)
            ) {
                throw new HttpError(404, "No such folder.");
            }

            return json(
                response,
                200,
                await listAgentResources(join(app.dataDir, "team-agent"), folder ?? undefined),
            );
        }

        if (first === "agent-resources" && second === "folders" && method === "GET") {
            if (!app.kernel) {
                throw new HttpError(404, "Agent resources are listed only on a Team server.");
            }

            return json(response, 200, await agentResourceFolders(user));
        }

        if (first === "devices" && third === undefined) {
            if (method === "GET" && second === undefined) {
                return json(response, 200, app.config.devices(user.id));
            }

            if (method === "POST" && second === undefined) {
                return json(response, 200, app.config.addDevice(user.id));
            }

            if (method === "DELETE" && second !== undefined) {
                app.config.revokeDevice(user.id, second);

                // Close this member's established streams so revoked bearer credentials must authenticate again.
                for (const client of app.clients) {
                    if (client.user.id === user.id) {
                        client.send("closing", {});
                        app.detach(client);
                        client.close?.();
                    }
                }

                return json(response, 200, { ok: true });
            }
        }

        if (first === "profile" && method === "GET") {
            return json(response, 200, app.profiles.get(user));
        }

        if (first === "profile" && method === "POST") {
            app.requireSteer(user);

            return json(response, 200, app.profiles.save(user, await readJson(request)));
        }

        if (first === "me" && method === "POST") {
            const body = await readJson<{ name?: string }>(request);
            const name = String(body.name ?? "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 40);

            if (name === "") {
                throw new HttpError(400, "Name is empty");
            }

            app.rename(user, name);

            return json(response, 200, { ok: true });
        }

        if (first === "logout" && method === "POST") {
            clearAuthCookie(response);

            return json(response, 200, { ok: true });
        }

        // A tab's content-free timings for the daily performance journal; dropped while nothing journals.
        if (first === "perf" && method === "POST") {
            const body = await readJson<{ timings?: unknown; send?: unknown }>(request);
            const timings = parseWebTimings(body);

            if (
                timings === null ||
                !["timings", "send,timings"].includes(Object.keys(body).sort().join(","))
            ) {
                throw new HttpError(400, "Not a timing report");
            }

            let trace: string | undefined;

            if (body.send !== undefined) {
                const send = parseSendContext(body.send, user.id, timings);

                if (send === null) {
                    throw new HttpError(400, "Not a send timing context");
                }

                app.requireSee(user, conversationId(String(send.conversationId)));
                trace = sendTraceTag(String(send.conversationId), send.requestKey);
            }

            if (webTimingChannel.hasSubscribers) {
                for (const timing of timings) {
                    webTimingChannel.publish({ ...timing, ...(trace ? { trace } : {}) });
                }
            }

            return json(response, 200, { ok: true });
        }

        if (first === "perf-transport" && method === "POST") {
            const transition = parseTransportSignal(await readJson(request));

            if (transition === null) {
                throw new HttpError(400, "Not a transport report");
            }

            if (transportChannel.hasSubscribers) {
                transportChannel.publish(transition);
            }

            return json(response, 200, { ok: true });
        }

        if (first === "visibility" && method === "POST") {
            const body = await readJson<{ tab?: unknown; visible?: unknown }>(request);

            app.setVisible(user, String(body.tab ?? ""), body.visible !== false);

            return json(response, 200, { ok: true });
        }

        // The sessions a connection shows as peek tiles on screen now: they get `peek` events until it sends another list.
        if (first === "peeks" && method === "POST") {
            const body = await readJson<{ connection?: unknown; ids?: unknown; seq?: unknown }>(
                request,
            );

            if (!Array.isArray(body.ids)) {
                throw new HttpError(400, "ids must be a list of session ids");
            }

            if (body.seq !== undefined && !Number.isSafeInteger(body.seq)) {
                throw new HttpError(400, "seq must be a whole number");
            }

            app.setPeeks(
                user,
                String(body.connection ?? ""),
                body.ids.slice(0, MAX_PEEKS).map((id) => conversationId(String(id))),
                body.seq as number | undefined,
            );

            return json(response, 200, { ok: true });
        }

        if (first === "push") {
            return pushRoutes(route, second);
        }

        // The Omarchy desktop's theme, for the app's "Follow desktop" look: colors say nothing about the sessions here, so
        // everyone signed in gets them. The wallpaper may be a personal photo: only the owner gets that.
        if (first === "theme" && second === undefined && method === "GET") {
            const theme = await desktopTheme();

            return json(response, 200, {
                theme:
                    theme === null
                        ? null
                        : { ...theme, wallpaper: theme.wallpaper && user.role === "owner" },
            });
        }

        if (first === "theme" && second === "wallpaper" && method === "GET") {
            if (user.role !== "owner") {
                throw new HttpError(403, "Only the owner sees the desktop's wallpaper");
            }

            const file = await wallpaperFile();

            if (file === undefined) {
                throw new HttpError(404, "No wallpaper");
            }

            return serveImage(request, response, file);
        }

        if (first === "running" && method === "GET") {
            return json(response, 200, await runningNow(app, user));
        }

        if (first === "spend" && method === "GET") {
            return json(response, 200, await app.spend.summary(user));
        }

        if (first === "spend" && method === "POST") {
            const body = await readJson<{ session?: unknown; person?: unknown; budget?: unknown }>(
                request,
            );

            if (body.session !== undefined) {
                await app.spend.setSessionBudget(
                    user,
                    conversationId(String(body.session)),
                    body.budget,
                );
            } else if (typeof body.person === "string") {
                app.spend.setPersonBudget(user, body.person, body.budget);
            } else {
                throw new HttpError(400, "Say which session or person");
            }

            return json(response, 200, await app.spend.summary(user));
        }

        if (first === "sessions" && second === undefined && method === "GET") {
            return json(response, 200, await app.sessions(user));
        }

        if (first === "sessions" && second === undefined && method === "POST") {
            const body = await readJson<{ cwd?: string; title?: string; worktree?: unknown }>(
                request,
            );

            return json(response, 200, await app.commands.createSession(user, body));
        }

        if (first === "sessions" && second === "sync" && method === "POST") {
            const body = await readJson<{ connection?: unknown }>(request);

            if (typeof body.connection !== "string" || body.connection.length > 64) {
                throw new HttpError(400, "A session-list connection is required.");
            }

            await app.resyncSessionList(user, body.connection);

            return json(response, 200, { ok: true });
        }

        if (first === "sessions" && second !== undefined && method === "POST") {
            const body = await readJson<{ title?: string; archived?: boolean }>(request);

            await app.commands.updateSession(conversationId(second), user, body);

            return json(response, 200, { ok: true });
        }

        if (first === "c" && second !== undefined) {
            const id = conversationId(second);

            app.requireSee(user, id);

            if (third === "browser") {
                return browserRoutes(route, id, fourth, options.listen.port);
            }

            return conversationRoutes(route, id, parts);
        }

        if (
            await apiAdminRoutes(
                route,
                parts,
                options,
                auth,
                requireOwner,
                inviteGrant,
                inviteMinutes,
            )
        ) {
            return;
        }

        throw new HttpError(404, "Unknown API route");
    };
}
