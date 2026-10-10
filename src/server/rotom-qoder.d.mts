import type { Provider } from "@earendil-works/pi-ai";
import type { QoderRequestAuth } from "./rotom-executions.ts";

export function qoderRequestProvider(
    auth: QoderRequestAuth,
    signal?: AbortSignal,
    onMetering?: (data: Record<string, unknown>) => void,
): Promise<Provider>;
