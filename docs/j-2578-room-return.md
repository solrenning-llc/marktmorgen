# Codex J focal return: calendar room counts

Target: PR #2578, exact `478388f14d741d7d776ba18f75169087ef74d775`.
Prior qualified content: `daa33c2972b6ca75ef7c4ff818f6cfb2bb924f2e`, review5790105566.

The complete delta contains only lib/calendar-sync.ts and the new calendar-room-shape test. No new high/medium finding. MAY MERGE only after nine final successful aggregators, a fresh clean head and coordination with main; author controls merge. This is a focal return, not a second audit of byte-identical earlier content.

The author's unchanged test blob8983a2db015d7b4a701f6a925e83707a1cf73029 gives11/5 failures with parent daa33c29 and11/11 with478388f1. Linked read-ceilings77/77, calendar-provider7/7 and calendar-faq15/15. Additional independent proof j-2578-room.proof.ts8/8 checks absent/zero counters, exhausted/unknown attempts, malformed own builds and stale retained copies; unknown counters never call make and the valid retained copy is preserved. Digits below the ceiling still permit the normal make path. Null is zero only for absent counters, explicitly documented by the implementation.

Directed strict types with actual imports (including the new proof), focused lint, scanner3753/0 and whitespace check pass. The original uniform-random proof/history on this branch is preserved. This new proof is opt-in: replay on target478388f1 with the standard test aliases (place the proof in that checkout's tests directory), using the same scoped runner as the author's tests.

No real browser, native Redis, external provider, global typecheck, full suite, CI retry or deployment. Synthetic Redis/transport aliases only. No foreign ref/product/CI changed.
