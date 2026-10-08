import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Provider } from "@earendil-works/pi-ai";
import { protectImportedRefresh } from "../src/server/team-accounts.ts";
import { createRefreshGuard } from "../vendor/qoder/refresh-guard.mjs";
import { cleanUp, root } from "./helpers.ts";
after(cleanUp);
test("an unknown OAuth refresh is journaled before dispatch, not replayed after restart; imported copies never refresh", async () => {
    const folder = join(root, "native-refresh");

    mkdirSync(folder);
    let calls = 0;
    const provider: Provider = {
        id: "openai",
        name: "Test OAuth",
        getModels: () => [],
        stream() {
            throw new Error("Not used");
        },
        streamSimple() {
            throw new Error("Not used");
        },
        auth: {
            oauth: {
                name: "Test",
                async login() {
                    throw new Error("Not used");
                },
                async toAuth() {
                    return { apiKey: "fake" };
                },
                async refresh() {
                    calls++;

                    throw new Error("Injected unknown response after dispatch");
                },
            },
        },
    };
    const credential = {
        type: "oauth" as const,
        access: "fake-access",
        refresh: "fake-refresh",
        expires: 0,
    };
    const guard = () => createRefreshGuard(realpathSync(folder));
    const first = protectImportedRefresh(provider, guard());

    await assert.rejects(
        first.auth.oauth!.refresh(
            { ...credential, rotomTeamReadOnlyImport: true },
            new AbortController().signal,
        ),
        /read-only/,
    );
    assert.equal(calls, 0);
    await assert.rejects(
        first.auth.oauth!.refresh(credential, new AbortController().signal),
        /Injected unknown/,
    );
    assert.equal(calls, 1);
    const restarted = protectImportedRefresh(provider, guard());

    await assert.rejects(
        restarted.auth.oauth!.refresh(credential, new AbortController().signal),
        /already_attempted/,
    );
    assert.equal(calls, 1);
    const aborted = new AbortController();

    aborted.abort();
    await assert.rejects(
        restarted.auth.oauth!.refresh(
            { ...credential, refresh: "unused-new-refresh" },
            aborted.signal,
        ),
        { name: "AbortError" },
    );
    assert.equal(calls, 1);
});
