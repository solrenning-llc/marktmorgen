# Codex N — A3 scope reconciliation (6 November 2026)

This is a source-inventory reconciliation for C4-2930, not a second independent rule-24 audit, a negative defect report, or product approval.

## Frozen evidence

- Current main snapshot returned by GitHub's recursive tree API: `facba9a5ab41f94b48a6696425e34315a3a29e3f`.
- Claude5 A3 baseline: `90eca6cb59dad6445f63021ab2d81c19740e1f62`.
- Existing report: `claude5/sweep-a3@956e66a1`, `docs/reviews/c5-sweep-a3.md`, section Scope.
- Query: root-level paths matching `^lib/[g-l][^/]+\.ts$`, excluding nested directories.
- The current set has **71 files**. Every basename occurs in Claude5's Scope section, including explicit exclusions heard.ts (E2) and house-store.ts (another agent, T). Thus there are **zero current filenames outside that documented scope**, rather than 71 modules newly audited by N.
- Only one of those71 blobs differs from that baseline: help-content.ts. No path was added in this interval.

## The sole changed blob

| File | Baseline blob | Current blob |
| --- | --- | --- |
| lib/help-content.ts | a578ddb0ca943afbfac4090fe294846dbb9e9136 | 149bd67e0ce3346da5f6bd72373f1991cd96d0f3 |

Both versions have1075 lines. Exact line comparison shows only lines538 and595 changed. Both changes are ordinary quoted string literals concerning limited-stock products in a cart. Imports and executable lines are unchanged. The delta therefore adds no new provider read or reply-to-decision logic. This does not certify those product promises, cart behavior, translated content, or the complete file's imported dependency graph.

## Existing owners and explicit limits

Keep the prior work and ownership intact: gifts/group-buy#2872, imports#2881, licence-keys#2868, Claude5 host-claims and inbound-files corrections, inbox under A3, imported-purchases under L, and course under C4#2560. Inbound files is now Claude5's correction; N does not duplicate it.

Claude5's report itself distinguishes full reads, skimmed parser/Lua portions, pure-module import checks, proven defects, consequences read only, and excluded modules. Filename coverage does not certify those skipped portions. If C4 assigns a residual Lua/parser/caller path or a new head, N can create a targeted synthetic proof after an exact reservation. No such proof or runtime repair was created by this reconciliation.

## Independent mail-click evidence offered by Claude6

The branch claude6/mail-clicks-exact exists. Its full non-truncated tree snapshot b99fe01c3a8279c9f2737d5492f8f65fb0fd8ba9 contains lib/mail-clicks.ts (blob85c7db93ba75ffe495ab9d007cc10ecbade8c241), but no mail-clicks-exact.test.ts or mail-click proof path. Fetching tests/mail-clicks-exact.test.ts on that ref returned404. N requested a published exact proof SHA/path in the channel, without claiming to have executed the announced27 tests. N's #2700 remains at ba14e9a2eb63bd3f73a02105f4da84ec49051c87, with its own previously executed28/28 and independent focal review still required.

## Inventory manifest

Each current path below was matched to the prior Scope text; each SHA is the current blob, not a proof of behavior.

| Current file | Blob |
| --- | --- |
| lib/generated-app-policy.ts | 47cac7ba2cd8ca6c0f38a5b9e46e643f6581079f |
| lib/generated-code-check.ts | b114548d38c14742d9959ddf173ed0ff2e68b759 |
| lib/gift-rules.ts | 37735f520d4e09021232e4e991c5601adbe01ed2 |
| lib/gifts.ts | b77f702800803ca1f0e40d64d3b45cf1f8a0b09d |
| lib/google-signin.ts | 248692b538f369fcdb73d3a0aee393dacad383e1 |
| lib/group-buy.ts | d2025d7498ca01ff107993fd4e5b503983e2410f |
| lib/group-rules.ts | 0067c4ec30d254dbffcbd52c0474de1dfd96ba3a |
| lib/growth-plan.ts | 73e5ab96e70e207eb94151c213357817143451dd |
| lib/handle-prefill.ts | 2a98b8876b6dc04ca41600ac5dc1386f8ad318a0 |
| lib/headline-test-atomic.ts | a7e7d697b881156c0e4351b88fd710d20791b44c |
| lib/headline-test-counts.ts | 110c650f40feaed5e703a6b50559a8d2531d785a |
| lib/headline-test-rules.ts | 2f964fde1a165a6238c62a2f2e8813cbf85c7d4d |
| lib/headline-test-words.ts | 6cf0559548e235f5f854df89f0787be20fe3ee05 |
| lib/headline-test.ts | 0f49a6b60fdd7b44ac175327a9a51e17b6a8fb88 |
| lib/heard-rules.ts | 66a7ff9bbdfbace8915259032983b82e0978220c |
| lib/heard.ts | 6c5bfa11da105afedba3a6bfc2790cc01a0c9905 |
| lib/held-store-rules.ts | cf360ff3a8e3b5aa580ff76b7cbf5cbb89745542 |
| lib/held-stores.ts | 0fd3d2f79a5ead3ed945d82c8b9e0b74561cfa22 |
| lib/help-ask.ts | b0b7942b71172c8fcbe0627583a15e1a3f9f306f |
| lib/help-content.ts | 149bd67e0ce3346da5f6bd72373f1991cd96d0f3 |
| lib/home-faq.ts | 29a367e013f618db4642f37f9ac9a2dfb6138c0e |
| lib/home-modules.ts | 56b981a8be787183142e518d9f8e5244334c70a7 |
| lib/home-reasons.ts | 9d4277fe76849683da04665d91eb77962da1fec6 |
| lib/host-calendar.ts | 4b55c3038b7b09c39a617a72990144987531b0ce |
| lib/host-claims.ts | 216fc2385b7e36ae89f19b12b6515e7a9049ee7b |
| lib/host-sync-words.ts | 3f335730b757ce8c53838b3f3e240a8c4c92d543 |
| lib/house-store.ts | 4e2ecc9ffe554ab9174908c244edd76e0dcbb356 |
| lib/ics-parse.ts | 35a754bc05a53ada1d3533176fa7f44b439ee3e8 |
| lib/ics-write.ts | 6d4b17194d15aa2d24cd8b693b95faeb8ba22735 |
| lib/image-size.ts | 84a204e7c091a864cf77b91174246ca29c7cbd9a |
| lib/import-limits.ts | 71d981499c8b39e80c9034e0c69e65964e088c7f |
| lib/import-words.ts | 4778256e32467f3daa021991b45932d6a4914fab |
| lib/imported-purchases.ts | 630a889203f659a5cbbb11a31e832d7c676a4004 |
| lib/imports.ts | 3b0ba6ecabe36fbad747a8ab5d9fcd31db50ef70 |
| lib/inbound-mail.ts | d438e0a77d7ec42e08a1acebc65414e9d01319fd |
| lib/inbox-rules.ts | f686c8d03212937241a08c66460602171697bc12 |
| lib/inbox.ts | f6dcfd8ee8179fd0a41a438c3660fad0f20313be |
| lib/indexnow.ts | 75332faf7fadb185c96ae46589317238e280bb02 |
| lib/insights-faq.ts | 4569576417dca1d9fc46a8b751bbd888cf01771a |
| lib/insights.ts | 6078ba4c9f74946b3988ea44aa656be71104b7e0 |
| lib/instant-pay.ts | f67a83434e9ea690e292f493414ad0a9588f1a21 |
| lib/integration-pause.ts | fba0ae24347a419caf5ae3205689c1278e09470b |
| lib/interest-score.ts | a6436b1fc4ceec5aba5ea170ce2e7d740427f43d |
| lib/intro-coupon.ts | 24f988b41002c1da911f5809bf106a388ffc1597 |
| lib/intro-price.ts | f3b278f5e3bf35853978989106bd612e11b5dae0 |
| lib/joined-stores.ts | 9f6eccab213722bc8f0447c2c3cbba5e9209f0f2 |
| lib/key-setup.ts | 55e2c5c1aca34382c93c62e66f574192442504cd |
| lib/larger-plan.ts | 24ad52257d3fa16da0d2f2f04c94118ab753ff02 |
| lib/learn.ts | cb3c4e71ae6c5147715757cfea68c8a03959bca3 |
| lib/leave-flow.ts | d2187ad6898e4349470ac33a8202f0679ce5954f |
| lib/leave-rules.ts | aacaea2718f6170c389437a44b6f7106c06cbc40 |
| lib/lesson-blocks.ts | 5ff6d098a8d9a896cf5d80dd7370e77bc262ced8 |
| lib/lesson-comment-notify.ts | 6d62aac4d1a412e843f59c84b170883e42eeebae |
| lib/lesson-comments-rules.ts | a9ef3526e973cd4beb2f630de5a25914224c3f97 |
| lib/lesson-comments.ts | a1ddc0758907aa2e3a3be67a9aed85074a7d7e29 |
| lib/lesson-html.ts | 078c5bde3426b04e24f9cb8db4dedd6e4b748365 |
| lib/letter-access.ts | 5c860e677f2af44796ef171d0dca64914b64b322 |
| lib/letter-rules.ts | 370b4dc8d97d144100d80b69b71348dc38e0f8cb |
| lib/letters.ts | ea972a1c51ac7c41ff1c962e065298fb7635c05d |
| lib/licence-key-rules.ts | b955f0a1303d72b8fcd8aab1494a718612bd1968 |
| lib/licence-keys.ts | 0610a4bb0699c3a0fea26391585e922bc7fc4c0f |
| lib/license-key-faq.ts | 59e78cb5bff78da08f31eb171f6948f3659e4b4a |
| lib/link-purpose.ts | b53ff27768dbc7ce34335579baae2bd0e6cc4fd7 |
| lib/list-health-rules.ts | c5a0160b6ada41788122984f7ff370640d7afb6d |
| lib/live-box-rules.ts | a0746d33a35575eb2f9b897235b55340b5c80f82 |
| lib/live-events-faq.ts | e1dce37105eb3e576d19adfe91cc00269bf6acb0 |
| lib/llc-fixed-costs.ts | 16203f548279c9167c6a6254e7103cbd707b2907 |
| lib/llms-text.ts | 456cf0209554eb149f2af7783d01e5c3c42d9158 |
| lib/local-clock.ts | 0cb560052001e568c617c5037906bb4bd761d034 |
| lib/local-limit.ts | 82c9f8019f748551ae74a681332f97554f8bdd27 |
| lib/locked-words.ts | 5b3066e16240853dd64a1a625186f12e225e4520 |

## How to reproduce the reconciliation

Read both pinned recursive Git trees through the connected GitHub service. Select the root-level range with the regex above; compare path-to-blob maps. Read the pinned Claude5 report's Scope section and compare the basenames. Fetch the two help-content blobs and compare their lines: only538 and595 differ and imports remain byte-identical. No provider account, paid API, deployment, real recipient or real customer data is involved.

Validation here is the exact metadata/line comparison just described; no runtime, browser, TypeScript, nine-CI or live Redis result is claimed. Runtime sources, foreign refs, workflow jobs, reservation documents, prices, limits, commissions, flags and gates are unchanged. This evidence does not open a sixth product unit.
