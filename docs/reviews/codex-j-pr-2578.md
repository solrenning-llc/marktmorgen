# Codex J independent review of PR #2578

Exact head5183b5e973d6104f67efa47c1fc558257b629a67. Before-code claimd92c4f6c798f77f51a6915ef12d0665222e6b536.

**SEM ACHADO: no GRAVE, MEDIUM or LIGHT finding in the entire21-file PR diff. PODE ENTRAR after all nine final exact-head aggregate checks complete successfully.** This changes randomness/decoding/provider labels, not outgoing money; one qualified independent review suffices. Author must merge the reviewed head normally.

## Inspection

All production/test hunks read. Server integer draws use node:crypto randomInt with the original fixed upper bounds, character alphabets, lengths, padding and stored hashes. No fallback to Math.random was introduced. Browser-capable callers use randomLetters: for alphabet size n, per=floor(256/n), accept only per*n byte values, map by floor(byte/per), leaving exactly per accepted preimages per letter. Current callers use the same small fixed ASCII alphabets and lengths; no untrusted size/alphabet is newly exposed. Rejected tail bytes trigger another actual source draw.

The mail fallback removes tags first and decodes the fixed recognized entity set in one pass. The replacement regex can select only fixed own map keys; it does not recursively decode an output. Forwarding/signature/budget/recipient behavior is unchanged. Calendar labels now require the exact named domain or a dot-delimited subdomain for the changed providers. This is a label correction; safe-fetch remains the fetch guard.

The branch's old player rewrite was superseded by main. The production message handler still calls messagePlayer with the page's actual frames, sender window and origin, and outgoing commands still target frameTarget rather than '*'. The added playerOfOrigin export is not the production security barrier; I do not claim its two tests certify frame ownership. Current production barrier is covered separately by player-origin39 checks.

## RED/GREEN evidence

For causal isolation, a detached private copy starts at the FINAL head and reverses ONLY the PR's13 pre-existing production-file hunks from its second parent0033134123903030d02ba2925ae0d19319a3358b. Current dependencies and all final author fixtures stay byte-identical. The new random-letters module remains present for test imports, unused by the reverted original ID callers; this is an isolated prior-product comparison, NOT a claim to execute the complete pre-PR tree. No author ref or source was changed.

Reproduction commands: git diff 5183b5e9^2 5183b5e9 -- components/funnel-editor.tsx components/inbox-studio.tsx components/page-depth.tsx lib/calendar-sync.ts lib/certificate.ts lib/course.ts lib/creator-invites.ts lib/inbound-mail.ts lib/inbox.ts lib/numbers-links.ts lib/recovery-address.ts lib/short-links.ts lib/two-step.ts, then git apply -R in that private detached copy. git diff --exit-code -- tests confirms no fixture changed.

Six original final fixtures against those old product hunks: calendar-provider7/2fail, inbound-mail46/1fail, inbox34/1fail, random-letters9/2fail, recovery-address47/1fail, two-step49/1fail. Total192 checks,184 pass/8 causal failures. Exact final head makes all192 pass. The page-depth origin-only fixture is not claimed as an old-product RED because main superseded that behavior; its final7 and actual player-origin39 pass.

Independent proof: codex/j-review-2578-uniform-random/8b58852f6877069de21bcda832fa2207abd9a1ea, tests/j-review-2578-random-callers.test.ts. It exercises REAL newCertificateId/newItemId with a controlled Web Crypto byte source, not a copy of the new helper. First draw all255 (outside the equal36-letter partition), next draw all0: final callers return all'a' after TWO draws; prior modulo callers return all'd' after ONE draw. Same file/expectations:4 tests,2 positive zero-byte controls pass/2 tail cases fail in the isolated RED; final4/4. This is deterministic behavioral evidence, not a statistical entropy or OS CSPRNG audit.

## Validation

Eleven ordinary groups: calendar-provider7, inbound-mail46, inbox34, page-depth7, random-letters9, recovery-address47, two-step49, creator-invites52, short-links16, numbers-links18, player-origin39. Total324 ordinary+4 independent=328 passing; no skips. Strict directed TypeScript over all21 changed TS/TSX files, proof and actual imports:exit0. ESLint same scope:exit0. Public-data scanner3645 tracked files/0 corrections; the untracked local reviewer proof is excluded and separately inspected. Actual committed diff003313..5183 and working diff checks exit0.

No browser, actual screen reader, global full build/TSC, native Redis, real provider/account/email, full CI, publication or customer flow certification. The upstream claim of292 groups was not repeated; the numbers above are my execution. No author product/ref/reservation/CI was changed.
