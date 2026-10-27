# D9c deletion inventory

Base: `2676e7f`, D9b approved by review round 17. The clean isolated worktree was fast-forwarded with `git pull --ff-only` before this work; original dirty workspaces and unrelated branches are untouched. This inventory is committed before implementation. All commits use `D9c:` and delivery must be clean and contain no unrelated commits.

Baseline `npm test`: **723 passed, zero failed/cancelled/skipped**, Node 24.18.0 / darwin-arm64 (232684 ms). No production data or real account is used.

## 1. Repository modules to remove

[Tracked reference evidence](d9c-references-before.txt) includes literal paths, exported helper uses, dynamic source discovery, and absence of `ExtensionLoader`/`prepareDropInFolder`. `app.ts` registers historical task identities, not this directory; `main.ts` watches only `web/`. `tsconfig.json` includes these files for compilation, not runtime loading.

**No production importer or runtime discovery remains.** Some tests still reference the modules; they must be removed together with the exact closure below. This is not a claim of zero references before the deletion. Every module is dynamically read by the two source-preservation tests in `docs-examples.test.ts` listed below; after removing that test closure there are no remaining executable import/discovery references.

| Delete entire file                   | Lines at base | Other current reference, included in this deletion closure                                                                                |
| ------------------------------------ | ------------: | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/extensions/artifacts.ts` |         1–193 | `projection.test.ts` imports `slugify`; its isolated slug test is removed.                                                                |
| `src/server/extensions/browser.ts`   |         1–477 | None beyond the dynamic docs-example scan.                                                                                                |
| `src/server/extensions/codemode.ts`  |         1–430 | `codemode.test.ts` invokes the retired factory/tool; that whole test file is removed.                                                     |
| `src/server/extensions/goals.ts`     |         1–103 | No executable reference beyond the dynamic scan. Historical result-rendering comment in `web/transcript.js` is not execution and remains. |
| `src/server/extensions/guard.ts`     |          1–80 | Retired codemode-to-guard integration in `codemode.test.ts`, removed with its caller.                                                     |
| `src/server/extensions/plan.ts`      |         1–313 | Three plan-parser/policy tests and one browser-plan policy test listed below; no native/shared caller.                                    |
| `src/server/extensions/prompt.ts`    |         1–152 | Both docs-example source checks listed below.                                                                                             |
| `src/server/extensions/schedules.ts` |          1–90 | None beyond the dynamic scan; shared time parser/task definitions are elsewhere and remain.                                               |
| `src/server/extensions/subagents.ts` |         1–318 | None beyond the dynamic scan; native subagents use the pinned runtime, not this module.                                                   |

Total: nine modules / 2156 source lines. Remove the empty repository directory, not any user data-folder directory. Historical comments and review/site snapshots are not imports. Native project paths such as `extensions/browser/index.ts` and `./extensions/evil.ts` are different resources and remain.

## 2. Exact test deletion list

Parent TypeScript AST extraction confirmed these twelve named top-level tests and their boundaries. The independent scout's source/grep audit agrees; its initial AST attempt predated dependency installation and is not cited as a successful check.

| File / base lines                    | Exact deleted test name                                                                             | Reason                                                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `test/codemode.test.ts:98–119`       | `a script calls tools, gets their text, and returns a value`                                        | Direct execution of the removed legacy codemode factory.                                                           |
| `test/codemode.test.ts:121–183`      | `nested calls are checked like direct ones: bad arguments, errors, and hooks that rewrite or block` | Same removed tool execution path, not the retained native boundary tests.                                          |
| `test/codemode.test.ts:185–205`      | `store() values last across scripts; failed scripts keep their output and change nothing`           | State/rollback of that retired factory.                                                                            |
| `test/codemode.test.ts:207–219`      | `output over the budget keeps its start and end, and saves the whole`                               | Output handling inside that retired tool.                                                                          |
| `test/codemode.test.ts:221–261`      | `with Lancet Guard asking, each nested call waits for its own answer, even in parallel`             | Removed codemode/guard integration, not independent Lancet or approval permission tests.                           |
| `test/docs-examples.test.ts:157–188` | `extensions.md names the reserved historical built-in tools and extension namespaces`               | Reads/parses every repository extension module solely to assert the now-removed source inventory.                  |
| `test/docs-examples.test.ts:190–227` | `the unloaded historical prompt source names existing documentation paths`                          | Parses the removed prompt module solely to check its embedded paths.                                               |
| `test/projection.test.ts:164–167`    | `artifact ids become kebab-case slugs`                                                              | `slugify` exists only inside removed artifact publication; all historical projection tests remain.                 |
| `test/plan.test.ts:19–47`            | `command lines split into words the way bash would, and anything beyond plain words is refused`     | Parser is exclusively inside the removed legacy plan module. This is not dismissed as redundant security coverage. |
| `test/plan.test.ts:49–111`           | `only commands that read pass, with arguments that keep them reading`                               | Policy belongs exclusively to that removed parser/module.                                                          |
| `test/plan.test.ts:113–134`          | `in plan mode only reading tools pass`                                                              | Removed module's `blockedInPlanMode`; no native/shared implementation uses it.                                     |
| `test/browser.test.ts:220–251`       | `plan mode lets Pi look at pages but not act on them`                                               | Same removed `blockedInPlanMode`, not browser URL/security/page-engine coverage.                                   |

Only `test/codemode.test.ts` is deleted as a whole. Other mixed-purpose test files remain. The four plan parser/policy tests may be deleted **only together with their exclusive implementation**; preserving that implementation would require preserving those tests.

### Exclusive test helpers/imports

- Entire `codemode.test.ts` private closure: `echo`, `shell`, `Fake`, `fakeApi`, `host`, `codemodeTool`, `run` and its imports. No shared-helper file depends on these locals.
- `docs-examples.test.ts:55–113`: `definitions`, whose only caller is the deleted namespace inventory test. Remove its exclusive imports `getDocsPath`, `APP_ROOT` (retain `ConfigStore`), `GOALS_EXTENSION`, `SCHEDULES_EXTENSION`.
- Remove the imports of `slugify` from projection and `blockedInPlanMode`/`commandWords`/`readOnlyCommand` from plan/browser. Update the plan test's header to describe its retained archive-refusal scope.
- No deletion from `test/helpers.ts`: `say`, `modelTexts`, `recordCost`, `appendHistoricalTurn`, `lastText` have real retained consumers. Keep docs-example `source()`, TypeScript and filesystem setup; the preserved examples still use them.

## 3. Explicit retained items

- **User data:** drop-in source files and `enabledExtensions`/`disabledExtensions` records remain byte-preserved and unloaded. No startup cleanup or migration deletes them. Keep data backup handling, including its existing dependency-link exclusion.
- **Archive contract:** D9a/D9b quarantine, private `LegacyTaskArchiveDoc`/`LegacyLiveArchiveDoc`, history/export, access grants and authorization/error precedence, atomic root closure, lost-ACK behavior and cleanup fencing remain unchanged.
- **Persistent definitions:** historical task names/versions/input/checkpoint/result, document kind/scope/history/fork, public Storage/Harness, native mirrors/ownership/account gates, personal credential routing and unknown-not-replayed behavior remain. No journal version or format change; no vendor changes.
- **Fixtures and probes:** all `test/fixtures/legacy-*`, `legacy-archive.test.ts`, `legacy-archive-ui.test.ts`, and original reviewer `d9a-review-probe-*.ts.txt` remain. The current head probe's `KEEP` support is used without modifying it.
- **Independent implementations/tests:** `lancet.ts` and `lancet.test.ts`; real `Approvals` and all four `approvals.test.ts` permission/identity/recovery/notification cases; `when.ts` and schedule/DST tests; prompt/template parsers; browser engine/URL/security/viewport/key tests; all remaining plan, projection, schedules, prompts, goals, running, branches, startup-recovery and app tests.
- **Non-loading/source preservation:** entire `dropins.test.ts`, `native-service-extensions.test.ts`, retained docs-example source/switch-preservation and link-integrity tests, and `docs/examples/{clock,no-force-push}.ts` remain. Examples are historical source, not executable Team guidance.
- **Outside this narrow deletion:** `host.ts`/`PocketHost`, shared helpers and dependencies are not removed merely because the deleted modules imported them. No package/lockfile pruning or speculative adjacent cleanup.

## 4. Documentation and CLI work

Update CLI help through existing centralized `ARCHIVE_COPY.cliMode`; do not change option behavior. Add one focused `legacy-archive.test.ts` CLI check proving help describes removed repository modules and preserves synthetic data-folder source/switch records without startup. Expected default count: **723 − 12 + 1 = 712**.

Update current claims in `PRODUCT`, `CONFIGURATION`, `architecture`, `map`, `LEGACY-ARCHIVE`, plus affected `VERIFICATION`, `AGENT-CONFIGURATION`, `extensions`, `self-editing`, `features` and inherited `AGENTS.md` instructions. `extensions.md` becomes a short current-native/historical-source guide; its historical examples remain. Remove the obsolete module table from map. Historical review records/site snapshots are not rewritten as current contracts.

State that D9c adds no data migration. Returning to D9b or D9a reads the same data and does not revive quarantined work. Returning to pre-D9a still requires the matched offline backup/product procedure; external unknown effects are not replayed automatically.

## 5. Acceptance plan

After deletion, rerun literal/export/dynamic-reference checks and compile the retained caller set. Preserve all independent assertions; no skips, broader refusals or weakened expectations. List the actual removed/added test names and reconcile the final count against the 723 baseline.

Run check/lint/format, default tests, legacy archive tests, native app and commands proofs with worker off/on, and locked `perf:ci` with gating/ledger guard. Keep the workload, instrument, ledger, tolerances and quiet rules unchanged; explain every worse counter, distinguishing inherited main differences and unassigned sampling variation.

Use original reviewer producer/reopen in isolated historical code with synthetic nonempty data and a positive sentinel control. Run unmodified head probe with `KEEP` in off/on/worker modes, then reopen each **same retained data directory** with D9b (`2676e7f`) code. Record exports, canonical refusals, archive-note counts, pending work, sentinel and closed leases in `d9c-validation.md`. Preserve probe hashes and final source hashes. After clean, related-only push, mark D9 **已推送待核验(D9c)** and stop.
