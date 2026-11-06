# Codex N second reading and unit 1a review — #2827

Reviewed commit: d43dab11a812b669bfc48226e09d428ae76a67ee.
Date: 6 November 2026. Scope: official text and the pure rules in unit 1a; not the future unit 1b or a global national-law review.

## Official source identity

The official Cellar endpoint was independently reached with Accept: application/xhtml+xml and Accept-Language: en:
https://publications.europa.eu/resource/celex/32023L2673

It redirected to the English manifestation:
http://publications.europa.eu/resource/cellar/ba0121b2-8d8f-11ee-8aa6-01aa75ed71a1.0006.03/DOC_1

Downloaded bytes: 197767. Independently computed SHA-256:
1183c1f775c7fe6f306a7645dd9f485c48731cf4c5e9393184ab919b21513081

This exactly matches the digest in docs/kb9-eu-withdrawal-2026-11-06.md. The entire Article 11a transcription agrees with the official XHTML: 1976 normalized characters on each side, equal after removing HTML/Markdown markup, collapsing whitespace, and normalizing quotation glyphs. All five paragraphs and points (a)–(c) were also read. The EUR-Lex text at https://eur-lex.europa.eu/eli/dir/2023/2673/oj/eng was independently reachable by the web reader; Articles 1(3), 2(1) and recital 37 corroborate the text, scope and application date. No challenge was bypassed.

For the pre-order issue below, the original Directive 2011/83/EU was also obtained directly from https://publications.europa.eu/resource/celex/32011L0083 (English XHTML, 298947 bytes; SHA-256 6e9c0ddd987ff051e2ca291bf04cc7891ec002e04e1e5ea4a00f3ba4845e1b3a). Articles 9(2)(c) and 16(m) distinguish the ordinary contract deadline from actual commencement of performance. National transpositions and the UK's rules were not independently verified.

## Proposed medium finding: scheduled release closes an undelivered pre-order

lib/withdrawal-rules.ts:95–98 shortens the ordinary fourteen-day period to the scheduled release date even when preorder.given is false. Reproduction: paid 1 November 2026 at 12:00 UTC, scheduled release 6 November, still not handed over, checked 7 November at 12:00 UTC. withdrawalWindow returns {open:false,why:'ended'} and submittedInTime returns false. Expected: the ordinary period remains available until 15 November at 12:00 UTC unless actual supply has begun with the relevant consent.

A scheduled date is not evidence of actual supply. Art. 11a(1) requires continuous availability during the applicable period, and the digital-content exception depends on performance beginning. This is a latent rules defect: unit 1a is not wired into a page yet, so no present production denial or money movement is claimed.

Immutable proof: tests/n-2827-withdrawal-rules.proof.ts. Execute: TMPDIR=/dev/shm node proofs/n/2827-review.mjs [source-checkout]. On the reviewed head: 5 checks, 2 failures, 3 controls passing. Controls cover confirmed supply, absence of consent, and expiry of the ordinary period. No I/O, provider, real buyer, artificial Redis receipt, clock race or sleep is involved.

Requested correction: do not use the planned release as proof of delivery; keep the ordinary withdrawal period while given is false and close on confirmed supply when the consent conditions hold. Preserve this proof as a discovered permanent regression test and request a new review on the corrected commit.

## Existing first-review finding

Credit Revisor 1's shipped-item finding: the paid+74-day fallback can close the function before fourteen days after a late receipt. It remains open at this commit. I did not create a duplicate independent finding for it.

## Validation and limits

- Author's kb9-withdrawal-rules: 36/36 passing.
- Related digital-consent: 93/93 passing, after completing the isolated checkout's app/components dependencies; the first attempt lacked those files and was a harness failure, not a product failure.
- Independent delayed-supply proof: 5 checks / 2 causal failures / 3 passing controls.
- The complete three-file PR diff, rules and tests were read. Statement fields, labels, UTC acknowledgement content and the owner's plan/member decisions were checked.
- No author branch, product, reservation, CI, price, limit, flag, account, payment, term or external contact was changed.
- No full TypeScript build, browser, email transport, storage, budget, national-law or complete unit 1b certification is claimed by this pure-rule review.

Conclusion: official-text/hash verification is clean. Unit 1a is not clean pending the proposed medium delayed-supply issue and the existing shipped-item finding. Unit 1b still requires a separate final review.
