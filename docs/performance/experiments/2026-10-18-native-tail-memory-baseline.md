# NativeTail retained memory — eleventh batch, experiment one

Measurement only. `test/perf/native-tail-memory.ts` compares identical synthetic files in fresh GC-enabled parent
processes, loading `5921153` (before retained entries) or the current tree. No server, native child, account, browser or
production data is involved. Cases: 128 × 120-char entries, 128 × 64 KiB entries, and 5 × 14 MiB image-sized strings.
Each does journal read, three complete-prefix/selected-leaf snapshots, append/delivery, then releases the tail. It counts
actual JSON.parse calls/chars and reports heap, RSS, external/Buffer bytes and process high-water RSS. The measurement
uses a new workload, not existing turn keys. Memory is observational and not registered as a deterministic ledger gate.

Final five-run reports `/tmp/rt-tail-memory-before-reuse-final.json` and `/tmp/rt-tail-memory-reuse-final.json`, Node
24.18.0, Apple M1 eight cores, macOS arm64, rotom 0.1.25. Timing locks highLoad false, 2.77→2.65 and 2.65→2.74.
The two earlier pairs are discarded: V8 retained the last snapshot temporary across a collection. The final probe
explicitly clears that array and samples on the next event-loop turn with two collections; fixture building also
returns before the baseline. It is a memory workload, not a server timing comparison.

| File payload | Idle heap after initial read, before→reuse | Idle heap after snapshots, before→reuse | Peak RSS growth from baseline, before→reuse | Total parses after three snapshots |
| ------------ | -----------------------------------------: | --------------------------------------: | ------------------------------------------: | ---------------------------------: |
| ~15 KiB      |                                  ~0→~0 MiB |                               ~0→~0 MiB |                               ~0.1→~0.1 MiB |                            516→129 |
| 8 MiB        |                                   ~0→8 MiB |                                ~0→8 MiB |                             ~89.9→~38.2 MiB |                            516→129 |
| 70 MiB       |                                  ~0→70 MiB |                         ~-4.8→~65.2 MiB |                           ~526.9→~178.3 MiB |                               24→6 |

These are medians of five independent processes. RSS high-water is process-wide and includes fixture construction;
heap retained after read provides the clearest object-cost comparison. Released tails and snapshot arrays are sampled
separately; garbage collection can release objects without returning RSS to the OS. No timing/L2/L3 claim.

Decision: reuse avoids transient repeated parses but raises long-lived heap in proportion to the entire history.
Do not accept unbounded retention for large image/text sessions. Next hypothesis: bound the retained encoded prefix
bytes to 1 MiB per run-owned tail; beyond that discard cached bodies and use the original full snapshot parse. Keep
journal-undelivered entries independent (not discardable), complete-file errors, selected leaf, RPC suffix and no-replay.
Small fixed turn workloads should keep the previous parse reduction; large memory cases should match pre-reuse retained
heap and parse counts. This bounds the encoded cache, not arbitrary V8 object overhead or whole-server memory.
