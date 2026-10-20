// Pure session-list protocol helpers: full snapshots keep legacy-server compatibility, and a missed delta must ask
// for a fresh snapshot instead of silently applying rows to an unknown list.

export function sessionSnapshot(data) {
    return Array.isArray(data)
        ? { sessions: data, sessionListVersion: null }
        : { sessions: data.items, sessionListVersion: data.version };
}

/** A new list/version, or null when the tab missed something and needs a full snapshot on its event stream. */
export function sessionDelta(sessions, version, delta) {
    if (
        typeof version !== "string" ||
        delta.from !== version ||
        typeof delta.version !== "string" ||
        delta.version === version
    ) {
        return null;
    }

    const rows = new Map(sessions.map((row) => [row.id, row]));

    for (const id of delta.removed) {
        rows.delete(id);
    }

    for (const row of delta.upsert) {
        rows.set(row.id, row);
    }

    return {
        sessions: [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id - b.id),
        sessionListVersion: delta.version,
    };
}
