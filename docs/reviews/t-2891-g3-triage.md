# Independent documentary review: PR #2891

Reviewer: Codex T. Review date: November 6, 2026 (UTC).

## Scope and result

Reviewed exact author head `b32488a45d0b568059ba4824b688cf1f20f9f0b6`, document `docs/reviews/m-lot01-g3-triage.md`, Git blob `003f2241a0d5d644da1a6613c022a7080979e596`. The complete paginated changed-filenames response contains this one file only; PR metadata reports one added Markdown file, 162 added lines and no deletions. The file and its complete blob were read, including the later requirements increment. Author sources and refs were not changed.

**No demonstrated critical, high, medium or low finding in the reviewed document.** This is a scoped documentary conclusion, not approval of an operational integration, financial model, legal compliance or product availability. The document can receive a documentary review without inventing runtime RED/GREEN. Normal merge remains subject to the coordinator's freeze, independent-review procedure and the nine final-head checks; those workflow results were not inspected here.

Claim `6698609736` and channel reservation `053d4c523c092c4d082c2fecefe28958a5c1444a` preceded source inspection, as supplied by the parent coordinator. This new report remains local; no publication, PR, CI, account, provider operation or channel mutation was performed.

## Historical baseline and frozen main are different evidence

The author's stated source baseline is `90eca6cb59dad6445f63021ab2d81c19740e1f62` (document line 3). PR metadata currently identifies base SHA `1721109f1d2d3930cde6c54f6fe71412648043e3`. Neither is substituted for the separately requested frozen main `c366e58ab40a1d9c9f4a42f60e62eb0ec1f67a92`.

| Inspection | Observed evidence | Qualification |
| --- | --- | --- |
| G3 queue entry, historical baseline and frozen main | Both retain item 41, documentation and preparation of Google Business Profile review replies, disabled pending approval; both retain the cost/approval/storage requirement and the unfinished state. | The report correctly leaves G3 in the queue rather than marking preparation delivered. No queue or audit JSON is changed by this PR. |
| Historical source: external review links | `lib/review-elsewhere.ts` validates supported public review-site links and describes optional links in review-request email. | A link is not a GBP authorization, reader or writer. Its Google Business Profile mention is a comment about an adjacent mechanism. |
| Historical source: Google callback | `app/api/integrations/google/callback/route.ts` branches between sign-in, Search Console and Calendar/meet connection. | Those integrations do not establish GBP approval or authorization. |
| Historical source: internal replies | `app/api/store/reviews/route.ts` calls `setReply` with an internal product/review identifier; `lib/reviews.ts` modifies the internal review object. | This supports the report's distinction between existing internal replies and a future Google transport. |
| Repeated historical search | The report's GBP/client/scope/endpoint terms were searched across `lib`, `app`, `components` and `tests`. The visible match is the external-link comment. Two historical blobs were unavailable locally: `components/creator-card-view.tsx` and `tests/test-config.mjs`. | My replay is **incomplete** for that snapshot. I do not independently certify absence in those two files or global absence in every historical branch. No fetch was used to conceal the limitation. This is a review limitation, not a demonstrated author defect. |
| Repeated frozen-main search | The same terms over the same four directories complete without missing-object errors and find only that external-link comment. | No GBP adapter is evidenced in the searched main snapshot. This is not a claim about later main, all PR branches or production configuration. |
| Snapshot changes | The selected four adjacent product sources above have unchanged paths/content between the author's baseline and frozen main. The cost and store-data registries differ between snapshots. | The report's registry absence assertions remain historical. I do not promote them to an exhaustive fresh financial/privacy-registry certification. |

The complete author document itself explicitly limits remote-branch coverage and real deployment/configuration claims (lines 11-13). Its dated overlap table is historical; this review does not treat the listed PR states as current reservations or authorization to edit those files.

## Official-source checks

Six distinct public official URLs were opened on November 6, 2026. Relevant sections were located within those same pages; no seventh source or authenticated Google API was used. These are source checks, not acceptance of terms or legal conclusions.

| Official URL | What was independently confirmed | Document treatment |
| --- | --- | --- |
| https://developers.google.com/my-business/content/prereqs | Project access requires approval; eligibility includes an established verified profile and website. The page distinguishes zero and 300 QPM approval indicators. | Lines 49-50 do not infer the owner's approval or a Reviews-v4 project quota. |
| https://developers.google.com/my-business/content/pricing | The public page describes no Google My Business API usage charge for registered users. | The report expressly refuses to equate that narrow tariff statement with zero complete feature cost. |
| https://developers.google.com/my-business/content/policies | Authorization, specific consent for automated actions, third-party-access restrictions, temporary secure storage, the 30-day ceiling and disassociation obligations are present. | The report treats topology, compliant concrete design and operating data handling as unresolved, rather than claiming permission from the summary. |
| https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews | The reply body limit is 4096 bytes; modification time and moderation state are provider output. | Lines 87 and 113 require byte validation and separate receipt of a write from moderation/public visibility. |
| https://developers.google.com/my-business/content/review-data | The page warns that `reviews.get` does not currently return reply moderation/violation fields; list/batch retrieval is identified instead. | The report preserves missing moderation as unknown instead of treating `get` success as approval. |
| https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke | Revocation can affect the project's combined grants and client tokens, and complete effects can be delayed. | The report explicitly leaves topology unknown and warns against assuming isolation from another client ID or reporting remote removal from local deletion. |

Other official links in the report, including individual update/list/get/delete method references, were not independently reopened within the six-source ceiling. No contradiction was demonstrated by that limit; the method-specific citations remain identifiable and the requirements are proposals rather than executed calls. Historical update dates and author extraction line numbers are not claimed as stable current DOM positions.

## Completeness, costs and proposed behavior

Document line 5 and the increment at lines 75-79 consistently identify a study/proposal, not a delivered integration. The consent matrix (lines 98-109) does not infer GBP authority from login and ties a proposed action to store, connection, target and exact content. The result matrix (lines 115-126) preserves ambiguous write outcomes, prohibits blind retries, distinguishes provider confirmation from visibility and explicitly acknowledges the absence of demonstrated remote conditional-write/idempotency guarantees. These are proposed acceptance requirements, not claims of implemented protection.

Costs are explicitly missing at lines 25, 63 and 160. No numeric complete-cost calculation, margin, finite customer-base result, funded command ceiling, production entitlement or new platform price is presented. API tariff information is kept separate from hosting, Redis, queues, retries, operations, possible AI and fixed costs. Consequently there is no arithmetic result to validate and no operational-spend approval can be inferred. The future tests at lines 149-158 remain expressly unwritten and unexecuted at line 160.

The data/lifecycle section (lines 128-145) distinguishes transient provider content, secrets, consent evidence, technical state and export uncertainty. It does not call hashes anonymous, local disconnection remote revocation, or local erasure deletion of someone else's public Google review. Concrete retention, export, legal compatibility, topology and cost/admission work remain prerequisites to any implementation. These declared gaps do not make the present documentary addition an enabled feature.

## Verification envelope and remaining limits

- Repository/content inspection: 12 bounded source/document reads (the document file and complete blob; two queue excerpts; four adjacent-source reads; two snapshot searches; two instruction excerpts), plus three local report hash/readbacks and metadata/tree/diff inspection: 15 content reads. One further coordinator document read fits the 20-read allowance. Public research used six distinct official URLs; follow-up location queries stayed within those pages.
- The complete author document is exactly 31,563 UTF-8 bytes and 162 physical lines. Aggregate response bytes were not instrumented, so no exact aggregate is asserted; the bounded excerpts, six public pages and returned text remain below the 2 MiB envelope. Some long tool output was display-truncated. The author document/blob itself was complete; truncation of instruction/search output is not represented as complete coverage.
- No runtime tests, operational provider calls, installation, browser/a11y checks, PII fixtures, legal certification, numerical financial model, CI rerun or changes to author code/refs were performed.
- Two missing historical blobs and unreopened method pages are explicit evidence limits. Approval/credentials/project/profile/production data and subsequent main remain unknown.
- Preserve the current product/operational state. No new implementation, approval application, provider contact, spending, quota change or public promise follows from this review.
