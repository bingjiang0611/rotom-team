import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kernelNetworkEnvironment } from "../src/server/rotom-kernel.ts";

test("native routing inherits only proxy variables and keeps credential broker direct", () => {
    assert.deepEqual(
        kernelNetworkEnvironment({
            HTTP_PROXY: "http://proxy.invalid:8000",
            HTTPS_PROXY: "http://proxy.invalid:8443",
            ALL_PROXY: "socks5://proxy.invalid:9000",
            NO_PROXY: "internal.invalid",
            OPENAI_API_KEY: "must-not-inherit",
            HOME: "/not-the-owned-home",
            NODE_OPTIONS: "--require=untrusted",
            ROTOM_PI: "/untrusted",
        }),
        {
            HTTP_PROXY: "http://proxy.invalid:8000",
            HTTPS_PROXY: "http://proxy.invalid:8443",
            ALL_PROXY: "socks5://proxy.invalid:9000",
            NO_PROXY: "internal.invalid,127.0.0.1",
        },
    );
});
test("native routing preserves lowercase precedence and explicit empty values", () => {
    assert.deepEqual(
        kernelNetworkEnvironment({
            HTTP_PROXY: "http://upper.invalid",
            http_proxy: "",
            https_proxy: "http://lower.invalid",
            all_proxy: "socks5://lower.invalid",
            NO_PROXY: "upper.invalid",
            no_proxy: "lower.invalid",
        }),
        {
            HTTP_PROXY: "http://upper.invalid",
            http_proxy: "",
            https_proxy: "http://lower.invalid",
            all_proxy: "socks5://lower.invalid",
            NO_PROXY: "lower.invalid,127.0.0.1",
        },
    );
    assert.deepEqual(kernelNetworkEnvironment({ NO_PROXY: "*", no_proxy: "" }), {
        NO_PROXY: "127.0.0.1",
    });
    assert.deepEqual(kernelNetworkEnvironment({}), { NO_PROXY: "127.0.0.1" });
});

test("native trust-file routing is explicit, canonical and cannot import node options", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "kernel-network-")));

    try {
        const cert = join(root, "ca.pem");

        writeFileSync(
            cert,
            "path-identity fixture; actual TLS is covered by the opt-in native proof",
        );
        assert.deepEqual(
            kernelNetworkEnvironment({
                NODE_EXTRA_CA_CERTS: cert,
                NODE_OPTIONS: "--require=untrusted",
            }),
            { NO_PROXY: "127.0.0.1", NODE_EXTRA_CA_CERTS: cert },
        );
        symlinkSync(cert, join(root, "link.pem"));
        assert.throws(
            () => kernelNetworkEnvironment({ NODE_EXTRA_CA_CERTS: join(root, "link.pem") }),
            /canonical|symlink/,
        );
        assert.throws(
            () => kernelNetworkEnvironment({ NODE_EXTRA_CA_CERTS: "relative.pem" }),
            /absolute/,
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
