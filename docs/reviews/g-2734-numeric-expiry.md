# Codex G — independent #2734 review

Exact head 03a6c5d3cc433e070fd91dd31683e3faa90fb903. Claim before diff/tests: channel23db8d27e4e5604fa1180f30cb9fa1d7bda15e8c. Complete two-path diff read: lib/backup-parts.ts4+/1-, new test63+; surrounding copy/manifest/codec and sibling export inspected. Decision: **ONE MEDIUM RESIDUAL; NOT MAY MERGE**.

## MEDIUM — invalid numeric expiry is skipped before validation

lib/backup-parts.ts:224–227. The new type check closes null/text/array/boolean coercions. However the expired comparison at226 runs BEFORE Number.isSafeInteger and the allowed negative-sentinel check at227. Thus -3, -0.5, 1.5, negative infinity and an unsafe negative integer all take continue, silently omitting a still-existing source key.

The actual copyInParts fixture contains six keys. Replace exactly one PEXPIRETIME response, preserving the real DUMP and source key. Every invalid-number vector returns ok:true/keys5. The proof decrypts the actual produced manifest with openManifest and its actual parts with openBackup: the five-row verified artifact lacks the target while the source GET still returns value-3. This is a successful cryptographic verification of an incomplete copy, not merely an incorrect response count.

Primary source read06/11/2026: https://redis.io/docs/latest/commands/pexpiretime/ . Redis documents integer timestamps and the two sentinel values -1 and -2; these injected other values are abnormal response evidence, not a claim Redis itself emits them. Validate the numeric schema before interpreting a value as expired. Keep legitimate absent/no-expiry/expired behavior and never activate the backup from this review.

## Evidence

Own branch codex/g-review-2734-numeric-expiry. Proof tests/g2734-numeric-expiry.proof.ts@4763abdf949b0f791d8c407142a5fa55196a072f; runner tests/g2734-run.mjs@ec612dc4bc511d841ed7ba3017bd7215d94c4f0f. Run node tests/g2734-run.mjs g2734-numeric-expiry.proof.ts.

Original author test unchanged: full RED d92e4da7 gives6checks/5failures; exact final gives6/6. Expanded proof preserves the original six runtime assertions and adds15 checks: full d92 gives21/15failures; reviewed source gives **21checks/10causal failures/11passing controls and checks**. Every numeric vector has an exact injection/source-value control and two failing assertions (must refuse; must not verify an incomplete artifact). No weakened assertion. The two original static is calls are byte-identical as AST call text to the derivative prefix.

Ordinary original plus eight linked backup groups: **282/282**,0fail/skip (original6; parts26; codec21; cost27; export22; restore-target41; roundtrip11; run96; store32). Strict scoped TS with actual imports/proofs0; focused lint0; scanner3804tracked/0+twoown/0; diff clean. No actual native Redis, external bucket/provider, scheduled backup run, hosted restore, browser, global build/CI or real monetary margin certified. All object writes are to an in-memory Map. The repository backup remains built/off as declared by its implementation; no configuration was changed.

Rule30: lib/backup-export.ts:103–106 has the SAME ordering (expired skip before integer/sentinel validation); this sibling is a static same-pattern candidate inspected in source, not a second runtime reproduction or independent severity. Coordinate its owner before product edits. The residual numeric ordering already existed before the one-line type repair; no claim this PR introduced it. It lies directly in the boundary being corrected.

No product/reservation/author branch/CI modified or PR merged. Author C3 retains the corrective work; G repeats the same proof on a new requested head.
