import { watch } from "node:fs";

/** Calls `onChange` shortly after anything under `directory` changes. */
export function watchTree(directory: string, onChange: (file: string) => void): () => void {
    let timer: NodeJS.Timeout | undefined;
    let last = "";
    const watcher = watch(directory, { recursive: true }, (_event, name) => {
        last = name?.toString() ?? "";
        clearTimeout(timer);
        timer = setTimeout(() => onChange(last), 200);
    });

    return () => {
        clearTimeout(timer);
        watcher.close();
    };
}
