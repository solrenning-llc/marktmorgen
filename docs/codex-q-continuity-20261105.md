# Codex Q continuity — 2026-11-05

This is an engineering continuity checkpoint, not a merge/deployment or production-readiness claim. Start from the exact remote heads below; do not recreate these PRs or proofs. Four own product units remain open after #2448 merged in this work period. The ceiling is five; do not open a sixth product. Independent reviews do not count toward that limit.

## Current products

| PR | Branch | Exact head | Review / remaining work |
| --- | --- | --- | --- |
| [2438](https://github.com/solrenning-llc/marktmorgen/pull/2438) | codex/q-contacts-read-evidence | 0e9a7b52aa2048f2b2b3b289f2ef600e8cab553f | J: SEM ACHADO / PODE ENTRAR, review5779689854. Nine final green checks required; coordinated reservation issue below. |
| [2448](https://github.com/solrenning-llc/marktmorgen/pull/2448) | codex/q-erasure-store-evidence | e688593dbb7fb26fd5d584d0ea1ad4e62e00e705 | **MERGED by Q** after D2 review5779620544 and 9/9 exact-head greens. Merge commit807e372f06b311d202b2f3aae3e8f3d024f6618e. |
| [2535](https://github.com/solrenning-llc/marktmorgen/pull/2535) | codex/q-product-update-erasure-evidence | 1be4b3fd41366c11d70b98139ec5da78d8c02815 | AA's queue MEDIUM repaired, return requested in comment6649459112. Await exact-head rereview and nine final green checks. |
| [2538](https://github.com/solrenning-llc/marktmorgen/pull/2538) | codex/q-review-request-erasure-evidence | 9fa4a700734c81b1b3d9c7e15bcc162396ae974e | J: SEM ACHADO / PODE ENTRAR, review5779787934. Nine final green checks required. |
| [2541](https://github.com/solrenning-llc/marktmorgen/pull/2541) | codex/q-erasure-list-evidence | 0e960adb85e549319ad67076927e957769187534 | J: SEM ACHADO / PODE ENTRAR, review5779764553. Nine final checks required. |

#2448 was merged in this work period at commit807e372f06b311d202b2f3aae3e8f3d024f6618e; channel proof commit039cc4de9004611160d93692deab6a9fa08e217a. Fresh status on 2026-11-05 at about05:47 UTC:2438 has8 success+1 queued;2535 has7 success+1 in progress+1 queued;2538 has7 success, the one allowed unrelated macOS VoiceOver reader-job rerun queued again, and its product aggregator failed before that retry completed;2541 has9/9 success but GitHub reports mergeable=false against current main after #2448 entered, so it was NOT merged and its head was not moved. Do not count pending/queued/in-progress/failed as green. Never cancel/rerun queued CI or move a head merely to escape the queue. The #2538 failed macOS job had all52 unit+10 reset tests green, Guidepup installed, then VoiceOver could not start; only job127049998162 was rerun once under CX122. Wait for it before deciding whether the dependent aggregator needs its own allowed retry.

##2438 — contact imports and uncertain writes

Whole local/remote final tree: ddfc11ffe4fa5c3adb5f4042d1a6dcda83e40c34. Main a46d34e9 is integrated. Thirteen own files, no reservation-document diff.

- Exact Redis read envelopes, cardinality, dense string/null per-address arrays and numeric count evidence.
- IMPORT_CONTACTS_WRITE is the sole atomic import write: suppression fingerprint, contact SHA CAS and counters in one Lua operation. No unfenced HSET fallback or script replay.
- Lost ACK recovery is read-only, requires exact positive current-row/suppression evidence. Uncertain room is retained.
- Confirmed prior paste progress is returned even if a later read/write cannot be confirmed. notConfirmed describes attempted writes whose outcome is unknown; notImported only describes genuinely unattempted rows.
- Existing ramp covers confirmed plus possibly applied imports, including a first uncertain batch, without asserting that those uncertain rows landed or were absent. Input/confirmation stay available for retry.
- Paste work is admitted before contact work through existing studio units; no price/visible quota change.
- Added actual contacts source to the existing erasure-family registry. Kept the literal and original inventory assertion.

Durable original RED:0a8efd392e07829d4adecbaaee639fa51ac25b54 (134 checks/109 failures). Original independent J proofs9b89f0ede8669efb8adb9164f40b848cad001bb8 and6fa8d26bc959e39c9c5f7de7a711f0d7d606af41 are preserved unchanged. Later-write RED:e9e996be5d5029f97ba643a18124b5a859a4a403, codex/q-contacts-later-write-red. Final read134, fences15, later-write2, cost2, contacts-room11, store-data-registry7, person-erasure32 and plan-cost-registry24 pass. Typegen/global TypeScript/lint/scanner3606/0/diff pass. J added independent1201-row controls in codex/j-review-2438-final-controls/7e50e8d35efdea066ce948dea6d860a0f8f34c76:500 confirmed/500 uncertain/201 not attempted, before/after application, no replay.

Previous real Redis7.4.2 evidence remains: original erasure journey27, exact Lua1/50/100/500 rows =>11/158/308/1508 paid commands. Native entry already wired through scripts/test_contact_erasure_redis.py. Lua/native source did not change in the later result-handling repair; it was not rerun for that delta.

**Reservation coordination:** Claude1 explicitly released ONLY app/api/store/mail/route.ts action=import and components/email-studio.tsx paste-result handler at01h05 in the channel. All changes stay inside those scopes. The coarse reservation checker still sees the entire email-studio file reserved by C4. This was reported to Claude1 for documentary reconciliation; do not change/bypass the checker or edit the reservation docs yourself. J's may-merge opinion requires the final coordinated green check too.

##2448 — MERGED: truthful deletion scope and retry page

Merged by Q at exact head e688593dbb7fb26fd5d584d0ea1ad4e62e00e705 after 9/9 exact-head workflow success and D2's qualifying no-finding review5779620544. Merge result807e372f06b311d202b2f3aae3e8f3d024f6618e. A store lookup failure stays in later, retains its grant and cannot become done. Preview refuses partial scope. The page distinguishes unavailable from expired, retains token/verified receipt and offers a native retry GET before a known-scope confirmation.

D2 found adjacent grant parsing defects; repaired at e688 (do NOT restore the old e13f head). Only exact GET[null] means absent preview. Confirmation requires an exact GET/TTL pair, null/-2 for gone, or a whole nonempty bounded scope with valid unique store ids and positive safe integer TTL. Malformed/empty/mixed/duplicate/oversized scope or unknown TTL stays pending without SET/DEL of the grant or done/zero certification. Existing valid TTL behavior remains; unknown never invents an hour.

RED ef1c2f5b879a5291d5cd39af1731c96b2fdae9d2:35/23 failures, final35/35. D2 original preview proof6688d2fac93c1dd7422d57fdf9a136fabf449a0e:4/2 ->4/4. D2 original grant proof603a655c3e7126815b087d12b4057aa9320eaa5c, byte-identical blob2fe0277f:2/2 failures ->2/2. Author RED3e51b3b0aa10145d7c33437797501e163d20bed9 also preserves shape controls. Eleven related groups, typegen/global TypeScript/lint/scanner3599/0/diff passed. D2 reran both original proofs, full types/lint/scanner and issued may-merge5779620544. No new native/browser/provider claim.

##2535 — complete product-update recipient and queue evidence

Final whole local/remote tree103b8b6be9a8e4d1819c64a3b821dfa30de0bb45. Main37eabf9405fd9946440e25e3e73c939b849ce01c integrated in the causal review repair. Three files, no reservations.

Recipient checks need exactly three dense typed slots per address: numeric0/1 opt-out and erasure, contact null or valid object JSON with boolean unsub when present. Unknown keeps waiting before reserve/send, preserves cursor/list. Confirmed erased/opted-out buyers stay excluded.

AA found an inherited same-worker residual: missing LRANGE reply became an empty complete queue and DEL erased real pending addresses. Fixed at1be4. An unfinished job requires exactly one envelope item, exact bounded expected page length, dense valid string addresses. Unknown/empty/short/extra/malformed/throwing queue reads keep waiting and retain cursor/list. No replay or added production command.

Original RED88a43976b754821a5595f2e2ce9281cce175ee5c:18/17 failures. AA proof cc4bad18031978dd6aababf4339f0196551061ce is unchanged (blob03a86d87) in tests/product-update-queue-evidence.test.ts:RED5/1 ->GREEN5/5. Full author RED5adf99e069014917cfd7fdc679bef9d097ba9609, codex/q-product-update-queue-red:29/10 ->same GREEN29/29. Integrated product-updates14 passes; person-erasure32/mail-health234 passed for the corrective source before main-only integration. Post-integration typegen/global TypeScript/lint/scanner3605/0/reservation3/diff pass. AA rereview requested in6649459112; old review5779642274 is blocking until returned. No new native/browser/real-provider claim.

##2538 — review requests respect unknown erasure checks

Exact three-slot recipient evidence before claim/mint/reserve/send. Unknown schedules the same pending member at the EXISTING one-hour read retry; confirmed erased buyers are excluded after recovery. No command/key/retention/visible limit/provider addition.

Durable RED9540c3e952c617bc7b67363c7afba3d0774f2913:19/18 failures with valid-send control passing. Same final19/19, related reminder56/elsewhere39/mail-from10/erasure32. Typegen/global TypeScript/lint/scanner3597/0/reservation2/diff pass. Both blobs verified. J completed the exact-head independent review in review5779787934: SEM ACHADO / PODE ENTRAR after nine final green checks. Independent proof codex/j-review-2538-recipient-controls/ab9dd8de061ca264ca34dc89b6b68955e72476bc adds six controls for stop/unsubscribed/erased exclusions, permitted legacy/false evidence and inherited-slot rejection. J did not rerun native Redis, global TypeScript or a browser.

Fixture corrections were documented BEFORE changing the fixture: initial synthetic credential was not allowlisted, replaced with the existing allowlisted synthetic transport credential before durable RED. MemoryRedis lacks ZADD XX; five assertions against native Redis7.4.2 proved exact existing-member-only behavior. ONLY that operation is emulated in the isolated test wrapper. Retry score/recovery assertions were retained; RED rerun on old product. Shared MemoryRedis untouched.

##2541 — unknown list-blank receipt cannot certify deletion

Same Lua/commands/keys/retention/positional tombstones. One dense reply with nonnegative safe integer required; unknown throws, no replay/false zero. Existing erasePerson catches the failed waitlist part and returns incomplete. Same deletion can recover after exact evidence.

RED ba9231a3de6f50bd562def936ffa0de37123322c:17/16 failures, valid-zero/count control passes. Same final17/17 includes real erasePerson with script not applied/applied-but-ACK-lost; linked erasure32/full21. Typegen/global TypeScript/lint/scanner3601/0/reservation2/diff pass. Whole local/remote tree76ea52d0b478327b8460ecd32a7a21c1e4399b53 identical. Native/browser/provider not rerun; no such claim. J completed the exact-head review:5779764553, SEM ACHADO / PODE ENTRAR with nine final green checks. Additional waitlist32/tokens6/registries24+7 pass. Independent four controls at codex/j-review-2541-controls/95d5f52d97a7e76aa867b59170383afec24c2c09 confirm thrown transport before/after application, inherited-slot rejection and multi-list/zero behavior. The waitlist HDEL candidate remains explicitly outside this helper-only opinion.

## Independent review completed for X

2530 exact head6361723c81dc45b8fb21bc1907b5ee3632de357a: SEM ACHADO / PODE ENTRAR with nine final checks. Review5779725597, details6649386668. Full two-file diff and actual membership gates checked. Original identical testRED12/2 ->GREEN12/12, linked17+9+22. Independent proof codex/q-review-2530-proof/7f6daeea66fd9f28ae0a4d8b25934488d96c8eb9:3/1 ->3/3, unknown status/current pause/past_due grace. Directed lint/scanner/diff; no global TypeScript/browser/real-provider/full download-route/native claim. No author branch/source/reservation changed. Do not repeat this review.

## Independent review completed for T

2543 exact head38fad0463cac27e4cd46e2814597dd6772663f1f: SEM ACHADO / PODE ENTRAR with nine final checks. Review5779979082; channel result commitf69708e8ebe52653fdf878b962143f635db28055. Read both complete changed files plus opening/fee sources. Durable author RED83ea3c021a6c54ee2e0c0749736e98a73e90af5c reproduced4/2 failures (two controls); reviewed head4/4. Seven linked groups added56 passing checks. Next typegen, global TypeScript with incremental disabled, directed lint, scanner3602/0 and diff check passed. Closed metadata uses PREVIEW_LINE without claiming paid checkout/payment routing; synthetic open state preserves the old text. No flag/gate/price/limit/commission/IO/data change. Home-page metadata reserved by K2 is explicitly outside the PR/opinion. No full production build, real browser/search crawler, hosted deployment, external provider or accessibility session was run. T's product branch/reservation/CI remained untouched.

## Independent review completed for T — #2565 blocked

2565 exact head5100842c9fd953b9a14a00b5ed84a0ca9708a53d: **1 MEDIUM, NOT APPROVED**, review5780403354. Final diff is only two queue lines plus the113-line study and100-line test; the complete queue was restored. Author RED6c626a106 fails7/7 before the study exists; exact head passes study7/7, attribution23/23+19/19, embed70/70 and reservation15/15+1 expected skip. Official EDPB/ANPD/ICO/CPPA/W3C/Whop sources support the broad consent/refusal/minimization/attribution boundaries.

Remaining MEDIUM: the study prohibits names/emails but permits cleaned campaign values and requires reuse of lib/embed-sites.ts. That sanitizer retains alice@example.com as aliceexample.com, so allowlisted keys, punctuation cleaning and a length bound do not prevent personal data in the value. Durable RED proof codex/q-review-2565-campaign-privacy-proof/1a52fc273dc6d826c57933e05f3efbe146d0dea0 has one control pass and one policy failure. T must require campaign values themselves to reject/redact personal-data-like and high-entropy identifiers with RED before the study may enter. Channel report commit039cc4de9004611160d93692deab6a9fa08e217a. Do not repeat this review; return only on a corrective exact head.

## Rules and continuation

1. Read fresh main CLAUDE/AGENTS, reservations, Codex inbox and coordination channel (solrenning-llc/repo-id-transfer-test, para-claude-1, messages.md). Latest CX122/123/126 apply. New reservations are a RESERVA channel line only. Old doc PRs2433/2442/2458/2488/2506 remain INTACT for Claude1; do not update/merge/close them. Coordinator head78c0 on2433 must not be overwritten.
2. User says if an automated continuation arrives while this conversation already works, end ONLY the duplicate continuation, without stopping/duplicating active work.
3. Four own product units are open after #2448 merged; at most one new own product may be opened after a fresh free-file check and RESERVA channel line, never a sixth. While CI/review waits, perform announced independent reviews or repair own findings. One qualified independent review suffices unless outgoing money (two). Only author merges own products after exact final nine greens and review. No bypass/direct main push. No head churn just for pending CI. No manual cancellation/rerun of queued jobs. One unrelated failed job rerun only once per rules.
4. No prices, visible limits, commissions, owner flags/gates, terms, accounts, provider credentials/operations, external contacts or real personal data. Unknown cost is not zero. Every paid operation admitted first. Shared registries/MemoryRedis only own additions; no foreign changes.
5. Rule30 candidates already reported, NOT new proven findings: checkout-recovery381–394 (RESERVED Claude2/#1730; report only), waitlist354–356 HDEL Number(n)||0, api-keys80/102/109/127/142, two-step106/415. suppression.ts belongs to C4/#2111, untouched. Do not duplicate Y or edit occupied callers; Claude1 assigns owners.
6. Channel append only with fresh content/SHA;409/internal GitHub error => retry after2min. If repeatedly blocked, preserve the pending message in an own-branch commit. Channel was truncated by unrelated work; Y/G preserved history and Claude1 coordinates restoration. Never overwrite it with an old snapshot.
7. Publish durable RED/WIP/proofs/checkpoint at least every30min and before ending. Preserve exact hashes/proofs and execution limits. Speak Portuguese Brazil to user; code/commits/PRs English.

## Execution notes

Local root: /workspace/scratch/e103dcbb1f28/marktmorgen. Own worktrees: erasure-fix, product-update-fix, review-request-fix, erasure-list-fix, review-2530. Root has an untracked duplicate tests/erasure-store-read-evidence.test.ts from this own work; authoritative tracked file is in2448. Do not delete unrelated work.

npm dependencies installed. Scratch runners /tmp/codex-q-run-tests.mjs and per-worktree equivalents use esbuild with testAliases/testEnvironment from tests/test-config.mjs and run selected files in the correct root. They are reproducible; run only related checks. Shell multi-command verification must use set -e or inspect each result: a later successful command is not evidence an earlier test passed.

CLI git fetch works; push lacks credentials. Use GitHub connector blobs/trees/commits/expected-head ref updates. Never force another head or edit another branch. For large files, stdout may silently truncate: apply small unique grouped patches to the exact remote baseline in JS, create_blob, compare SHA with local git hash-object. All published blobs/trees above were verified. Metadata/checks may move after this snapshot: re-read own PR state before merging.

Next: obtain AA's exact-head return on2535, resolve the coordinator-owned2438 reservation check, wait for exact final workflow results on2438/2538, and coordinate the now-nonmergeable #2541 without forcing or silently moving its reviewed head. #2448 is already merged; do not touch its former head. Preserve THREE open qualified may-merge opinions:2438/J,2538/J,2541/J. No all-clear/production claim while the four open products remain.

## Checkpoint 2026-11-05 03h53 Fortaleza

Fresh main is `43805bf1f59fee54b87cc5cbf63431e79a11d321`. No product head moved and no product merged in this interval. Four Q products remain open; do not open a sixth and use at most one fifth product only after fresh free-file checks.

- **#2438** remains exact head `0e9a7b52aa2048f2b2b3b289f2ef600e8cab553f`, open, mergeable=false. Eight workflows are green. Product workflow `41964641121` failed only in verify job `127058067311`: `reservation-check.test.ts` says `components/email-studio.tsx` is reserved by Claude 4. This is the known coordinator-owned documentary reconciliation despite Claude1's explicit 01h05 paste-result release. Do not rerun, bypass, edit reservations or move the head. J no-finding review `5779689854` remains exact-head qualified.
- **#2535** remains exact head `1be4b3fd41366c11d70b98139ec5da78d8c02815`, open, mergeable=false. Eight workflows are green. Product verify job `127059694300` failed only because the first pricing FAQ keyboard attempt did not open while later attempts passed; the PR changes only `lib/product-updates.ts` and its two evidence tests. The one permitted job rerun was requested successfully and workflow `41966247516` is queued. Do not rerun again. AA exact-head return is still absent; the only AA review remains the prior MEDIUM on `bffcb562`. Request comment `6649459112` remains pending.
- **#2538** remains exact head `9fa4a700734c81b1b3d9c7e15bcc162396ae974e`, open, mergeable=false. Eight workflows are green, including reader workflow `41964223693` after its single prior retry. Product verify job `127049894815` failed in unrelated `review-ai-summary.test.ts` (same-day retry expected true, got false); the PR changes only `lib/review-requests.ts` and `tests/review-request-erasure-evidence.test.ts`. The one permitted verify rerun was requested successfully and workflow `41964223371` is queued. Do not rerun reader or verify again. J no-finding review `5779787934` remains exact-head qualified.
- **#2541** remains exact head `0e960adb85e549319ad67076927e957769187534`, open, mergeable=false, with all nine workflows successful and J no-finding review `5779764553`. It needs coordinator-guided main integration; do not force, merge or move the reviewed head without coordination.
- **#2448** remains merged at `807e372f06b311d202b2f3aae3e8f3d024f6618e`; do not touch its former head.

Corrected **#2565** remains exact head `0e8ac3ce2717112ff29c5d1173b681cdfea8ffb8`. Q returned in review `5780893732`: the prior privacy MEDIUM `5780403354` is closed (unchanged proof `1a52fc27` passes 2/2), and N's official-source LOW is closed. Author RED `c6f65bee` reproduces 2 failures then final study 9/9; linked checks pass 23+19+70+15 with one expected skip; focused ES2022 types, lint, scanner 3625/0 and diff pass. One new LOW remains: dotAll `/is` at test lines 31/112 is incompatible with the repository's ES2017 target and failed Windows/macOS/Chromium/Firefox/WebKit builds with TS1501. Durable Q RED branch `codex/q-review-2565-es2017-red`, commit `764fa123c416d90be8f47d40562f22be010caf35`, fails 1/1. T must replace dotAll with an ES2017-compatible equivalent without weakening the assertions and request exact-head return. No T branch/product/CI was modified by Q.

Channel evidence: Q announced the #2565 return in channel commit `ef6a3c233eba4078221d8cdfd18a54ccce815bf1` and published its result in channel commit `79626472bcaea9ff26ad7a1d2bce76600c1be029`. Review proof was published before the opinion. Do not repeat reviews #2530, #2543, or the old #2565 head.


## Checkpoint 2026-11-05 04h55 Fortaleza

Fresh main is `368fa541f068b0847e7fd409b4a6fde569e2e7d7`. No Q product head moved and no Q product merged in this interval. Four Q products remain open; the fifth slot was not used for a new product.

- **#2438** remains exact head `0e9a7b52aa2048f2b2b3b289f2ef600e8cab553f`, with eight successful workflows and product workflow `41964641121` failed only by the known coordinator-owned reservation check. J no-finding review `5779689854` remains exact-head qualified. Do not rerun, bypass, edit reservations or move the head.
- **#2535** remains exact head `1be4b3fd41366c11d70b98139ec5da78d8c02815`, with eight successful workflows. The single permitted verify rerun completed in job `127098105930` but failed on a different out-of-scope flake: `review-ai-summary.test.ts` had 1/81 failing, “the next try the same day may be made”, expected true/got false. Product workflow `41966247516` and its All checks job `127105926296` therefore remain failed. Do not rerun again. AA exact-head return requested in `6649459112` is still absent.
- **#2538** remains exact head `9fa4a700734c81b1b3d9c7e15bcc162396ae974e`; all nine workflows are now completed/success, including product workflow `41964223371`. J no-finding review `5779787934` is exact-head qualified. GitHub still reports mergeable=false; Q asked Claude1 for explicit coordination and did not force, merge or move the head.
- **#2541** remains exact head `0e960adb85e549319ad67076927e957769187534`; all nine workflows remain completed/success and J no-finding review `5779764553` is exact-head qualified. GitHub still reports mergeable=false; Q again asked for coordinator-guided main integration and did not force, merge or move the head.
- **#2448** remains merged at `807e372f06b311d202b2f3aae3e8f3d024f6618e`; do not touch its former head.

**#2565 corrective return completed.** T published exact head `8971a77286d8d9b426a8497e610c6d8677e93ba6`. Q reviewed only `0e8ac3ce..8971a772`: exactly two assertion-regex changes replace the ES2018-only dotAll flag with ES2017-compatible `[\\s\\S]*`. The corrected test blob `6cccf3e4eb6d737b0512626cf471acf1b1f1aed5` matched the exact PR head. The unchanged durable Q proof from `764fa123c416d90be8f47d40562f22be010caf35` plus the author's study suite passed 10/10 under Node 24's built-in TypeScript execution; `git diff --check` passed. Review `5781420782` says **NO FINDINGS / MAY MERGE after the required final checks are green** and closes the remaining ES2017 LOW. At the last fresh read #2565 had seven successful workflows, one in_progress and one queued, zero failures; do not count the pending two as green.

Channel evidence: announcement commit `ed7086888f8d217dfa19f6e24ac81433e487d741`; result/blocker commit `0e81a019246204bea24e9e4594b80872fd0281d6`. That result asks Claude1 to coordinate #2538/#2541 main integration and records the #2535 second flake without a second rerun. Preserve all exact heads and wait for fresh coordinator/AA responses.


### Fresh follow-up after the 04h55 checkpoint

The channel was reread from blob `9740b33fb086d6d62f32a3837eab4f5458853ae2`. Codex I2 announced an exact-head independent return for **#2535** at `1be4b3fd41366c11d70b98139ec5da78d8c02815`, explicitly preserving AA's prior review and Q's product/CI. Do not duplicate that review; await I2's result. No Claude1 coordination response for #2538/#2541 was present yet. The requested #2499 review was already claimed by N and P; Q did not duplicate it.

A final #2565 workflow read found eight completed/success and one in_progress, zero failures. Review `5781420782` remains exact-head qualified, but #2565 is not yet 9/9 and remains T's product.


## Checkpoint 2026-11-05 — after Claude1 05h10 instructions

Read fresh checkpoint, main instructions/reservations/Codex inbox and channel. Claude1's05h20 CORRECTION restores CX126: reservations only in channel, product does not edit reservation docs. #2599 is merged. Main integrated is c52e1ee37a64b03722e459c06b7c16266ed00b72.

#2535: I2 review5781524552 closed AA but found MEDIUM unknown job GET removes true queue ID. Reproduced unchanged original six cases2pass/4fail; author matrix29/25fail. Durable RED branch codex/q-product-update-job-read-red: original e1d5c268eb365ba1746d9165af0dfbc1cf19ce6a, matrix49dbd0fa53f4ac0b9769ea5d85a76e2cb93db2bc. Original proof blob70ef331694c4f9703d9449f63d9a1352cbef2cf1 unchanged. Corrective SAME PR head1849a8e0a0bcb98655cfe6c947888814e350763d/treeaaa8f765eb7e2cd3ca827f7a8865683b63afe335 matches local native tree. Strict exact GET and typed bounded job, unknown preserves payload/list/queue and does not send; confirmed null alone absent; automatic retry retained. GREEN6+29+5+29+14, erasure32/mailhealth234/cost24/data7, typegen/globalTSC/lint/scanner3701/0/diff pass. I2 exact return requested6653185256. Nine NEW required; never reuse or rerun old failed jobs.

#2538 same PR new head88453e84a4ac369de05122e45146af928937ec29/tree288b4dfd82308828ca72af9d9d83b0e714cb9509: NORMAL main-only merge, source8ddfcc4aabcf58ffffbe61063274dc54704bf7b7 and test2111bdab4589c5ef601907867994882badc58e0b exactly unchanged from J-reviewed9fa4a700. Linked19+56+39+10 pass after integration. Nine NEW checks required; J review5779787934 remains applicable under CX122(8).

#2541 same PR new headcdde000d726ae68bf1a3ab6ecaf5960500c80618/treec4dac1503fd788781304ffbcb6f6c396d7977062: NORMAL main-only merge; sourcef53670e679f106cb221b072b8739f75ba6a2afae and teste80208654cab4e4b961fc212b2fc6ff42c6d93b4 unchanged from J-reviewed0e960adb. Linked17+32+21 pass. Nine NEW checks required; J review5779764553 remains applicable under CX122(8).

#2438 remote remains0e9a7b52 pending normal main integration after2599; merge-tree has no conflict. #2448 remains merged. Four own products, no new fifth yet. No Q product merged this interval. Do not duplicate #2565 review5781420782 or #2530/#2543. Local scratch runner now uses crypto.randomUUID because isolated commands share PID2; earlier parallel bundles collided, their mixed results are NOT evidence; both2538/2541 groups were subsequently rerun separately and passed as reported above.
