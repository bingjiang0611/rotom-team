/** Runtime-only mutations for D8b regression checks; never edit the working tree or use on real data. */
import { registerHooks } from "node:module";

const mutations = {
    "report-loss": {
        file: "test/perf/measure.ts",
        before: 'metric.startsWith("storage.worker.") || metric.startsWith("v8.")',
        after: "false",
    },
    "env-close-order": {
        file: "src/server/app.ts",
        before: "for (const env of this.#envs.values()) {",
        after: "if (this.#storageWorker && failures.length === 0) { await this.#storageWorker.close(); } for (const env of this.#envs.values()) {",
    },
    "queue-close": {
        file: "src/server/storage-worker.ts",
        before: 'call.method !== "close" &&',
        after: "",
    },
    "resume-drain": {
        file: "src/server/team-kernel.ts",
        before: "            if (this.#resumeDrain) {\n                await this.#resumeDrain;\n            }",
        after: "",
    },
    environment: {
        file: "src/server/storage-worker.ts",
        before: "env: {},",
        after: "",
    },
    "projection-double-count": {
        file: "src/server/storage-worker-thread.ts",
        before: "storageWorkChannel.publish(work);",
        after: 'storageWorkChannel.publish(work); if (roomPartScope.getStore() && work.counters) { work.counters["view.kernel.project.calls"] = (work.counters["view.kernel.project.calls"] ?? 0) + 1; }',
    },
    "false-rejection": {
        file: "src/server/storage-worker-thread.ts",
        before: "kind: rejected",
        after: "kind: true",
    },
};
const mode = new URL(import.meta.url).searchParams.get("mode");
const mutation = mutations[mode];

if (!mutation) {
    throw new Error(`Unknown D8b negative control: ${mode}`);
}

registerHooks({
    load(url, context, nextLoad) {
        const loaded = nextLoad(url, context);

        if (!url.endsWith(`/${mutation.file}`)) {
            return loaded;
        }

        const source =
            typeof loaded.source === "string"
                ? loaded.source
                : new TextDecoder().decode(loaded.source);

        if (source.split(mutation.before).length !== 2) {
            throw new Error(`D8b negative control no longer matches exactly once: ${mode}`);
        }

        return { ...loaded, source: source.replace(mutation.before, mutation.after) };
    },
});
