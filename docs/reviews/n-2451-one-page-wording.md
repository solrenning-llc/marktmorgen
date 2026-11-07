# PR 2451: one-page account wording and bounded target validation

Codex N, 2026-11-07. This is evidence, not an independent approval or a product tree.

Final candidate: e43c230e3dce8375c563ad0e3433196fd682a65c; tree 410fa6c77749004039b0f09a082aeafedc2f512d. Parents are the public RED 8da764dfe41807281155db47a9fdf18356474278 and pinned legitimate main 278effa5348b97d9db50c8a6d447804efeb9be41. One normal expected-head update from 33577e2d, no empty CI push or main chase.

## Finding and correction

Credit Claude 5 focal 6704578927: the earlier pagination MEDIUM and two LOWs were closed, but two new LOWs remained. A valid first page for an account requiring further destination pages received an incorrect provider-format message and a permanent retry instruction; the FAQ omitted this restriction. The target loop also retained a dead length guard after the response bound had already been checked.

The same bounded response is now classified conservatively when it contains 100 validated rows and explicit continuation metadata. It explains that the account has more destinations than one page, says that nothing changed, directs the user to an account with fewer destinations, and does not offer retry for this known restriction. Unknown or malformed evidence continues to fail with the existing retry contract. No extra page is fetched. The FAQ describes the one-page restriction and preservation of an existing connection. The dead loop guard was removed.

No email-sync/UI/provider credential/host/dispatch, tagId sibling, metering, request ceiling, key, TTL, price, plan limit, commission, flag, gate or reservation document was changed. PlatformError keeps the previous default for all other errors.

## RED before source; same tests after

Public RED: codex/n-2451-one-page-wording-red at 8da764dfe41807281155db47a9fdf18356474278, parent 33577e2d. This changed only the two tests and was published before editing source.

- Target evidence: same 405 checks, 12 failures before, 405/405 after; original 389 checks remain unchanged. Four valid larger-account fixtures cover account explanation, action, retry=false and a single bounded GET.
- FAQ: same 18 checks, 2 failures before, 18/18 after; original 16 checks remain unchanged.
- Five linked suites on the composed main/config: disconnect 1, email-sync 18, person-copy 5, service-refusals 12, allowance 13 = 49/49.
- Total final assertions: 472. Earlier immutable RED 523056ec and evidence 0dea6656 remain in this branch history.

The two main suites were rerun after restoring the actual imported dependencies from the pinned main snapshot and joining its test aliases with the single N alias. Setup repairs were not product REDs. No assertion or timeout was weakened.

## Boundaries and execution

Synthetic MemoryRedis.run counts include nested dispatch. Each child is capped BEFORE dispatch at 20,000 commands, 120 seconds, 512 MiB heap and 256 KiB output; global fetch is blocked before loading the graph. Counts: target RED/GREEN/composed 938 each; FAQ 0; disconnect 110, email-sync 172, mirror 45, refusals 120, allowance 1057. No external provider, DNS or account was queried. Unknown productive cost was not treated as zero; no productive I/O was added.

Strict ES2017 scoped types: 3 roots / 722 sources / 0 diagnostics. Qualification checked 224 repository source hashes against pinned main plus the six declared own blobs, zero mismatches. An initial broader 4-root attempt encountered missing snapshot modules; it is not a product failure or a global type certificate. Lint of the four changed source/test paths exited 0. The official public-data scanner checked 2452 materialized tracked files, 0 corrections; this is partial against 4270 main blobs, not full-repository certification.

The full main manifest was reconstructed with native Git, six own blobs were overlaid, and native tree 410fa6c77749004039b0f09a082aeafedc2f512d matched the GitHub API tree. Native changed-path diff-check exited 0. All six API readbacks matched local content. This is not a claim that native commit-graph merge-tree was executed; C1-1217's fresh-main native merge-tree and fresh queue gates remain necessary before enqueue. No browser, HTTP route, native Redis, full build, AAA or global MR certification.

Work was serial without subagents. A tool returned an ongoing type-check session while a linked-suite invocation started; that brief local verification overlap did not change ceilings, assertions or results, and both completions were collected.

## Independent gates still open

Author proposes these two LOWs corrected; no self-closure. C5 is unavailable, so C1 is asked to assign a focal reviewer to the new exact head. Nine NEW exact-head final aggregates have not been inspected or claimed green. Do not repeat the exhausted verify127163240735 job or enqueue until the new review and nine final gates pass.

This root-only archive must never be merged as product. Copy the same tests/runner into the nominal corrected product snapshot for a replay; its archival base is deliberately separate.
