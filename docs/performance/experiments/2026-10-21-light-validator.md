# Program 3, step 2: a light subagent validator

## What the validator is, corrected

Each **subagent** start runs `rotom-child.sh`, which runs the team validator `rotom-child.ts` as its own Node process
and then execs Pi. The member's main native process does not go through it: `startRotomKernel` starts the product
launcher directly and checks resources in the server (`prepareTeamResources`, the 60–70 ms `nativeStartResourcesMs`).
The proposal said "a cold native start boots Node twice in a row"; that holds for subagent starts, not for the first
send of a session. This step therefore speeds up subagent starts, not `turn.cold`.

## Measurement first (`0ac6df4`)

`native.validate`, appended after all other scenarios: the validator a subagent start runs (`rotom-child.ts`), spawned
in the HOME and workspace of the member whose session `turn.prewarmed` used, with the shared profile, until it exits.
It must exit 0. Before: 964.3 ms median (3 runs, load 5.3 → 4.3); bare `node -e 0` is about 0.36 s here.

## Implementation (`3f4c291`)

`rotom-child.ts` imported `rotom-resources.ts` and `rotom-resource-policy.ts`; both imported `rotom-kernel.ts` (the
team's model library `pi-ai`, the RPC client) and called `nativeConfigurationApi`, which loads eleven native modules
and the session manager. The policy uses three: the settings manager, the package manager and the context loader.

- New `src/server/rotom-product.ts`: the pin paths, `canonical`, `verifyRotomKernel` (moved unchanged; `rotom-kernel.ts`
  re-exports it) and `nativeResourcePolicyApi()`, which runs the same identity checks as before (`verifyRotomKernel`,
  the product's own `resolveInstalledPi`) and imports only those three modules, with the same canonical-path checks.
- `assertTeamResourceSources` and `sharedContextPaths` (moved into `rotom-resource-policy.ts`, re-exported by
  `rotom-resources.ts`) use it. `rotom-child.ts` imports only the policy module.

The work is removed, not moved: the validator no longer loads modules it never used. The checks are the same, and they
run in the same order. The server's own preparation uses the same policy function, so it also parses the product's
`package.json` one time fewer per cold start.

## Results

`npm run perf:ci -- 0ac6df4 --runs 3 --out /tmp/rt-p3-val-ci` from the clean worktree, `highLoad: false`, load 5.3 →
4.3 on 8 cores:

| Scenario          | Base (`0ac6df4`)                     | Head (`3f4c291`)                        | Verdict                  |
| ----------------- | ------------------------------------ | --------------------------------------- | ------------------------ |
| `native.validate` | 964.3 ms (945.8–989.2)               | 669.4 ms (656.5–676.6)                  | **faster −31% (L2)**     |
| `turn.cold`       | 1,705.3 ms; 6 native-settings parses | 1,654.2 ms; 5 parses, 4,540 chars fewer | time noise; less parsing |

Other counters that moved are ones this change cannot reach: the server code it touches only runs at native start, yet
`web.open.long`, `turn.prewarmed` and `turn.prepared` each showed a second push in one run or two. That is the same
timing-dependent push race seen in step 1 (`session.reclaim`) and in base runs of `session.open`; it supports reading
those as an existing race, not new work. Cause still unknown.

## Verification

- `test/rotom-resources.test.ts`, two new tests: the validator, run as its own process, accepts a prepared HOME,
  prints the shared `AGENTS.md` path when context is frozen, and refuses a member extension added after preparation;
  and its import graph has the policy module but not `rotom-kernel.ts`, `rotom-rpc.ts`, `rotom-resources.ts` or the
  team's `pi-ai`. Negative control: with the old `rotom-child.ts` imports the import test fails on `rotom-kernel.ts`.
- `npm test` 543/543, `npm run check`, `npm run lint`, `npm run format:check`; `npm run test:kernel:app` passed,
  including `subagentsThroughTheGate`, `stopEndsSubagents` and `personalSkillsIgnoredByParentAndChild`, which start
  real subagents through `rotom-child.sh`.
- Ledger: `native.validate` registered from `/tmp/rt-p3-val-ci/head.json` and `/tmp/rt-p3-val-head2.json`;
  `perf:propose` lowered 13 baselines (the native-settings parses above, among them); `ratchet guard` passed against
  `/tmp/rt-p3-val-ledger-before.json`.

## Not verified / limits

- The real subagent start time (validator plus Pi) is not measured as a whole; only the validator is.
- Bundling the validator at install, the other option in the proposal, was not tried: Node's own start (about 0.36 s
  of the 0.67 s) remains.
