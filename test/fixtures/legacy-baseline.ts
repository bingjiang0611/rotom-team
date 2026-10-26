/** Materializes the pinned 7478123 public-Storage snapshot without loading or executing the old application. */
import { readFileSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import type {
    ConversationId,
    ConversationRecord,
    DocumentRecord,
    EntryRecord,
    JsonObject,
    Storage,
    StorageWrite,
    SubmissionRecord,
    TaskRecord,
} from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;
const snapshot = JSON.parse(
    readFileSync(new URL("./legacy-7478123.json", import.meta.url), "utf8"),
) as BaselineSnapshot;

type BaselineDocument = {
    record: DocumentRecord;
    content: { kind: "base"; version: number; value: JsonObject };
};
type BaselineSnapshot = {
    producer: { revision: string };
    extensionSource: string;
    extensionChoices: { enabledExtensions: string[]; disabledExtensions: string[] };
    fixture: {
        conversations: ConversationRecord[];
        entries: EntryRecord[];
        tasks: TaskRecord<JsonValue, JsonValue, JsonValue>[];
        submissions: SubmissionRecord[];
        documents: BaselineDocument[];
    };
};

function replaceRoot(value: JsonValue, cwd: string): JsonValue {
    if (typeof value === "string") {
        return value.replaceAll("$FIXTURE_ROOT", cwd);
    }

    if (Array.isArray(value)) {
        return value.map((item) => replaceRoot(item, cwd));
    }

    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, replaceRoot(item, cwd)]),
        );
    }

    return value;
}

function json<T>(value: T, cwd: string): T {
    return replaceRoot(value as JsonValue, cwd) as T;
}

/** Write the old app's captured records with current Storage APIs only. */
export async function seedPinnedLegacySession(
    storage: Storage,
    cwd: string,
): Promise<{ conversationId: ConversationId; partialConversationId: ConversationId }> {
    const fixture = snapshot.fixture;
    const ids = [
        ...fixture.conversations.map((record) => record.id),
        ...fixture.entries.map((record) => record.id),
        ...fixture.tasks.map((record) => record.id),
        ...fixture.submissions.map((record) => record.id),
        ...fixture.documents.map((document) => document.record.id),
    ].map(Number);
    const maxId = Math.max(...ids);

    // Reserve the generated ID range before importing the lower, captured IDs. The next successful commit persists it.
    for (let id = 0; id <= maxId; id++) {
        await storage.mintId();
    }

    const writes: StorageWrite[] = [
        ...fixture.conversations.map((value) => ({
            type: "conversation" as const,
            value: json(value, cwd),
        })),
        ...fixture.entries.map((value) => ({
            type: "entry" as const,
            value: json(value, cwd),
        })),
        ...fixture.tasks.map((value) => ({
            type: "task" as const,
            value: json(value, cwd),
        })),
        ...fixture.submissions.map((value) => ({
            type: "submission" as const,
            value: json(value, cwd),
        })),
        ...fixture.documents.map(({ record, content }) => {
            const { createdAt: _createdAt, retiredAt: _retiredAt, ...create } = record;

            return {
                type: "document.create" as const,
                record: create,
                content: json(content, cwd),
            } as StorageWrite;
        }),
    ];

    await storage.commit(writes, context);

    return {
        conversationId: fixture.conversations[0]!.id,
        partialConversationId: fixture.conversations[1]!.id,
    };
}

export const pinnedLegacyExtensionSource = snapshot.extensionSource;
export const pinnedLegacyExtensionChoices = snapshot.extensionChoices;
export const pinnedLegacyProducer = snapshot.producer;
export const pinnedLegacyEntries = snapshot.fixture.entries;
export const pinnedLegacyTasks = snapshot.fixture.tasks;
export const pinnedLegacySubmissions = snapshot.fixture.submissions;
