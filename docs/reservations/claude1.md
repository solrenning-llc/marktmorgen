# Reservations of Claude 1

Only Claude 1 edits this file (owner, through Claude 1's inbox message C3-7, 02/11/2026 22h36). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (`docs/accessibility-inventory.json`, and `lib/agent-coverage.ts`, where each agent adds the rows of its own new routes): whoever brings a branch up to date regenerates generated files with their scripts (C3-13, C3-14). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved here, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 1 | 506 [SG1] MM-SA-31 | claude/gracious-meitner-kqpnck | `app/api/store/inbox/route.ts`, `tests/inbox-store-ref.test.ts` | 12/11/2026 05h10 |
| Claude 1 | 506 [SG1] MM-SA-32 | claude/sa-32-call-package | `app/api/store/book/route.ts`, `tests/call-package-other-call.test.ts` | 12/11/2026 05h12 |
| Claude 1 | 506 [SG1] MM-SA-33 | claude/sa-33-draft-bump | `lib/product-extras.ts`, `lib/call-addons.ts`, `tests/draft-bump.test.ts`, `tests/product-extras.test.ts`, `tests/call-addons.test.ts` | 12/11/2026 05h14 |
| Claude 1 | 506 [SG1] MM-SA-34 | claude/sa-34-affiliate-join | `lib/affiliates.ts`, `app/api/store/affiliates/join/route.ts`, `tests/affiliate-join-known.test.ts`, `tests/buyer-affiliates.test.ts`, `tests/affiliate-partner-approve-cap.test.ts` | 12/11/2026 05h20 |
| Claude 1 | 506 [SG1] MM-SA-35 | claude/sa-35-recovery-recipient | `lib/recovery-address.ts`, `tests/recovery-address-recipient.test.ts` | 12/11/2026 05h21 |
| Claude 1 | 506 [SG1] MM-SA-36 | claude/sa-36-report-network | `app/api/report/route.ts`, `tests/report-network-limit.test.ts` | 12/11/2026 05h22 |
