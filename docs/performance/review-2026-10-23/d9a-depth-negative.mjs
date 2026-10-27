import assert from "node:assert/strict";
import { registerHooks } from "node:module";
registerHooks({
    load(url, context, nextLoad) {
        const result = nextLoad(url, context);

        if (!url.endsWith("/src/server/legacy-archive.ts")) {
            return result;
        }

        const source = String(result.source);
        const begin = source.indexOf("function rootOf(");
        const end = source.indexOf("\nfunction documentAddress(", begin);

        assert(begin >= 0 && end > begin);
        const original = source.slice(begin, end);

        assert(original.includes("for (;;) {"));
        const regressed = original
            .replace("for (;;) {", "for (let depth = 0; depth < 32; depth++) {")
            .replace(/\n}\n$/, "\n    return current;\n}\n");

        assert(regressed !== original && regressed.includes("    return current;\n}\n"));
        console.error("D9a negative control: restored original 32-edge truncation in memory only");

        return { ...result, source: source.slice(0, begin) + regressed + source.slice(end) };
    },
});
