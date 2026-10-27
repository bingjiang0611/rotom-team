import type { IncomingMessage, ServerResponse } from "node:http";
import type { User } from "../../src/server/config.ts";
import type { PocketApp } from "../../src/server/app.ts";
import { raw, type Counts } from "./counters.ts";

export type ScenarioResult =
    | { scenario: string; ms: number; counts: Counts; extra?: Record<string, number> }
    | { scenario: string; unavailable: string };

export type CallResult = { value: Record<string, unknown>; bytes: number };

export type BenchmarkTab = {
    fullView: Promise<void>;
    close: () => Promise<void>;
};

export type ScenarioAction = () => Promise<Record<string, number> | void>;
export type Scenario = (
    name: string,
    action: ScenarioAction,
    phaseTimings?: () => Record<string, number>,
) => Promise<void>;
export type RequestHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

/** Shared capabilities for extracted benchmark orchestration; each helper receives only this explicit context. */
export type ScenarioContext = {
    app: PocketApp;
    alice: User;
    base: string;
    history: number;
    ownerToken: string;
    root: string;
    token: string;
    raw: typeof raw;
    results: ScenarioResult[];
    call: (path: string, method?: string, body?: object) => Promise<CallResult>;
    inferenceRequests: () => number;
    quiet: (quietMs?: number, limitMs?: number) => Promise<void>;
    scenario: Scenario;
    submit: (id: number, turn: number, text?: string) => Promise<CallResult>;
    tab: (id: number) => BenchmarkTab;
    getHandler: () => RequestHandler;
    setHandler: (handler: RequestHandler) => void;
};
