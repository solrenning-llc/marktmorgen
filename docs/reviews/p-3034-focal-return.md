# Codex P focal return on #3034

Exact head: `84ebcee21225e2b736fecbfb6c77668b4bb725fb`.
Original finding: MEDIUM `5808315232`, acknowledged concurrent changes losing durable history.

## Verdict and scope

The original P concurrency MEDIUM is closed in the executed scope. The compare-and-set script checks the exact previous history before SET; conflict retries reread and revalidate, and exhaustion returns busy without confirming an unsaved change. The independent concurrency replay and canonical race/lost-ACK cases support that conclusion.

This is NOT an unconditional financial approval of the entire expanded PR. It now includes five paid-reader changes and 35 product/test/document paths compared with pinned main, beyond the original focal concurrency defect. The executed tests below passed, but no native Redis evaluation, browser/real component interaction, complete provider-cost certification or independent end-to-end certification of every new reader was performed. J owns the separate review and its remaining qualifications. Do not convert this partial focal closure into two complete clean financial opinions. Existing nine-check and queue requirements remain the author's responsibility.

## Frozen proof and explicit fixture correction

The original P proof `tests/p-review-3034-concurrent-history.test.ts` is unchanged, blob `adbca23daec9ebd4754b1538e691e23307e27156`.

| Source | Frozen original (2 checks) | Retry-aware copy (same 2 assertions) |
| --- | --- | --- |
| Original reviewed `12b73d60faa4a51489e1b3498489f1c8b5008685` | 1 causal failure: both confirm, only one history entry survives | Same 1 causal failure |
| Final `84ebcee21225e2b736fecbfb6c77668b4bb725fb` | 2 failures: returns true/false; only the confirmed change survives | 2/2 pass; both confirmed changes survive |

The frozen fixture returns null on EVERY matching GET, including CAS retry reads, thus deliberately hiding the winner forever from the competing writer. Its final failures do not demonstrate the original acknowledged-write-loss defect: the new reader refuses the second change instead of confirming and losing it.

The separately named retry-aware copy changes only the barrier condition to `commands[0][1] === key && reads < 2`. It forces the same initial simultaneous reads, then lets legitimate retries reach the actual MemoryRedis state. Both assertions and their expected values are unchanged. This harness correction was announced BEFORE editing in channel `dd56cb57e4e86922942c0b0b4c4a05e8a8ec16cf`; original evidence is preserved. No product or canonical test was changed.

## Executed validation

- Retry-aware P proof 2; canonical concurrency/lost-ACK suite 30.
- Sent links 77; change-cost 37; history page cost 24; email page cost 28.
- Broadcast email page cost 38; marks cost 9; MCP cost 12; path-growth cost 11.
- Total: 268 passing checks across ten files. Frozen final 2/2 failures are reported separately, not counted as green.
- Strict TypeScript selected roots: sent-links, broadcasts and retry-aware proof; zero diagnostics after explicitly locating the installed Node types. The initial temporary-config attempt lacked Node type resolution and is not a product diagnostic or a successful check.
- Focused ESLint: both source files and both independent proofs; zero errors. Public-data scanner and diff check run over final tracked evidence.
- No full suite, CI rerun, native Redis, browser, screen reader or provider request was exercised. Author source/ref/CI were read-only.

## Reproduction

Copy the two independent test files unchanged into the selected source checkout, install/use the repository's existing dependencies, and bundle each with esbuild using `testAliases(file, root, root + '/tests')` and `testEnvironment` from `tests/test-config.mjs`, as `tests/run.mjs` does. Run each CommonJS bundle in a separate Node 24 process with a 120-second timeout. Run the ten named files above on the final head; run the two independent files on exact12b for the causal contrast. No aliases replace the changeLink implementation or its storage script stand-in.

## Follow-up

Author keeps the current source; no correction was made by P. A complete second opinion on the expanded financial/read-cost scope remains outstanding from this focal return. Later head changes require content-identity checks or a requested new delta. No direct merge: C4-0226 requires waiting for the literal FILA LIGADA and then the authorized queue process; enqueued does not mean merged.
