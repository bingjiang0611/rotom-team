/** Exercise the real browser command module with a private, deterministic store and HTTP boundary. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function fixture(unknown = false) {
    let clock = 1;
    let posts = 0;
    const commands = ["plain", "fixture.echo", "新命令"].map((name) => ({
        name,
        source: "extension",
    }));
    const store: any = {
        state: {
            me: { id: "member" },
            conversationId: 1,
            view: { kernel: { segmentId: "one" }, live: {} },
            templates: null,
        },
        set(value: unknown) {
            Object.assign(this.state, value);
        },
    };
    const actions = {
        prompts: async () => ({ commands, dynamicReady: !unknown, freshness: "undiscovered" }),
        discoverCommands: async () => {
            posts++;

            return { receipt: { status: "unknown" } };
        },
    };
    const source = readFileSync(new URL("../web/commands.js", import.meta.url), "utf8")
        .replace(/^import .*;\n/m, "")
        .replace(/^export /gm, "");
    const module = new Function(
        "store",
        "actions",
        "canSteer",
        "Date",
        `${source}\nreturn {loadTemplates,discoverCommands,parseCommand,suggestCommands};`,
    )(store, actions, () => true, { now: () => clock });

    return {
        module,
        store,
        actions,
        posts: () => posts,
        advance: () => {
            clock += 31_000;
        },
    };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("native menu grammar supports dotted and non-ASCII registry names", async () => {
    const { module } = fixture();

    module.loadTemplates("/");
    await tick();

    for (const name of ["plain", "fixture.echo", "新命令"]) {
        assert.equal(module.parseCommand(`/${name} exact`).command.name, name);
        assert.equal(module.suggestCommands(`/${name}`).length, 1);
    }
});

test("unknown discovery is never automatically POSTed again after the cache TTL", async () => {
    const { module, store, posts, advance } = fixture(true);

    module.loadTemplates("/");
    await tick();
    assert.equal(posts(), 1);
    assert.match(store.state.templates.discoveryError, /unknown/);
    advance();
    module.loadTemplates("/");
    await tick();
    assert.equal(posts(), 1);
    await assert.rejects(module.discoverCommands(), /Reconcile unknown/);
    assert.equal(posts(), 1);
});

test("opening a known command sheet does not race it with automatic discovery", async () => {
    const { module, posts } = fixture(true);

    module.loadTemplates("/plain");
    await tick();
    assert.equal(posts(), 0);
});

test("late catalog responses cannot cross member or segment boundaries", async () => {
    for (const kind of ["get", "post"]) {
        const { module, store, actions } = fixture();
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => {
            release = resolve;
        });
        const result = {
            commands: [{ name: "PRIVATE_OLD_SCOPE", source: "extension" }],
            dynamicReady: true,
            freshness: "live",
        };

        if (kind === "get") {
            actions.prompts = async () => {
                await barrier;

                return result;
            };
        } else {
            actions.discoverCommands = async () => {
                await barrier;

                return { ...result, receipt: { status: "handled" } };
            };
        }

        const pending = kind === "get" ? module.loadTemplates("/") : module.discoverCommands();

        if (kind === "get") {
            store.state.me = { id: "different-member" };
        } else {
            store.state.view.kernel.segmentId = "different-segment";
        }

        release();
        await pending;
        await tick();
        assert.equal(module.suggestCommands("/PRIVATE").length, 0);
    }
});

test("failed discovery requires an explicit action, not an automatic TTL retry", async () => {
    const { module, store, actions, advance } = fixture(true);
    let attempts = 0;

    actions.discoverCommands = async () => {
        attempts++;

        throw new Error("Response lost");
    };

    module.loadTemplates("/");
    await tick();
    assert.equal(attempts, 1);
    assert.match(store.state.templates.discoveryError, /Response lost/);
    advance();
    module.loadTemplates("/p");
    await tick();
    assert.equal(attempts, 1);
});

test("a retained catalog is not displayed after member identity changes", async () => {
    const { module, store } = fixture();

    module.loadTemplates("/");
    await tick();
    assert.equal(module.suggestCommands("/fixture").length, 1);
    store.state.me = { id: "another-member" };
    assert.equal(module.suggestCommands("/fixture").length, 0);
});
