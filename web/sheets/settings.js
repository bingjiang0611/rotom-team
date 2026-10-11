// Settings: the one place for everything app-wide. Its pages are the sheets they always were, shown beside a list of
// them; opening any of those sheets, from anywhere, opens it here.
import { api, attempt, closeSheet, collab, notify, openSheet, store } from "../store.js";
import { paletteOf } from "../theme.js";
import { html, Icon, Sheet, SettingsPage } from "../ui.js";

/** The sheets that are pages of the settings window. */
export const SETTINGS_PAGES = new Set([
    "name",
    "providers",
    "profile",
    "notifications",
    "appearance",
    "people",
    "projects",
    "spend",
    "running",
    "extensions",
]);

/**
 * Pi Pocket's extensions run in Pi Durable sessions only. A server that starts sessions in rotom has none of those to
 * change, so it shows no Extensions page: its switches would look like they guard rotom sessions, and do not.
 */
export const extensionsShown = () => !store.state.server?.kernel;

/** The page the settings window last showed: where it opens again. */
let lastPage = "running";

/** Open the settings window where it was left. */
export const openSettings = () => openSheet({ type: lastPage });

const page = (type, label, hint = "") => ({ type, label, hint });
const action = (label, run) => ({ label, run });

/** The settings window's list, in groups, for who is signed in here. */
function groups() {
    const { me, server, sessions } = store.state;
    const busy = sessions.filter((session) => session.busy).length;

    return [
        {
            title: "You",
            items: [
                page("name", "Your name"),
                page("providers", "My model accounts"),
                page("profile", server?.kernel ? "My browser sign-ins" : "Configuration & skills"),
                collab() && page("notifications", "Notifications"),
                page("appearance", "Appearance", paletteOf().name),
            ],
        },
        {
            title: "Team",
            items: [
                collab()
                    ? page("people", "People")
                    : action("Sign in another device", () => openSheet({ type: "invite" })),
                page("projects", "Projects & access"),
                page("spend", "Spend"),
            ],
        },
        {
            title: "Server",
            items: [
                page("running", "Running now", busy > 0 ? String(busy) : ""),
                extensionsShown() && page("extensions", "Extensions"),
                me?.role === "owner" &&
                    server?.supervised &&
                    action("Restart server", () =>
                        attempt(async () => {
                            await api("restart", {});
                            closeSheet();
                            notify("info", "Restarting. Running work continues after the restart.");
                        }),
                    ),
            ],
        },
    ].map((group) => ({ ...group, items: group.items.filter(Boolean) }));
}

const signOut = () =>
    attempt(async () => {
        await api("logout", {});
        location.href = "/";
    });

/** The settings window, showing the sheet `children` as its page `section`. */
export function SettingsSheet({ section, children }) {
    lastPage = section;

    return html`<${Sheet} title="Settings" onClose=${closeSheet} className="settings-window">
        <div class="settings">
            <nav class="settings-nav" aria-label="Settings">
                ${groups().map(
                    (group) => html`<div class="settings-group" key=${group.title}>
                        <div class="group-title">${group.title}</div>
                        ${group.items.map((item) =>
                            item.type
                                ? html`<button
                                    key=${item.type}
                                    class=${`settings-link ${item.type === section ? "on" : ""}`}
                                    aria-current=${item.type === section ? "page" : undefined}
                                    onClick=${() => openSheet({ type: item.type })}
                                >
                                    <span>${item.label}</span>
                                    ${item.hint && html`<span class="settings-hint">${item.hint}</span>`}
                                </button>`
                                : html`<button key=${item.label} class="settings-link" onClick=${item.run}>
                                    <span>${item.label}</span>
                                </button>`,
                        )}
                    </div>`,
                )}
                <button class="settings-link settings-out" onClick=${signOut}>
                    <${Icon} name="logout" size=${14} /> Sign out
                </button>
            </nav>
            <${SettingsPage.Provider} value=${true}>
                <div class="settings-pane" key=${section}>${children}</div>
            <//>
        </div>
    <//>`;
}
