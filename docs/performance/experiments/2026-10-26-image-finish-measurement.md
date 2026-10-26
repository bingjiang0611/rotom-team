# Wait for image measurement completion (2026-10-26)

Measurement only, before the send-confirmation climb. No product or workload change.

The five-run baseline at `5bde0dd` failed on run 2: `imageProbe.report` rejected an unfinished response. Receiving the client body does not order the server's `finish` callback. The failed baseline produced no report and cannot be used as a performance comparison (its timing wrapper also recorded `highLoad: true`).

Reuse the event-completion fix already present in the main checkout's uncommitted image measurement work: each observed response resolves on `finish` or `close`, and the scenario awaits all responses **inside the measured window**, before reading the report. An aborted response still fails the existing assertion. There are no sleeps, retries, assertion changes, new workload keys or counter changes. The main checkout was not changed or staged.

Verification in the isolated worktree, Node 24.18.0 / darwin-arm64:

- `node --test test/perf-image-compat.test.ts test/perf-images.test.ts`: 6 passed.
- Added deterministic two-response controls: finishing one cannot complete the batch; finishing both permits reporting; closing one without finish still rejects reporting.
- Negative control: replace the event wait with an immediately resolving promise. Both new controls fail with `one finished response cannot complete the batch`; restored event wait passes.
- `npm run check`: passes after installing the pinned kernel in the worktree. The initial check without that installation failed on missing native MCP imports, not on this change.
- Targeted ESLint, Prettier and `git diff --check`: pass.

No optimisation or L1/L2 gain is claimed. Subsequent base and head runs must both use this instrument. Initial logs are `/tmp/rt-send-base-20261026-r2.log` and `/tmp/rt-image-negative-20261026.log`; no raw production data is committed.
