# D9a historical fixture provenance

The default suite loads `test/fixtures/legacy-7478123.json` through the public Storage materializer in `test/fixtures/legacy-baseline.ts`, then runs the **current** product. It does not read Git history, launch historical product code, or enable Durable execution.

## Origin and verification

- Historical source: `7478123983cd9d9a2ff25782f87523043bdfe181`, exported to a separate temporary directory, not a worktree.
- Environment: Node 24.18.0, Pi Durable 1.0.2, synthetic faux provider only. No real model account or deployment data.
- The historical app created sessions and executed a completed turn using its public command API. A synthetic cancellable tool remained active, a queued follow-up and future schedule remained pending, and another genuine generation supplied nonempty partial output.
- Public Storage reads ran on the Harness mutation line, before closing the old app. No direct SQLite writes or private storage tables were used.
- Captured: 2 conversations, 9 original entries, 5 tasks (4 active), 4 submissions (3 unsettled), and 24 documents. Extension source and enabled/disabled choices are included.
- Temporary fixture paths were replaced with `$FIXTURE_ROOT`. SDK documentation paths in the captured system prompt are public installation paths, not credentials.
- Original export SHA-256: `c1e2f404db44d4791bbedd155841faab6bfa52eebfe236a2e36bb961ca9c2e79`.
- Formatted committed fixture SHA-256: `b55d529504da7fad11381a582532b31b789a414a0f5f991937b4eac1f8c97422`.
- JSON-decoded content equality between the original export and formatted fixture was checked; formatting changed bytes, not records.

The fixture embeds source SHA-256 values for the historical app, document definitions, shell, schedules, and resend implementation. Each matched the pinned Git revision when produced.

## Manual regeneration only

`d9a-fixture-producer.ts.txt` is deliberately not executable or discovered by the default suite in this checkout. Copy it to `test/d9a-export.ts` in a separate, unmodified historical export. It checks the five pinned source hashes before opening the historical app and requires an explicit output path. Output uses exclusive creation; it never overwrites the committed fixture by default.

From the repository root, with Node 24 available:

```sh
baseline=$(mktemp -d /tmp/rotom-d9a-producer.XXXXXX)
git archive 7478123983cd9d9a2ff25782f87523043bdfe181 | tar -x -C "$baseline"
cp docs/performance/review-2026-10-23/d9a-fixture-producer.ts.txt "$baseline/test/d9a-export.ts"
(cd "$baseline" && npm ci && node test/d9a-export.ts /tmp/d9a-fixture-regenerated.json)
```

Choose a new absolute output filename if that file already exists. Do not run the producer against current source or a live data directory. The copied historical helper creates and cleans its own private temporary app data; the historical source export and requested JSON output remain for inspection.

The saved producer differs from the initial one-off producer only by formatting, explicit output/exclusive creation, source-hash preflight, and a stronger nonempty partial-text condition. It was run again successfully in the isolated historical export: the regenerated result again contained 2 conversations, 9 entries, 5 tasks, 4 submissions and 24 documents. Timestamps and captured streaming position are nondeterministic; byte-identical regeneration is not promised.

Local evidence: `/tmp/rotom-review-D9a/fixture-producer-config.log`, `fixture-regeneration.log`, and the original/regenerated JSON files. The default tests assert current-product migration, preservation, access, and no dispatch; regeneration itself is not evidence that the current product is safe.
