# Historical form choices: PDF feedback

Reservation receipt: `ebcb8ddd3af7cca80fe38e4c03d92bec2111bd70`. Own unit: `codex/k-form-historical-choice-feedback`, based on the existing immutable proof commit `8ac27da109660d09e4a619a7036cc363bdd1480b`. Scope is the creator's PDF text formatter, two new permanent tests and this report. No shared answer formatter, CSV, CRM, studio language catalogue, configuration or original proof is changed.

## Concrete problem and intended behavior

A valid form definition can be edited to remove an option while a retained response still contains that option ID. The existing PDF formatter calls `answerText` against the current definition and substitutes `No answer.` for the empty result. That confuses an uninterpretable saved choice with a genuinely unanswered question. The original real-writer/reader proof preserves the raw record and response identity; this is a presentation defect, not evidence of backend data loss.

The intended local PDF behavior is to retain labels of choices that are still known, then explain any removed choice with: `One or more saved choices are no longer listed in the current form.` If every chosen option was removed, only that explanation is available. No historical label or raw option ID is invented or disclosed. Known choices, plain text, email text, stored numeric zero and genuine absence retain their existing output. Preserving stored zero does not make zero valid in a new scale submission.

## Preflight and provenance

The main instruction snapshot was fetched as `facba9a5ab41f94b48a6696425e34315a3a29e3f`. CLAUDE.md, AGENTS.md, the reservation index, all five reservation files and the Codex inbox are byte-identical to own head85/main91d. The only queue delta contains two entries about the other lane's cart stock implementation. The current channel and main reservations did not announce a competing writer for the PDF formatter. This was a practical preflight of the assigned Forms lane, not an exhaustive claim about all 260 open PRs; a separate broad metadata attempt was stopped at its local time ceiling and is not an ownership certification.

Own #2857 head `85e32750eba464a392874a6d0234766ef1768fb5` remains separate and unchanged. The new detached worktree was created from the existing historical proof, rather than recreating its branch or tests. Dependency metadata matches the exact head85 lock blob `4e0ca0fae6880008b6180e52c22829d519b43738`; installed dependencies are linked read-only from the recovered own dependency directory.

Before the repair:

| Source | Git blob |
| --- | --- |
| `lib/form-response-pdf.ts` | `041350383f465dbe639e943c3854db305924208a` |
| Original `tests/k-form-historical-choice.proof.ts` | `ab62e0e93593a10090e858c0c7d088ef401d8418` |

The original proof, its runner and original report remain immutable. New `tests/form-historical-choice.test.ts` imports and actually awaits that same `auditHistoricalChoice`, asserts that all 25 original checks ran and requires its failure list to be empty. It does not copy the proof's implementation or change its assertions. `tests/run.mjs:24` discovers the new `*.test.ts` files through ordinary `npm test`; its existing aliases already supply the real repository Redis fixture. No alias/configuration edit is needed.

## Canonical RED, before product code

Actual execution against the unchanged formatter recorded:

| Permanent test root | Result |
| --- | --- |
| `tests/form-historical-choice.test.ts` | One Node test fails; it executed the original 25-check audit and surfaced its same two removed-choice failures. |
| `tests/form-response-pdf-choice-history.test.ts` | 13 Node tests: nine pass, four fail. The failures are one removed choice, partly removed choices, all removed choices and twelve missing historical-choice notices in the generated-PDF fixture. |

The nine passing controls cover known single/multiple choices, short/long/email text, stored numeric zero, undefined, an empty string and an empty array. The matrix invokes the actual `responseTexts`. Its bounded PDF case actually invoked `responseDrawable` and `responsePdf`, then loaded the bytes using pdf-lib: **one generation, 17,354 bytes, seven pages, zero HTTP/provider attempts**. Its remaining failing expectation is 12 explicit historical-choice notices, where the unchanged formatter supplied none. The two test roots therefore expose five failing Node tests out of 14, without treating the nested 25 audit checks as 25 additional Node tests.

Warning content is asserted through the actual `responseTexts`; no text was extracted from the generated PDF. The generated-file checks establish local drawability, successful parsing, a structure-tree entry and the stated resource bounds only.

An initial maximum-size fixture incorrectly reused option IDs across questions; the real parser rightly retained only one question. That fixture setup failure was corrected with globally unique question/option/retired IDs before the canonical RED above. No functional expectation, timeout or product limit was relaxed, and that invalid-fixture observation is not classified as a product failure.

The local RED log is `/dev/shm/k2-historical-feedback-red.log`. Compilation uses the actual `tests/test-config.mjs` aliases/environment and real esbuild imports, with separate Node execution of each bundled permanent test. The parent must publish these tests durably before any product repair. At this checkpoint no corrective product code has been written.

RED-source validation completed: actual scoped TypeScript, using the source tsconfig and real imports for the two new test roots, reports zero diagnostics; directed ESLint reports zero diagnostics. The no-emit program disables incremental output locally to avoid writing a cache; the first harness invocation's incremental-option error was corrected without changing repository configuration. The repository public-data detector's `findings` function returned no findings on the three new paths, direct whitespace checks passed, and no-index diff-checks produced no whitespace diagnostics. These are scoped checks, not a full repository run or hosted CI.

## Bounds and meaningful limits

The reused original proof admits four scenarios of 40 application/inspection commands each before fixture writes, with 27 commands actually used in its established baseline. It supplies MemoryRedis transport for real writers/readers; it is not native Redis/Lua or an authenticated HTTP journey.

The additional matrix has zero application-storage commands. It admits one local PDF generation and one parse under a 120-second local command ceiling; generated output must remain nonempty and at most 2 MiB, with one through 16 pages. These are predeclared test-resource bounds, not new customer/product limits. Inputs use the existing maxima of 12 questions, eight options, 160-character question labels and 80-character option labels. Each of the 12 questions retains seven known selections and one historical option no longer in the current definition.

The existing three local TTF assets were checked before execution: NotoSans-Regular.ttf 126,204 bytes, NotoSans-SemiBold.ttf 126,140 bytes and NotoSerif-Bold.ttf 165,240 bytes, total 417,584 bytes. Their TrueType headers were present. `loadFonts` reads the same three files once per server; no new font, URL or provider is introduced.

The proposed warning is 67 ASCII characters and occurs at most once per current question: at most 804 added warning characters plus 12 separators for a parsed 12-question form. This is a textual bound, not a claim that the generated PDF grows by exactly 816 bytes or a financial ceiling. Valid current submissions contain at most eight selected options per question; that ingress fact is not extrapolated to arbitrary legacy stored arrays. No new Redis command, key, persisted field, retention, network operation, price, quota, flag or gate is proposed. CPU/output/hosting costs are not represented as a measured zero.

No browser, assistive technology, provider, account, external service or deployed page was exercised. A tagged PDF can be loaded locally; that does not certify PDF/UA, a complete download journey, publication, customer availability or nine green checks. Main integration remains subject to the coordinator's current holds and exact-head review/CI requirements.
