export function pushProfile(options: {
    server: string;
    token: string;
    agentDir?: string;
}): Promise<{
    instructions: boolean;
    skills: string[];
    refused: { name: string; error: string }[];
}>;
export function main(args: string[]): Promise<void>;
