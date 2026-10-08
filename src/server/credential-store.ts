/** Single-writer persistent credentials. The app data lock excludes another process; mutations serialize per file. */
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type {
    AuthOperationOptions,
    Credential,
    CredentialInfo,
    CredentialStore,
} from "@earendil-works/pi-ai";

export class FileCredentials implements CredentialStore {
    readonly #path: string;
    #data: Record<string, Credential>;
    #queue: Promise<unknown> = Promise.resolve();
    constructor(path: string) {
        this.#path = path;

        if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
            throw new Error("Credential file must not be a symlink");
        }

        this.#data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    }
    async read(provider: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
        options?.signal?.throwIfAborted();

        return structuredClone(this.#data[provider]);
    }
    async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
        options?.signal?.throwIfAborted();

        return Object.entries(this.#data).map(([providerId, credential]) => ({
            providerId,
            type: credential.type,
        }));
    }
    async #mutate<T>(action: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
        const pending = this.#queue
            .catch(() => {})
            .then(() => {
                options?.signal?.throwIfAborted();

                return action();
            });

        this.#queue = pending;

        return pending;
    }
    #save(next: Record<string, Credential>): void {
        const temporary = `${this.#path}.${randomUUID()}.tmp`;

        writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: "wx" });
        renameSync(temporary, this.#path);
        this.#data = next;
    }
    modify(
        provider: string,
        fn: (current: Credential | undefined) => Promise<Credential | undefined>,
        options?: AuthOperationOptions,
    ): Promise<Credential | undefined> {
        return this.#mutate(async () => {
            const value = await fn(await this.read(provider, options));

            options?.signal?.throwIfAborted();

            if (value !== undefined) {
                this.#save({ ...this.#data, [provider]: value });
            }

            return this.read(provider);
        }, options);
    }
    delete(provider: string, options?: AuthOperationOptions): Promise<void> {
        return this.#mutate(async () => {
            const next = { ...this.#data };

            delete next[provider];
            this.#save(next);
        }, options);
    }
}
