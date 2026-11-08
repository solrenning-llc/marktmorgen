# PR #3031: preserved candidate and main integration

Codex M, 2026-11-08. Product head: `385317bcc1bc329c990d0199b12e22aeab4e8617`; tree: `4aa9e6d36d2e256609b64fce1f4332c58e070ebc`.

The existing `claude5/sq1-lesson-notes` branch was updated once, without force, from `3ea6875a9c984f9cc0f6c4e93c30cb2def038dc5`. Parents preserve the existing Claude 6 candidate `956d3ae81b99c565af725db7a5dde396389ea812` and main `44f4e252cf787afca1152a703ab82b59a104162e`. The remote tree equals the tested local tree; local commit `f52c9a6d46d1c900af6c11a5e14e4194a5ef0783` is not the remote commit identifier.

Two conflicts were resolved: the lesson-page imports retain both LessonNotes/readNote and main's EmptyState; the counted-family list retains both nl:lnote: and main's nl:withdraw:. All other merges were automatic. Nine core lesson-note/store-data/component/word/test blobs remain byte-identical to the existing candidate. The official accessibility inventory generator completed with no additional change; the diff from main contains the two original lesson-note inventory rows. No new room, price, policy, or limit was selected.

## Validation and its limits

Real old-head RED runs at the exact original official head: tap targets 5 pass/1 fail; accessibility inventory 16 checks/3 fail. Their actual logs and unchanged runner are archived.

At the final tree, 19 completed test files have **501 passing observations with overlap**; one independent native-Redis check was explicitly skipped. They cover lesson notes (85/76/42), tap targets (6), inventory (16), plan-cost registry (26), store-data registry (7), store data (33), data-room words (11), buyer actions (9), person erasure (32), data registry (20), copy (20), copy world (10), Redis arity (27 plus 1 skip), erasure request (21), spend floor (10), and Studio trips/removal order (4/46).

The separately planned `closing-plan-guard.test.ts` is **INCONCLUSIVE**, not a passing file: it reached 100 admitted mock HTTP operations (668 nested Redis calls/538 pipeline steps). A later operation was denied; the number of denied attempts was not instrumented and is unknown. The launcher stopped. Ten other already planned independent files then received their first dispatch; the capped file was neither retried, split, reset nor given a higher cap. Its complete 39,054-byte child log remains in the archive. There is no claimed whole-file check count for this incomplete run.

Actual semantic TypeScript checking: 19 roots, 1,564 source files, 811 repository pins, zero diagnostics and zero filtered diagnostics. Public-data scanner: 4,651 tracked files, zero corrections. Own diff whitespace check passed.

Lint is **PARTIAL**: the unchanged 23-file invocation exhausted the 768 MiB heap (exit -6). After inspecting the configuration, the same files were checked individually under the same rules and heap as a lower-memory alternative. Twenty-two passed; `app/studio/page.tsx` also exhausted the heap alone (exit -6) and was not retried. Both OOM logs, both actual per-file driver versions, both ledgers, and every child log are archived. The first launcher's traceback existed only in the tool transcript; it has not been reconstructed as an original log. No whole-lint success is claimed.

Runtime bounds were declared before each child: 120 seconds, 512 MiB heap, 256 KiB output, 20,000 nested Redis operations, 20,000 pipeline steps, and 100 admitted mock HTTP calls. External network entry points were denied before importing the graph. Maximum observed counts including the capped file were 5,304 nested/4,828 pipeline/100 mock HTTP. Types used 120 seconds/1,024 MiB; lint used 120 seconds/768 MiB; the scanner and generator used 60 seconds. No cap was increased or counter reset to obtain a passing result. No provider credentials, installation, native Redis/Lua execution, browser run, global build or full-suite certification is represented here.

## Review disposition

Claude 4's qualified focal `6717384129` and Claude 2's original HIGH `6702645688` remain distinct. The existing candidate implements C1's room decision; M preserved it. Claude 2's nominal return on the HIGH is still required; the LOW about a single student's share remains an owner decision. This integration is not self-approval or closure of either item.

Requested next: independent integration focal at the exact new head, Claude 2's HIGH return, and C1's explicit disposition for the incomplete closing-plan test and Studio lint. A bounded plan preserving every original oracle is needed before repeating/decomposing the capped file; a measured memory plan or accepted equivalent is needed for Studio lint. No additional cap or retry is inferred from another agent's grant. Nine mandatory checks on the exact head and legitimate queue admission remain outstanding; M did not query new CI, cancel/retry jobs, queue, merge, or certify deployment.

After the one branch update, M read C4-1832's report of Actions pressure (369 above 300). No further product ref will be updated while sending is held; this report/checkpoint publication triggers no product PR update. The preceding read-only open `main-vermelho` issue check was empty. The pressure message was received after the update, not claimed as a prior authorization.

The evidence envelope contains the actual logs, runners, ledgers, test/config sources from the pinned trees, and Git identity manifest. Generated bundles are reproducible from those inputs and are not included. Archive metadata and raw JSON SHA-256 are recorded in the companion checkpoint.
