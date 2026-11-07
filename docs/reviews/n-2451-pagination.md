# N2451: confirmed destination completeness before mutation

Evidence archive only; never merge this root-only tree into product.

Credit: Claude 5 review [6701893342](https://github.com/solrenning-llc/marktmorgen/pull/2451#issuecomment-6701893342), one MEDIUM and two LOWs. This is a corrective replay, not an independent approval of our own PR.

## Exact references

- Before: d09fe010c02a21d27e318180e6672d5a5df1b6f5, provider f9e9030a6d07bb06360421cbfea5195edfe1c3bb.
- Permanent RED: codex/n-2451-pagination-red@523056ec901fe9f8530917f4c7422a61c03b0323, tree07f5944a28e6ea9012bc4770a0ab6793702cb9c6.
- Final: codex/n-email-target-evidence@33577e2d3f61f616718fd35247db1dfbee5be5cd, treeba8eee265773cbe7e575ce612c4ab97d76da5ffc.
- SAME test before/final: a62f5fc264844fcfa03bd7e133bf2be9e96e08b1. Final provider55949ca883fedbb718eb34ef2a5f9f57fcb72fec.
- World e186894b8ff755cb50a5060f2d3fc456220eb761 and config456b8b1abddafa8849b31e0ada33d9ca563e4c0f unchanged. No email-sync.ts/UI/foreign edit.
- Original RED2764d608/109 checks/81 failures retained. The old target test604dd49f remains in d09.

## Results and limits

The same389 checks give116 failures before and389 passing after. The first run's launcher still enforced its historical200000-command ceiling; observed934/822 were below the announced20000. We corrected the launcher to enforce20000 and replayed before/final with identical counts934/822. Tightened replay logs are archived; no assertion or deadline was weakened. No external product request. The permanent world records all provider calls; no extra page, POST or retry is made. A portable launcher with the same fixture mapping/20000-command/120s/256KiB ceiling is included; its packaging adds an explicit512MiB child heap. It was not separately executed after packaging; the reported results came from the local equivalent n-2451-build.mjs with the tightened command cap.

Real connect/testConnection/saveSettings/refreshTargets reject partial, metadata-unknown and malformed responses while preserving sealed config, tags, previous bad marker and real store buyer-consent reference. Controls cover successful selected-target testing, a known complete empty list and changing to a confirmed destination. Present-but-incomplete pages are also conservatively unavailable. An account requiring another page cannot use the bounded picker in this correction; there is no pagination expansion or false absence.

The old109-test fixture now supplies explicit documented terminal-page metadata. Four truncate-to100 assertions deliberately became refusal-of-truncation assertions. Four separate complete-at100 controls preserve order and the existing cap. This is a documented stricter contract, not a claim of old test byte identity.

Linked: email-disconnect-idempotent1, email-platform-faq16, l10b-email-sync18, person-copy-mirror5, service-refusals12, store-allowance13:65/65. Strict ES2017 types3roots/718sources/0diagnostics; changed-path lint0 errors/warnings. Native Git diff-check between full native trees on the two changed paths exits0. Native/API full-tree equality verified, provider read back by immutable SHA. Official public-data scan:2451 materialized tracked files/0 corrections out of a main manifest4157; this is partial, not full-repository/global-build/browser certification. Missing-module preparation and an initial lint CWD error were fixed before reporting final results. Unrelated inherited main whitespace was not changed.

## Official evidence checked 2026-11-07

- [Kit list forms](https://developers.kit.com/api-reference/forms/list-forms) and [pagination](https://developers.kit.com/api-reference/pagination): cursor flags mark earlier/later pages. Both flags must be false.
- [Mailchimp lists](https://mailchimp.com/developer/marketing/api/lists/list/): total_items counts matching items independently of pagination. Add it to the existing fields filter and require exact row count.
- [beehiiv publications](https://developers.beehiiv.com/api-reference/publications/index): first page, total page/result counts. Require one complete first page (zero pages also accepted for a confirmed empty result).
- [MailerLite groups](https://developers.mailerlite.com/api/groups): null previous/next links and first/last-page/result metadata must agree.

No real provider, account or key was used. No productive IO, admission, cost, byte/deadline/redirect bound, retry policy, pricing, commission, flag, gate, reservation document or external contact changed. UNKNOWN cost remains UNKNOWN.

## Pending

Claude5 focal requested at [6702423562](https://github.com/solrenning-llc/marktmorgen/pull/2451#issuecomment-6702423562); its findings are not self-closed. Nine NEW final-head aggregates remain unverified; no CI polling/rerun/merge. One normal product update d09→33577; native parent chain includes the RED. Accessibility uses the existing error region; no new screen/step/decision or AAA/human claim.
