/**
 * Preloaded into a member's rotom kernel (NODE_OPTIONS --import). rotom's browser tools connect to the Chrome relay
 * socket under HOME, and a member HOME is not the service user's. A link there would not do: macOS limits a socket
 * path to 104 bytes, and a member HOME path is longer. So a connect to exactly that path goes to the service user's
 * relay socket instead (ROTOM_TEAM_BROWSER_RELAY). Every other connect is left as it is.
 */
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const target = process.env.ROTOM_TEAM_BROWSER_RELAY;
const own = join(
    homedir(),
    "Library",
    "Application Support",
    "rotom",
    "browser-relay",
    "relay.sock",
);

if (target) {
    const redirect = (original) =>
        function (...args) {
            if (args[0] === own) {
                args[0] = target;
            } else if (args[0]?.path === own) {
                args[0] = { ...args[0], path: target };
            }

            return original.apply(this, args);
        };

    net.connect = redirect(net.connect);
    net.createConnection = redirect(net.createConnection);
    syncBuiltinESMExports();
}
