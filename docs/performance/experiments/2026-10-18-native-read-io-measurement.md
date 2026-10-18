# Measure parent synchronous read I/O before retaining NativeTail entries

Second experiment of the tenth climb batch. Parse counts alone could be gamed by retaining objects while rereading the
same bytes, so register parent `readSync` calls and returned bytes before the optimization. This changes measurement
only; it does not intercept async reads, Chromium, native-child I/O, mmap/SQLite or production behavior.

Five-run baseline `/tmp/rt-native-tail-base.json`, commit `a93ea06` plus measurement and unchanged user edits; macOS
arm64 / Apple M1 eight cores / Node 24.18.0 / rotom 0.1.25. Load 2.27→2.33, timing lock `highLoad: false`.
Counters are candidates only; a second post-change report will register them from two times before any tightening.

This counter is total synchronous parent reads, not a NativeTail-only attribution. An optimization claim requires both
JSONL parses and total read bytes/calls to fall or remain explainably bounded; moving work to an uncounted file API is
forbidden. Existing fs write/rename and JSON scope counters are unchanged.
