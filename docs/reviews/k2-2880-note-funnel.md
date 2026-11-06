# Review of #2880: unread note and funnel parts

Reviewed head: d3977d579754deb1a7ace5abed6a2458980691f6, tree c1fb453b075d16dd991256033f0811f98892b317. Stacked base: c2376695972ef9da567fcb75038683fcb0ca754f. The claim was published before reading the diff/source or executing tests, channel commit 9ffb20b2d34cd8f4a5f67bf400e90a75b6644715. The author requested an available reviewer; no prior claim or review was present.

## Finding: LOW, conditional counted-attempt notice

app/api/store/funnel-share/route.ts:282 chooses the uncounted error solely from action === clone. That is true for an unread source in collectBundle, but not for every read made by a clone. The import counter has already been incremented at line 273 when importBundle calls receiverOf, which reads the destination form inventory before writing anything. After #2857, an unknown inventory raises UnknownReply there. The new catch returns funnel_unread, so components/funnel-share-panel.tsx omits the notice that this try still counts. The counter remains one.

Claude 4 independently announced the same counted-clone LOW in C4-2940-URG-180. Credit is preserved: this report records K2's actual execution and does not claim a separate unique finding or correction ownership.

This is a conditional notice defect, not a charged payment, lost buyer data, write-through of unread input, or authorization defect. No new grave or medium finding was demonstrated in this review. The source and destination are the same synthetic store; the route and MemoryRedis are real. Only the selected read's refusal is injected, matching the two documented exception classes.

| Scenario | HTTP/result | Actual import counter | Pages/funnels made | Functional checks |
| --- | --- | --- | --- | --- |
| Healthy clone | 200/ok | 1 | 2/1 | 7 pass |
| Source funnel unread, before count | 503/funnel_unread | absent | 0/0 | 7 pass |
| Destination forms unread, after count | 503/funnel_unread, expected funnel_unread_counted | 1 | 0/0 | 6 pass, 1 fail |

Reproduce from the evidence checkout against an exact source checkout:

    TMPDIR=/dev/shm node proofs/k2/review-2880.mjs /absolute/source/checkout

The proof retains 21 safety/confirmation expectations and reports the four source blob hashes before executing. It admits at most 10,000 synthetic commands before each dispatch and a 4096-byte body before every request; actual total was 116 commands including setup and post-call observations, four local in-process POSTs, and zero attempted external fetches. The script has a 120-second child-process bound. It does not run a signed-in browser, native Redis, providers or the production application.

The source-stage control initially injected the other accepted exception class. Its transport was refined to use the actual funnel UnknownReplyError while the receiver uses forms' UnknownReply; no case, assertion, deadline or ceiling changed. The final executed result remains exactly 21 checks, one causal failure and 20 controls. The author should track whether the relevant monthly attempt has actually been counted, rather than infer it from the action name, preserve this RED as a discovered *.test.ts regression, and request a focused return. No author file, branch, PR, CI job or check was changed by this evidence.

## Independent executions

The exact author tests were reused without changing their bytes. On a separate exact base snapshot, with only these new tests and their final per-test Next aliases supplied as test wiring, funnel-bundle-reads-exact is 26 checks/15 causal failures and thanks-note-unread is 14/6. On the reviewed head, the same tests pass 26/26 and 14/14. This independently confirms the repaired paths without claiming the superseded 34-case author RED as a new execution.

Seventeen additional related files pass: 594 custom checks in 14 files, plus 44 Node tests in three files (about-thanks-reads-exact 28, funnel-capacity 12, page-copy-unknown 4). Together with the two author files, 19 files/678 checks pass. They include funnel-share, funnel-copy-account, funnel-inventory, funnel-capacity, page-funnel, store-copy, demo-store, both ClickFunnels import groups, forms, thanks-note and funnel analytics/starter/type/step groups. Each group was run once in this review; no already passing group was resumed or repeated.

Actual scoped TypeScript of the seven source/test roots with their real imports reports zero diagnostics; the separate proof root check also reports zero. Directed author-path ESLint, proof/runner ESLint and runner syntax checks are recorded separately. Native base-to-head diff --check passes. Public-data checks are targeted at the changed/evidence paths; no unexecuted full-repository scan, full-suite pass, browser run, hosted nine-check state or complete MR audit is asserted by this review.

## Design and accessibility

The note boundary now mounts a status paragraph instead of an empty editor when the read throws, keeping the existing after-paying heading and section relationship. Confirmed null and a healthy stored note still mount their appropriate editor. No focus movement is introduced. The funnel panel reuses its existing alert and gives a reload next step. These source and element-tree observations do not certify a screen reader, dynamic announcement across navigation, contrast, browser rendering or global AAA conformance.

The source parser now refuses missing, surplus, non-text and unparseable funnel reads; its three existing consumers were inspected. The visitor's funnelHere and hit route retain their existing catches, while collectBundle propagates refusal to the new route boundary. Form refusal still depends on #2857; page refusal depends on #2830. The stack prerequisites and all exact-head CI gates remain the author's responsibility. The already documented readCards gap and schema sanitization are not claimed repaired here.
