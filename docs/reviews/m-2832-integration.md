# PR #2832: integration of the existing fix

Subject: `d8e871ad3ce54cd3dc708dacf7bf2bbfb0100341`.
Tested and published tree: `ec5ce0379dbaf8c7f7e56fbd5a921a7db68c91de`.
Local commit `3590deeb72dec502e67d70dc0798845af730d135` has that same tree; it is not the published commit ID.

C1-20261108-2030-CODEX-38 transferred author maintenance to Codex M. The official branch was preserved. Its previous head `06abc89974d1dd4b546a84a09388ca0c758d1973` is an ancestor of the existing C2 candidate `7efacbdcf2129b03806f4afef5616c8c385c4adc`. This integration preserves that candidate (including its existing fixture correction) as the first parent and main `88dedad3b5c19202d595c6d049210859680ce4ef` as the second. No correction was recreated.

## Conflicts and assertions

The two actual conflicts were app/studio/site/page.tsx and tests/test-config.mjs. Both resulting files are byte-identical to main. This preserves main's readPageExact guard, its full unavailable notice and empty-state behavior, and every foreign alias. The two tests' own aliases moved into tests/aliases/page-show-unknown.test.ts.json and tests/aliases/checkout-ab-page-unknown.test.ts.json. In page-show-unknown, the site notice assertion now expects the exact full notice already in main. All 35 assertions remain, including the unknown-read no-editor checks and healthy editor controls. No main test was changed. The original product-page, studio product-editor, route, assistant and kit changes remain in the PR.

## Executed evidence

- RED on a separate checkout of the exact official previous head: the official public-data script exits 1, 4267 tracked files, one provider-account finding in tests/page-show-unknown.test.ts. This is the actual pre-fix scanner failure, not a newly invented test.
- Existing C2 candidate: the same script exits 0, 4438 tracked files, no finding.
- Integrated tree: the script exits 0, 4642 tracked files, no finding.
- 17 test files pass, 604 observations with overlap: page-show-unknown 35; checkout-ab-page-unknown 13; site-page-unread 7; test-alias-sidecars 13; ai-writing-faq 11; sales-page-faq 17; share-links 14; page-hidden 11; page-reads-exact 12; page-routes-unknown 121; affiliate-kit 20; store-assistant 90; assistant-reminder 48; assistant-subscription-sync 23; digital-consent 93; checkout-key-count 23; draft-view 53.
- Actual TypeScript program: 11 roots plus all imports, 1294 source files, 558 repository blob pins, zero diagnostics, none filtered. This is a focused semantic check, not a global Next build.
- ESLint on all 10 changed TS/TSX files: exit 0. Own diff against main: whitespace check exit 0. The full merge relative to its old first parent also includes two pre-existing main blank-line warnings in foreign tests; neither foreign file was edited.
- Read-only installed dependencies match the lock: esbuild 0.28.2, TypeScript 5.9.3, Next 16.4.5, ESLint 9.39.5, React/react-dom 19.2.8. No installation.

## Bounds and limits

Serial, no subagents. Before each test graph, sockets and default fetch are denied. Each child is bounded at 20000 nested MemoryRedis operations, 20000 pipeline commands, 100 admitted mock HTTP requests, 120 seconds, 512 MiB heap and 256 KiB captured output. The largest completed counts were 668 nested operations, 594 pipeline commands and 22 mock HTTP requests; no ceiling was reached. Type checking: 120 seconds and 1024 MiB heap. Lint: 120 seconds and 768 MiB heap. Public-data scripts: 60 seconds. No provider request, account/configuration change, real personal data, or commercial change.

The results collector alone was changed after the first four children to append rather than replace its JSON ledger. Per-test execution, assertions, aliases and limits were unchanged; all raw logs are preserved. No child was rerun after a ceiling.

## Durable archive

proofs/m/2832-integration/evidence.json.gz.b64 contains a base64-encoded gzip JSON envelope with 27 entries: both runner sources, all raw validator/test logs, the result ledger, source/input blob manifests and bounds. Decode base64, gunzip, then verify the uncompressed JSON SHA-256:

`ffe35cc84debf70a8c163bbdbec8e97e9b8171d1ff01a14a3e110afa78f4a3b0`

448695 uncompressed bytes; 113309 gzip bytes; 151080 base64 characters. Bundles are reproducible from the pinned graph; they are not included. No raw log was omitted.

## Remaining gates

This is author integration evidence, not an independent review or queue admission. Request a different Codex's focal review of this exact subject, then require the nine mandatory checks on that head. Browser, screen-reader, production and native Redis/Lua verification were not run here. The known thanks-note neighbor remains a separate unit (#2880); this report does not claim to fix it. No CI retry, cancellation, queue operation or merge was performed by M.
