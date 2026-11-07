# Independent documentary review — PR #2890 / G2 triage

Reviewer: Codex T. Review date: 2026-11-06 UTC.

## Exact scope and verdict

Reviewed author head `c0a89cec2a703d74fb28b78176116d8a3f7eaa23`, branch `codex/m-lot01-g2-triage`. The changed-filename endpoint confirms exactly one file: `docs/reviews/m-lot01-g2-triage.md`. Its complete returned content is 21,765 characters, 111 lines, blob `10989dfff9cc35dadb80a04b426f36c72eb5cc33`.

Reservation and claim were confirmed by the coordinator before source reading: channel `053d4c523c092c4d082c2fecefe28958a5c1444a`, PR comment `6698610220`.

**No actionable grave/high, medium or low finding established in this bounded documentary review.** The report is an explicitly scoped triage and proposed study contract. This opinion does not certify a scheduler, supplier approval, account authorization, deployment, complete absence of an integration, future profitability, comprehensive accessibility, or merge eligibility.

The author consistently distinguishes missing proof from an unavailable feature and proposed acceptance criteria from implemented behavior (lines 7–13, 30–31, 61–75, 79, 97–110). Unreadable sources do not establish factual falsity. No code repair or additional product requirement is requested by this review.

## Baseline source checks

The document's frozen baseline is `90eca6cb59dad6445f63021ab2d81c19740e1f62`. Repository files below were fetched at that exact commit; the indicated source spans were examined statically.

| Document claim | Checked evidence at the frozen baseline | Result |
| --- | --- | --- |
| Lines 21–22: AI social drafts are editable/copyable adjacent work, not posting | `lib/ai.ts:819–851`, blob `188b7be56a4239e0179112c9071ae247bea4fc6d`; `components/ai-posts.tsx:28–41,59–64,81`, blob `695e8180d2c0e48dc1c5af0d068e688167142933` | `writePosts` uses `counted`; the component requests `/api/store/ai` and explicitly describes editing/copying. No scheduler is demonstrated by these spans. |
| Line 22: existing tests use a model stand-in and do not prove social posting | `tests/product-posts-ai.test.ts:18–25,36–56`, blob `7808f9f9652b445c20e325f7507a1765f9b4a02b` | Source substitutes `fetch`, checks prompt/language, text/link handling and counted attempts. Read only; not executed. |
| Line 23: fixed Path scripts are adjacent work | `docs/marktmorgen-path.md:341–347`, blob `988385f49cdf1cc7a1bd236d2a775a85d25ae1d0` | The cited contract describes local selection and explicit copy, with no additional request, saved draft, schedule or posting integration. This is documentary corroboration, not a new runtime verification. |
| Line 24: profile links do not establish publishing authorization | `lib/store-socials.ts:1–11,16–19,41–43,75–103`, blob `3708274b334bf681b5d8f0166a6287335db7f949` | Definitions and URL normalization concern profile destinations. They are not an OAuth publishing grant. |
| Line 25: current Meta connection requests only `ads_read` | `lib/meta-ads.ts:277–295`, blob `d8a029f40077936a7d403d1c138c22dd39841a52` | `beginMeta` sets `scope` to `ads_read` at line 293. This does not grant content publishing. |
| Line 27: cron names do not prove social scheduling | `vercel.json:3–80`, blob `4ccc6a11f7024f1543d675aa2aa15f6c613ea3ed`; `app/api/cron/shares/route.ts:5–6,10–24`, blob `fe1183288aa709d2fbe388508510e0c73c0275a5` | The configuration lists the shown crons; `shares` imports `COMMISSION_LIVE` and `settleShares`, describing sale-share settlement. It is not a social posting endpoint. No financial code was executed or modified. |
| Line 28: calendar functionality is distinct | `lib/calendar-sync.ts:1–38`, blob `9adc5305ea4448a88dc2d5a7bf7d7408150ff71b` | The cited contract describes importing busy times and exporting booked calls/sessions, not publishing posts. The two additional studio page citations were not independently fetched in this budget. |
| Lines 18–19,25: historical audit and gap matrix | `docs/completeness-audit/lot-01.json:752–759`, blob `174fb192e648b00cefed2e9e545e7c2227eb2b17`; `docs/highlevel-gap-matrix.md:63–65`, blob `e254498104f16a28a8884c70133aa80d66aaafbf` | The lot entry is G2/not started/asks empty/Not audited. The matrix records social planning as a gap and distinguishes drafting/read-only advertising. These documents are historical evidence, not production proof. |
| Line 29: existing integration allowance is not proof of funding a future scheduler | `tests/plan-cost-registry.ts:1244–1251`, blob `b9499f8d0a770804a05c18c48a1b1f3ddd4faf36` | The named integration row covers adjacent services. Its existence does not prove full social-posting costs or a new entitlement. No new cost arithmetic is asserted in the triage or certified here. |

The original author's repository-wide negative searches and historic neighboring-PR file lists were not independently repeated. The report limits its absence conclusions to the examined slice and explicitly requires renewed coordination before further work (lines 13,26,52,57). That limitation prevents treating those searches as a certification of all repository versions or deployment.

## Separately checked supplied main snapshot

The coordinator supplied main `c366e58ab40a1d9c9f4a42f60e62eb0ec1f67a92`. This review does not claim it is the latest main at publication time.

Four files were fetched separately at that commit and have the same blob IDs as the frozen baseline:

- `lib/meta-ads.ts`: `d8a029f40077936a7d403d1c138c22dd39841a52`.
- `components/ai-posts.tsx`: `695e8180d2c0e48dc1c5af0d068e688167142933`.
- `vercel.json`: `4ccc6a11f7024f1543d675aa2aa15f6c613ea3ed`.
- `app/api/cron/shares/route.ts`: `fe1183288aa709d2fbe388508510e0c73c0275a5`.

Only these four source identities are transferred between snapshots. The review does not generalize their equality to the whole repository.

Two bounded requests for historical queue excerpts returned empty content despite a blob SHA. They were rejected as unreadable, not accepted as empty files. Fetching the full multi-megabyte historical queue would exceed the authorized text budget, so the exact queue-at-baseline line anchors remain independently unverified.

A previously loaded complete queue blob `ad7a45131c0db3df283dbf54ed5c85dbefa326a0`, already pinned to supplied main c366 in the earlier metadata audit, was reused without a fresh full read. It confirms G2 at 2735–2739, HL9 at 5919–5922 and cross-checking at 1553/7668. Current-main numeric anchors for the later complements have shifted: the HL9 CSV/recurrence/RSS/alt-text/link-approval complement is at 22308, not 22306. Because the reviewed report expressly pins its citations to the older baseline, this shift alone is not a finding against that baseline. Do not silently rewrite historical references as if they had been verified against main.

## Official documentary checks

Six distinct public source URLs were attempted on 2026-11-06. No operational API, account, token, term acceptance, upload, publication or supplier purchase was performed.

| Official source | Independent observation | Relationship to reviewed claims |
| --- | --- | --- |
| https://developers.tiktok.com/docs/en/content-posting-api-get-started | Readable; last-updated text August 4, 2026. Prerequisites distinguish application approval and user authorization for `video.publish`; unaudited clients have private visibility. Latest creator info is required before direct posting. | Supports lines 39 and 83 without certifying Marktmorgen approval or autonomous scheduling. |
| https://developers.tiktok.com/docs/en/content-posting-api-get-started-upload-content | Readable; last-updated text August 4, 2026. `video.upload` and the user notification/review/completion flow are explicit. | Supports line 84 and the line-105 warning that an Upload identifier is not proof the user completed publication. |
| https://developers.tiktok.com/docs/en/content-sharing-guidelines | Readable; last-updated text August 4, 2026. Relevant sections cover creator info, explicit privacy selection, initially unselected permitted interactions, editable preview/content, express upload consent, disclosure and status observation. | Supports line 93. Whether a particular future scheduled-dispatch UX meets these conditions remains an unresolved design question, as the author says. |
| https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api | Readable official-team collection. Its Facebook Login section lists the four permissions cited at line 85 and requires a linked professional account/Page; the Instagram Login section separately lists the two permissions cited at line 86 among permissions for other uses. Container creation, status checking and publication are separate requests. | Supports lines 85–86 and 91 as descriptive collection evidence. It does not establish minimum grants for every media type, actual app approval, API version, scheduling or timeout-safe recovery. The report expressly preserves those gaps. |
| https://www.postman.com/meta | Readable verified Meta team profile; it identifies its collections/workspaces as official and labels the Instagram workspace official. | Supports provenance statement at line 89. No normative publication date was established for the collection. |
| https://developers.facebook.com/docs/instagram-platform/content-publishing/ | Returned HTTP 429. | Current independent access failure is consistent with the author's stated historical limitation; it does not prove the underlying requirements absent or false. |

The linked TikTok legal text, Facebook Pages references and the separate Instagram Login content-publishing page were not opened in this bounded review. No legal-compliance or full-terms opinion follows. Official pages were summarized, not copied into this report.

## Validation, budget and publication boundary

- Repository reads: 20 operations total: one changed-filename read and 19 file reads, including the two rejected empty queue responses. The nonempty returned repository content totals 520,347 UTF-8 bytes. There were 17 nonempty file responses.
- Public research: six distinct official source URLs; subsequent finds/line openings stayed within those same sources. No additional public source, provider request or paid operational IO.
- The full reviewed document was read. Source checks were static and scoped; no test, runtime RED/GREEN, type check, lint, scanner, build, browser, Redis, CI, margin or accessibility result is claimed.
- No source, author branch, PR head, workflow, reservation file or remote artifact was changed. Formal review and incorporation remain with the coordinator after their own read and the applicable exact-head requirements.
- Under the active freeze, this report is local only. The checkout used to save the one new report has an existing incomplete/recovery index; it was not repaired, staged or committed. No other checkout content was changed.
