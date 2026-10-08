#!/usr/bin/env node
/** Reproducible, hash-bound team runtime repairs; never touch rotom's installed runtime. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const manifest = JSON.parse(
    readFileSync(new URL("../vendor/pi-durable/patches.json", import.meta.url), "utf8"),
);
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function prepareRuntime() {
    const packageOf = (patch) => patch.package ?? "@earendil-works/pi-durable";

    for (const name of new Set(manifest.files.map(packageOf))) {
        const pkg = JSON.parse(
            readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), "utf8"),
        );

        if (pkg.name !== name || pkg.version !== manifest.version) {
            throw new Error(
                `Unexpected ${name} identity; review patches before updating dependencies.`,
            );
        }
    }

    for (const patch of manifest.files) {
        const path = new URL(`../node_modules/${packageOf(patch)}/${patch.path}`, import.meta.url);
        const source = readFileSync(path, "utf8");

        if (digest(source) === patch.patchedSha256) {
            continue;
        }

        if (digest(source) !== patch.sourceSha256) {
            throw new Error(`Unexpected runtime bytes: ${packageOf(patch)}/${patch.path}`);
        }

        let output = source;

        for (const edit of patch.edits) {
            if (output.split(edit.oldText).length !== 2) {
                throw new Error(`Patch seam is not unique: ${patch.path}`);
            }

            output = output.replace(edit.oldText, edit.newText);
        }

        if (digest(output) !== patch.patchedSha256) {
            throw new Error("Patched runtime digest mismatch.");
        }

        writeFileSync(path, output);
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    prepareRuntime();
    console.log("Verified team runtime patches.");
}
