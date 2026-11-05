# Independent mechanical review of reservation consolidation #2599

Exact head: c375861643853c5e36c16484196476098bc832be. Frozen base: ee4f8cbb778379760e494c26519616ac57529509. Checked 2026-11-05T08:08:03.036Z. Claim: bd9212aac8fc684761563ea865d9b96dbf4dbf06.

## Conclusion and scope

NO FINDING in this one-file administrative consolidation. MAY MERGE after all nine final exact-head aggregate checks succeed and Claude 1 completes coordinator checks. This is not a review or authorization of any reserved product code, including J's historical entries. No other author's reservation, branch, CI, product or PR metadata was edited. Author/coordinator owns merge and closure of superseded reservation PRs.

## Exact comparison

Target file docs/reservations/codex.md: before blob a38ce96d37439f5a17b8874a40d5561649c62c36, after blob 9d548d151bc26da0416e34aca1b2458674550efa. Read both full blobs, the entire changed content and all 42 source PR file lists/complete additions. All source PRs change reservation documents only.

After normalizing CR line endings, every nonempty old line is an exact prefix of the nonempty new lines, in the same order. All 42 old reservation rows remain, in order; 31 rows are appended, giving 73. There is no blank line inside the final table. No source/header wording changes after line-ending normalization. Native git diff --check base..head exits0; only the reservation document changes.

The 42 source PRs contain 47 distinct added rows. Exactly one already exists in the base, 31 are newly copied unchanged, and 15 are intentionally skipped. All 31 new rows occur in the independently fetched source additions; none is invented or edited. All 15 omitted rows' branches have a merged product PR and no open product PR at the recorded lookup. Two omitted rows belong to the same completed Q branch; that is 15 rows, not 15 unique branches. The duplicate A3 mail-readiness row already occurs twice in the base and remains twice; no new duplicate is introduced.

An initial raw comparison misidentified the last old row because the input ended with a lone CR. Normalizing all CR line endings, including that terminal CR, yields the counts above. No real row loss is claimed from that diagnostic.

The J private commercial-correction row is preserved only as coordinator metadata. Its source branch has no product PR; the actual correction already entered through #2351/cc8. It is not new authorization or an independent approval of J code. J already informed C1 of this historical completion; cleanup remains C1's task.

## Source provenance

| Source PR | Retrieved source document blob | Added rows |
| --- | --- | --- |
| #2260 | 5870c5d3aa0185f98a64a669b8f00e5828abcea0 | 1 |
| #2397 | c646037ea8a93b384119249dc7ee40f08b44dddf | 1 |
| #2400 | c8e69ba9c59d29733fb693420f2075d1cd62a165 | 1 |
| #2412 | b6b820721315c4e5da604404c11444dbc70a718a | 1 |
| #2414 | 1e76fcd5e58740fbe5929d7ce9a2273859f56adc | 1 |
| #2416 | 8208c1a7da601af80f93cd9d43da3cf389d83b71 | 1 |
| #2417 | 70dae5763327cfadecd0d8aa9dc808fd1bb2082a | 1 |
| #2431 | 35463ff8743422bf21a31792f61b4fa9b185ed8c | 1 |
| #2433 | 1e1734b06eaf1d7773dbb0d6ab62ce40e7730497 | 1 |
| #2442 | 73114eeb11f8921abc642e49e587947d890bcabc | 1 |
| #2443 | e6bfbb52102b6d3e3d97291663b4b063692e5732 | 1 |
| #2446 | b6bd0cea8b3e6c6ea2e82bde23b065c5f0feac64 | 1 |
| #2449 | 83d264077571dd46ab54dd28f705798867d6a433 | 1 |
| #2452 | 8bec2f044bffc91d49d7d910b483708eb4506850 | 1 |
| #2453 | f4258d2e85c688697aee468c53407b6ee83fa10c | 1 |
| #2454 | ea3db4e329c78a910149633f90b42d80cc1e992d | 1 |
| #2458 | 34306be909a7559f5ed74c14c89faafa5eac674c | 1 |
| #2463 | 8a98f37e95e585d30a44e14efd731d852ec39f79 | 1 |
| #2465 | ef64cfa7affe5311be56b04d527c82d5a98e8962 | 1 |
| #2466 | 9c5e740850dadc5179ab83e4fbae9a1aa1110cd0 | 1 |
| #2470 | b0a2aa6a4606399ab7dc16609b594873de1d7ff4 | 1 |
| #2471 | 4b55d249a7b3604f585140435815b3623bbbaf39 | 1 |
| #2474 | 9236eb859da0318b16007e3f9a8bea0b2e799895 | 1 |
| #2476 | 3fb50a5e9ab5e868d32beb5bc4f04f42a9bd36a6 | 1 |
| #2477 | a1d8809a084b62a5d9e919bfd40531ba8b7e0e69 | 1 |
| #2479 | 42dbedbab70be96c07db9f8af5cffa78ada195e6 | 1 |
| #2480 | 960517cb8500926d8220ee5132a07f6e48a75e79 | 1 |
| #2481 | 9b1f7abad039d7f9ecac310c1785be58de5b9336 | 1 |
| #2483 | 6874669866fab7b40e5759f30f10eeb130f8b3f9 | 1 |
| #2485 | 7f87baac69c0b3e5c480a8dcec9212419936f8a6 | 1 |
| #2488 | febad453d5c27171b0546390c26ea92e9be10627 | 1 |
| #2491 | a9e66559694df8b1c84f4a95a0e466e3ca5d7855 | 1 |
| #2493 | 4c61e0c36db9c64cc1e5f5a0b2b5c20364ca89ef | 1 |
| #2497 | 4c1b5c13450476b67a27cf0c2622b8b7fa808cac | 1 |
| #2500 | 6bd36adb280af796169ba07dff75d9efec35c7f0 | 1 |
| #2502 | ae492645b3ea14d28f0de06bf435f4b3d9ad188f | 1 |
| #2503 | 0116782b66759bf9fbb26790cfce54cdc87dcae1 | 1 |
| #2504 | 70266eef94593000e94eb0df9d4b11913dfdd773 | 1 |
| #2506 | a7cce2092efa590257b4e64ee6499dd69650eb47 | 1 |
| #2511 | c2357bf6843761a5b5398eaef055b65386e8be04 | 1 |
| #2561 | 12f6de932fe4ac0180f246ef6dcb6edca6f7bd54 | 3 |
| #2592 | 82b03083051b920c71e580c50be2935a8112496f | 4 |

## Omitted rows: independently retrieved branch state

| Branch | Merged product PR | Merge time (UTC) | Open product PRs |
| --- | --- | --- | --- |
| codex/c-tx2-review-proxy | #2423 | 2026-11-05T06:21:38Z | 0 |
| codex/v-summary-review-order | #2489 | 2026-11-05T05:10:07Z | 0 |
| codex/q-erasure-store-evidence | #2448 | 2026-11-05T05:45:19Z | 0 |
| codex/p-course-template-focus | #2456 | 2026-11-05T04:29:10Z | 0 |
| codex/t-home-structured-data-opening | #2467 | 2026-11-05T05:20:13Z | 0 |
| codex/s-stats-note-date | #2490 | 2026-11-05T05:17:52Z | 0 |
| codex/n-sequence-link-attributes | #2407 | 2026-11-05T04:38:42Z | 0 |
| codex/u-access-link-copy | #2457 | 2026-11-05T05:55:40Z | 0 |
| codex/u-french-prompt-punctuation | #2492 | 2026-11-05T05:28:34Z | 0 |
| codex/s-recent-sales-evidence | #2459 | 2026-11-05T05:17:35Z | 0 |
| codex/u-payment-request-receipt-copy | #2505 | 2026-11-05T05:28:37Z | 0 |
| codex/q-erasure-store-evidence | #2448 | 2026-11-05T05:45:19Z | 0 |
| codex/t-competitor-review-clock | #2486 | 2026-11-05T05:52:48Z | 0 |
| codex/n-sequence-draft-link-case | #2420 | 2026-11-05T04:48:25Z | 0 |
| codex/u-update-stop-copy | #2482 | 2026-11-05T05:28:31Z | 0 |

## Limits and policy coordination

This metadata-only review needs no product RED, runtime test, typecheck, browser or provider operation; none is claimed. Targeted public-data inspection and native diff checking concern this document, not certification of the complete hosted tree. No cost, tax, term, price, visible limit, commission, flag, gate, account, payment or external contact changed. CI/research cost remains unknown, never zero.

C1's later channel wording says to put reservation rows in product PRs. J's direct owner instruction in this conversation still says product PRs do not alter reservations. J explicitly reported that conflict in the claim message and will preserve existing #2585/#2594 without reservation edits, retaining the prior channel RESERVA and central coordinator batch. This administrative comparison does not silently reinterpret that owner instruction or certify reservation-parser behavior; the parser repair remains I2's separate unit.
