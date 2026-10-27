/** Historical resend task definition retained for archive decoding; Team never executes Durable resends. */
import { defineTask, type EntryId } from "@earendil-works/pi-durable";
import { ARCHIVE_COPY } from "./constants/copy.ts";

export type Resend = { text: string; by: string; images?: { entry: EntryId } };

type ResendState = { phase: "send" };

export const ResendTask = defineTask<Resend, ResendState, null>({
    name: "pocket.resend",
    version: 1,
    initial: () => ({ phase: "send" }),
    phases: {
        send: async () => {
            throw new Error(ARCHIVE_COPY.executionRetired);
        },
    },
    abort: (_task, runtime, context) =>
        runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});
