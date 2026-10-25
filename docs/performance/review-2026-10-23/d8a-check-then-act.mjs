// Same scheduling as createAsyncRotomJournal: one FIFO tail over a synchronous core.
let head = "A";
const log = [];
const core = {
    session: () => ({ segmentId: head }),
    finishHandoff: () => {
        head = "B";
        log.push("handoff finish -> head B");
    },
    reserve: () => {
        log.push(`reserve on head ${head}`);
    },
};
let tail = Promise.resolve();
const j = Object.fromEntries(
    Object.keys(core).map((n) => [
        n,
        (...a) => {
            const op = tail.then(() => core[n](...a));

            tail = op.then(
                () => undefined,
                () => undefined,
            );

            return op;
        },
    ]),
);

async function run() {
    const admitted = "A";
    const s = await j.session(); // check

    if (s.segmentId !== admitted) {
        return log.push("conflict");
    }

    log.push("check passed on A");
    await j.reserve(); // act
}

const p = run();

j.finishHandoff(); // a handoff completion already in flight
await p;
await tail;
console.log(log.join("\n"));
