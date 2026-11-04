# Reservations of Codex

Only Codex edits this file (owner, through Claude 1's inbox message C3-7, 02/11/2026 22h36). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (`docs/accessibility-inventory.json`, and `lib/agent-coverage.ts`, where each agent adds the rows of its own new routes): whoever brings a branch up to date regenerates generated files with their scripts (C3-13, C3-14). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved here, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Codex F | 309 [EM1]: email attribution only on the store's served origins | codex/f-mail-link-origins | `lib/mail-links.ts`, `tests/mail-link-origins.test.ts` | 04/11/2026 |
| Codex | CX-29(5): Marketing API default version | codex/meta-marketing-api-version | `lib/meta-ads.ts`, `tests/meta-ads.test.ts`, `docs/meta-marketing-api-version-2026-11-04.md` | 04/11/2026 |
| Codex F | 309 [EM1], CX-85: campaign prototype regression; lib/mail-revenue.ts shared with #2192 by explicit inbox exception | codex/f-mail-revenue-proto | `tests/mail-revenue-proto.test.ts` | 04/11/2026 |

| Codex principal | CX-56(3): prove lost-dispute application fee reversal using pinned dispute list | codex/share-lost-dispute-proof | `lib/share-settle.ts`, `tests/share-lost-dispute.test.ts`, `tests/platform-share.test.ts`, `docs/share-lost-dispute-proof.md` | 04/11/2026 |

| Codex D | 473 [TX3]: exact plain-data threshold snapshots | codex/d-tx3-threshold-evidence | `lib/tax-threshold.ts`, `tests/tax-threshold.test.ts` | 04/11/2026 |
| Codex E | 465 [MR2]: reject discarded customer cost evidence | codex/e-mr2-cost-evidence | `lib/net-margin-rules.ts`, `lib/reviewed-resource-envelope.ts`, `lib/funded-exposure-rules.ts`, `tests/net-margin-cost-evidence.test.ts` | 04/11/2026 |
| Codex C | 465 [MR2]: complete protocol infrastructure profiles | codex/c-mr2-protocol-evidence | `lib/spend-cost-table.ts`, `tests/protocol-infrastructure-cost.test.ts`, `tests/contract-protocol-cost.test.ts` | 04/11/2026 |
| Codex C | 473 [TX3]: serializable own sales evidence | codex/c-tx3-sales-evidence | `lib/tax-sales-counter.ts`, `tests/tax-sales-counter.test.ts` | 04/11/2026 |
| Codex E | 465 [MR2]: complete plan payment dispute cost evidence | codex/e-dispute-cost-evidence | `lib/plan-payment-dispute-cost-rules.ts`, `tests/plan-payment-dispute-evidence.test.ts` | 04/11/2026 |
| Codex C | 472 [TX2]: complete explicit incoming-exchange evidence | codex/c-tx2-exchange-evidence | `lib/receiving-costs.ts`, `tests/receiving-most-correct.test.ts` | 04/11/2026 |
| Codex B2 | CX-86: prevent cross-store plan adoption/refunds; bounded paginated recovery and complete read cost | codex/b2-cx86-platform-plan-identity | `lib/billing.ts`, `lib/billing-sync.ts`, `lib/store.ts`, `lib/plan-closing.ts`, `lib/closing-plan-guard.ts`, `lib/held-store-rules.ts`, `lib/platform-plan-identity.ts`, `lib/platform-plan-rules.ts`, `tests/platform-plan-identity.test.ts`, `tests/platform-subscription-pagination.test.ts`, `tests/released-handle-history.test.ts`, `tests/contract-billing-metadata.test.ts`, `tests/closing-plan-guard.test.ts`, `tests/platform-subscription-search-cost.test.ts`, `tests/subscription-restart-version.test.ts` (identity fixture only; preserve classic/version/idempotency assertions), `docs/cx86-platform-plan-identity.md` | 04/11/2026 |
