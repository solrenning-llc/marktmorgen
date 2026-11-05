# Independent review of #2611 — Taiwan VAT documentary evidence

Reviewed head: a197ad34f9c02a67acefb8ca8f96d82ca9feee29.
Reviewer: Codex J. Scope: both complete added files; no author branch, product, reservation or CI changes.

## Result

SEM ACHADO / PODE ENTRAR after the author's nine final successful aggregate checks on this exact head and a fresh clean merge check. This is conditional documentary evidence, with no outgoing-payment execution. It does not select the LLC's tax treatment or establish compliance, a funded cost ceiling, or commercial readiness.

## Primary-source verification on November 5, 2026 UTC

I independently opened all four official pages and their relevant complete FAQ sections:
- [Taxpayer FAQ, May 14, 2025](https://www.etax.nat.gov.tw/etwmain/en/cbec-tax-area/business-tax/taxation-system-intro/q-and-a/wzr6kJ6): the document keeps the no-fixed-establishment/domestic-individual scope and distinguishes service types and location evidence without assigning all customers that classification.
- [Registration FAQ, May 14, 2025](https://www.etax.nat.gov.tw/etwmain/en/cbec-tax-area/business-tax/taxation-system-intro/q-and-a/OgevYEJ): previous/current annual sales, self-registration or agent, authenticated/notarized establishment evidence, authority and translations support the conditional work inventory.
- [Threshold announcement, released/updated December 16, 2025](https://www.dot.gov.tw/Eng/singlehtml/en122?cntId=80053e677d59432e90afbcee3d2bed3c): the April 7, 2025 transition and pre-amendment treatment are preserved. The newer cloud-invoice requirement is not displaced by the older FAQ exemption.
- [Filing FAQ, January 7, 2023](https://www.etax.nat.gov.tw/etwmain/en/cbec-tax-area/business-tax/taxation-system-intro/q-and-a/Gz6MjlP): Q2's supplier/collector distinctions remain unresolved for the LLC. Q6 supports recurring returns even without sales and the illustrative filing period; Q9–10 support currency conversion, fallback and calendar adjustments. Q12–13 support fee and correction work. Q4–5's temporary 2017–2018 invoice exemption is explicitly historical.

The note expressly leaves general record retention unverified; no universal deletion/storage period or actual LLC filing calendar is introduced. Complete compliance cost remains null/null/unreviewed and wholly Marktmorgen's expense.

## Reproduction and verification

- Checked out author RED 8539be81d8b8c6a6edb1b86bd65662115d27ebd5: the original three tests all fail with ENOENT before the document exists. No test adaptation.
- Checked out the exact reviewed head: the same three tests pass. Test blob is byte-identical at both commits: 553b9af8da2aeb494c7514c56d7732bd36ba1bc5.
- All 14 available TX4 evidence tests plus llc-fixed-costs: 59/59 passing. Additional margin-alignment and commercial-llc-costs: 13/13. Total: 72/72, no skips.
- Used the repository's actual test aliases/environment through the normal esbuild/Node runner with TMPDIR=/dev/shm because the shared root disk is full.
- Strict scoped TypeScript checks the actual new test and imported LLC fixed-cost module: exit 0. Focused ESLint: exit 0.
- scripts/check_public_data.py on the exact committed tree, including both added files: 3720 tracked files, zero corrections. Full two-commit diff check: exit 0. Private checkout clean.
- Evidence document blob: dedbb090e8d070fef04db5f98f4982da9451ad96. Canonical imported LLC fixed-cost module blob: 53377bbb7934ff59246cacd1010ca8d937ecc914.

No browser, native Redis, provider, global TypeScript, full hosted CI, deployment or real tax-operation result is claimed. The author retains responsibility for the exact final nine hosted aggregates and expected-head merge.
