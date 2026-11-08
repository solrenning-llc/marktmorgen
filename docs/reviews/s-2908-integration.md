# PR 2908: independent integration focal

Subject: `57351cfc425d242c59127162d5ee74ee039694c2`.
Reviewer: Codex S, at H2's request for another Codex to check the integrated head. Claim 6728391255 preceded source inspection; reservation cff1c0735c641bca9be759ded99aa1a45f2d8fa5 was read back exactly before new proof code/tests. The first reservation write conflicted (409, no write); the retry followed more than 120 seconds and a fresh channel-prefix/delta check.

**No additional finding in the integration. Pode entrar, within this focal scope and subject to the author's fresh required checks and legitimate admission.** This is not a new global financial audit or a current CI certificate.

## Composition

The subject has parents `d0e25631ac037481320ad7de44169a93490c53d5` (reviewed correction) and `cfbd008d84ef2319e22c79925ba537eefb2ae12f` (main at integration). An independent native `git merge-tree --write-tree` of those exact parents exits zero and yields the exact entire subject tree `7819db2cd03b13a593dc2c6ae0e1f6ad522b95de`. No manually resolved additional changes were introduced. Commands and complete outputs/diffs are in `proofs/s/2908/composition.json`.

Two reviewed blobs are byte-identical to d0e25631:

| Path | Git blob |
| --- | --- |
| lib/buyer-profile.ts | fb3c64907fde029bffbd358fc5f7c98b3a8e47a1 |
| tests/f-buyer-profile-paypal-unknown.test.ts | d8e2f0c1745b9843c690e479d07808b04949f6e6 |

The entire three-file change against integration main (217 additions, nine deletions) was read, along with the page-only changes since the reviewed correction. The merged page retains main's single IncludedBytes instance shared by the person lookup and tasks agenda, passing it to addressForPerson and agendaData. It retains main's neutral sales-record failure wording and people-in-your-store agenda text. The reviewed unknown-state behavior remains: no orders plus partial/stripeError gives four dash tiles and explanatory text; the empty list says the reading may be incomplete. The PayPal unknown-amount line and partial notice are preserved. Table/dl/dt/dd markup remains unchanged by this integration.

C4 focal 6711197575 on d0e25631 remains applicable to the preserved reviewed content (CX-122 rule 8). Its prior RED reproduction (25 checks, five failing on 267554a9e) is credited to C4, not executed anew or relabelled as an S RED. No new product change requires an invented RED. The old malformed importedFrom response issue, explicitly disclosed in the PR body in the separately reserved imported-purchases reader, is not silently declared fixed by this integration.

## New execution on the integrated subject

| Unchanged repository test | Checks | Nested MemoryRedis calls | Mock HTTP attempts |
| --- | ---: | ---: | ---: |
| f-buyer-profile-paypal-unknown | 25 | 81 | 0 |
| buyer-profile | 31 | 243 | 7 |
| person-agenda | 64 | 5756 | 0 |
| person-tasks-screen | 94 | 0 | 0 |
| Total passing checks | 214 | — | — |

Imports/scopes overlap; these are not 214 independent system guarantees. Source-only person-tasks-screen executes its checks but performs no Redis/provider work. The permanent test verifies malformed JSON, wrong reply shape, thrown reads, invalid money/time/currency fields, wrong/missing order identities, healthy two-sale totals and page unknown-state wording.

Before each semantic child: 20,000 nested MemoryRedis.run calls counted before dispatch, 100 mock HTTP attempts counted before forwarding, 120 seconds, 512 MiB heap, 256 KiB output. Fetch and sockets deny external network before the graph executes; official aliases and testEnvironment are used. All children completed serially. Maximum per child 5,756 nested Redis / seven mock requests. No cap, budget reset/increase, provider, install or subagent.

Actual scoped strict TypeScript for the three changed roots and their imports passed, lint max-warnings=0 passed, scanner and diff passed; raw outputs retained. Dependencies: 454 installed package versions match the subject lock; zero required missing/mismatched versions. Read-only Node 24.22.1, Next 16.4.5, TypeScript 5.9.3, esbuild 0.28.2, ESLint 9.39.5.

Not performed: browser/screen reader/AT, native Redis Lua, real providers, global MR audit, full build, new RED replay, new hosted CI queries/retries/cancellation, queue or merge. H2's hosted nine-green report is peer evidence and must be checked by the author when admitting; it is not an S observation. Only new own proof/report paths were written. Author product/test/ref untouched; no price, limit, commission, flag, gate, account, terms, supplier credentials/contact, personal data or automation change.
