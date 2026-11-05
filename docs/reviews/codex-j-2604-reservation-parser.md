# Independent review: reservation parser #2604

Exact head be33605e51a76d7832d290a9e2550026041312cc, reviewed 5 November 2026. Claimed before work in channel773b77fa1d2c776798834a7d3a2a8811ab7ac44e.

## Conclusion

NO FINDINGS / MAY MERGE after all nine final exact-head aggregate checks succeed. The complete two-file diff is limited to the two table-ending conditions and the new regression. Reverting only those two expressions makes every other byte of scripts/reservation-check.mjs identical to the RED version. SHARED_FILES, pullRequestInputs, ownership, longest-prefix selection, unknown-branch handling and shared exceptions remain unchanged. No author product, branch, reservation, CI or PR metadata was edited.

## Reproduction

- Author final RED e6ee338a74bdf95538d1c800af02ffb305ec7150:13 cases,5controls pass/8fail. Exact final same test blob643c88b23ac8a3cea1b26b72a6f47e38b9250872:13/13. Empty/whitespace LF/CRLF gaps no longer hide later reservations or lanes; headings and nonempty prose still end their tables.
- ORIGINAL I2 actual-document proof21d4b106ae9200cf05d4b57147eafaffcb312c66, proofs/i2/reservation-blank-row-red.mjs, blob7056150fd47cb96bb8d1dfa753df8cc6e7f5f1c6 copied with native git show and HASH-VERIFIED byte-identical. Source documents remain pinned to its original1a855ddfdf73c6571633003a18571790ad92745b in both runs; only the parser SHA changes through the proof's own TASK_PARSER_SHA input. Old e6ee gives5cases/3controls pass+2fail; final be336 gives5/5. Original source/proof/assertions were not edited. Native copy preserves its lack of a trailing newline; a preliminary tool-text copy had an extra newline and was replaced before the exact recorded runs, not counted as separate evidence.
- Independent proof codex/j-review-2604-real-inventory/e23ea69b323702e10ba4f57d54e5b8426ca7a22a, tests/j-review-2604-real-inventory.test.ts: SAME3cases old1control pass+2fail ->final3/3. It uses the real five-lane table and complete real Codex document, inserts gaps even between header and separator, and proves the last actual reserved file still conflicts for claude3/review through real conflicts(). LF/CRLF and whitespace variants run on final. Later paragraph, level-two heading and nested heading still stop the table before foreign rows. It does not reimplement the parser.

## Verification and scope

Author13 + existing15 + original5 + independent3 =36 passing cases. The existing reservation-check suite also has ONE local-only skip; that skip is explicit and not counted green. Strict directed TypeScript covers the three test files and actual JS API imports; exit0. No claim of new strict checkJs validation of the entire legacy JS body. ESLint on changed script/author test/independent proof0; node syntax check0. Public scanner3708/0 INCLUDING the independent proof through a private temporary index; real checkout index unchanged. Actual committed diff-check and proof diff-check0.

No application/provider IO, account, payment, quota, price, visible limit, commission, commercial term, flag, gate or reservation-document changes. CI is still required; this source review does not certify the complete hosted event/merge-parent/shallow-fetch environment. No browser, Redis, provider, global build/TSC, full-suite or deployment claim. Unknown CI/research costs remain unknown, never zero.
