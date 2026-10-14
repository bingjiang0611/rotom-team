export function inspectNative(data: string): {
    format: string;
    leasePresent: boolean;
    leaseOwnerPid: number | null;
    toolClosure: string;
    replayPermitted: boolean;
    journalPresent: boolean;
    version?: number;
    pendingTotal?: number;
    truncated?: boolean;
    pending?: {
        attemptId: string;
        conversationId: string;
        segmentId: string;
        requestId: string;
        memberId: string;
        operation: string;
        recordedStatus: string;
        transcriptBound: boolean;
        unresolvedCommandInput?: true;
        outcome: string;
    }[];
};
export function backup(data: string, destination: string): void;
export function restore(archive: string, destination: string): void;
