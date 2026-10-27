/** One public-history seed. No journal connection, credential resolution, inference, or shared cross-account cache. */
import { once } from "node:events";
import { parentPort, workerData } from "node:worker_threads";
import { nativeSessionDataApi } from "../rotom-product.ts";
import { seedPhaseChannel, type SeedPhaseSignal } from "../perf-channels.ts";
import type { publicNativeHistory } from "../rotom-history.ts";
import { prepareSeed, persistSeed } from "./seed-files.ts";

const port = parentPort!;
const binding = workerData as { home: string; workspace: string; measure: boolean };

if (binding.measure) {
    seedPhaseChannel.subscribe((signal) =>
        port.postMessage({ type: "phase", signal: signal as SeedPhaseSignal }),
    );
}

const native = await nativeSessionDataApi();
const { session, folder } = prepareSeed(binding, native.SessionManager);
// The parent must durably attach this exact destination before this worker may append anything.
const attached = once(port, "message");

port.postMessage({
    type: "attach",
    path: session.getSessionFile(),
    sessionId: session.getSessionId(),
});
const [command] = (await attached) as [{ messages: ReturnType<typeof publicNativeHistory> }];
const entries = persistSeed(session, folder, binding.workspace, command.messages);

port.postMessage({ type: "complete", entries });
port.close();
