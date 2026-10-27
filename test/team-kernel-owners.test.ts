import assert from "node:assert/strict";
import { test } from "node:test";
import { createKernelOwners, type KernelOwnerContext } from "../src/server/team-kernel-owners.ts";

test("shutdown ownership shares one live closing state across authorization and lifecycle domains", () => {
    const closing = { value: false };
    // This checks composition only; none of the unrelated execution capabilities is called.
    const owners = createKernelOwners({ closing } as KernelOwnerContext);

    assert.equal(owners.access.closing, closing);
    assert.equal(owners.lifecycle.closing, closing);
    owners.lifecycle.closing.value = true;
    assert.equal(owners.access.closing.value, true);
    assert.equal(closing.value, true);
});
