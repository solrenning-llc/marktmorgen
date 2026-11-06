# Forms help and public-page contract inventory

Reservation receipt: `43fd8b0488cf91b07c28add3ed13a76b92e03e59`. Scope: public statements about the own-page Forms builder, its quizzes, retained answers, CSV, PDF and copying. This is a documentation audit, with product and tests read-only. It does not cover lesson quizzes, developer APIs, commercial terms, money, providers or account operations.

## Sources and classification

The frozen source is main `5c07315505e1d53ee6401021601cd688fa98ecda`, read from the audit snapshot. The corrected comparison is #2857 head `85e32750eba464a392874a6d0234766ef1768fb5`, tree `dc30aced2a753a3c98e4f67d6886c2bfa249d4b3`. Its provenance includes own source `1dafbf5b12f99c2443bb763fda6aa00a842f3307` and main `91d6bb50d98c20990c28d7efc8f09a0c17bfee92`; the pre-documentation union tree is `73cd899f3585cf7a382ceb8d945881a7760ffab5`. The parent supplied the GitHub/native verification of these identities. This audit did not obtain that head through a missing local Git object.

Local Git-blob hashes were recomputed from file bytes, without writing Git objects:

| Path | Frozen main | Corrected comparison |
| --- | --- | --- |
| `lib/help-content.ts` | `a578ddb0ca943afbfac4090fe294846dbb9e9136` | Same |
| `lib/feature-pages.ts` | `120c485b1055771ec4480f707efe798510e0c8a0` | Same |
| `lib/forms.ts` | `9d7417785334afa621a40544a279fa13508d9b1d` | Same |
| `lib/form-store.ts` | `a54d5798f6e6f78c3d0990af66a459face0ea6d2` | `e9571c04bd61c27fa34a6a1ac9e4e6e3e1a9a23d` |
| `components/forms-editor.tsx` | `d38fe5553e45b3e214a7f46ceb5052bd218940a7` | Same |
| `components/form-answers.tsx` | `6feaa4a8c13a0eacf864035ba1220bf9d687167e` | Same |
| `app/studio/forms/page.tsx` | `c517bce11636451eba9e81aa31d91f14268256a2` | `fa20aaa7668cfe419aeb9b4531e62849211857cd` |
| `lib/store-export.ts` | `8b0190b47af4de021899f84d888ace64990591b8` | Same |

The labels below are deliberate:

- **COMPROVADA**: a named executable proof actually ran, with its result and limitations identified. It does not certify every related public sentence.
- **SOMENTE LEITURA**: a public statement is linked to inspected source and existing tests. Those tests were not rerun by this documentation unit.
- **HIPÓTESE**: an unresolved wording or presentation question, without a new reproduction, severity or fabricated failing test.

Line references below use frozen main unless the corrected comparison is explicitly named.

## Where the public words appear

`app/help/page.tsx:9` imports the canonical help collection; lines 70 and 93–95 render its sections and paragraphs. The relevant question is `lib/help-content.ts:857`, “Can I add a form, a survey or a quiz?”. `helpAnswer` at line 1070 shares an existing canonical answer and rejects a missing question; it does not itself validate capabilities.

`app/platform/[slug]/page.tsx:4,34` resolves a topic through `findPage` and renders `TopicPageView`. `lib/site-pages.ts:16,92` incorporates `FEATURE_PAGES`. The Forms feature occurs on the `funnels` topic (`lib/feature-pages.ts:1224,1269`).

## Claim-to-source inventory

| Public claim | Source binding | Existing evidence inspected; classification |
| --- | --- | --- |
| Forms provide short/long/email/one-choice/many-choice/scale questions, optional or required; 12 questions, eight options, 20 forms (`help-content.ts:859`). | `forms.ts:51–54,85`, parsing at 249 onward and `readAnswers` at 369; the page Form block selects a definition. | `tests/forms.test.ts:35–64` checks valid kinds and submitted-answer validation; `tests/form-capacity.test.ts:12,16,28` exercises the atomic form count and editing at capacity. **SOMENTE LEITURA**. No exact help-copy test for these numbers was found in the inspected family. |
| A vote quiz has up to six results, most answers wins, first result wins a tie, with an optional product and onward funnel navigation (`help-content.ts:860`). | `forms.ts:54,426`; submit handler `app/api/store/form/route.ts:77,94–101`; result page `app/[handle]/form/[form]/page.tsx:54–57,66–74` uses the selected result and optional product. | `tests/forms.test.ts:70` covers vote results; `tests/form-branching.test.ts:56–60` includes the tie rule. Existing submission tests cover routing, but this audit did not run a complete visitor journey. **SOMENTE LEITURA**. |
| Scoring uses whole nonnegative points through 100, up to four categories, exact coverage by result ranges, no scored answer means thank-you; score/result are stored and exported (`help-content.ts:861`). | `forms.ts:64–65,495`; submit handler lines 78–90 stores a measured score only when a scored question was answered; CSV builds score/result columns in `responsesCsv` at 664 onward. | `tests/form-scoring.test.ts:79–118` covers points, categories, no-score, range boundaries, gaps and overlaps; the same file contains stored-answer and export coverage. **SOMENTE LEITURA**. Workflow result targeting is inspected at `lib/flows.ts:290` and `lib/flow-review.ts:34`, not newly exercised here. |
| Branches go only forward or end; skipped questions are neither required nor kept; a terminating result can decide the quiz (`help-content.ts:862`). | Branch parsing and answer traversal in `forms.ts`, consumed through `readAnswers` by the real submission handler. | `tests/form-branching.test.ts:32–58` contains the exact forward/backward, skipped-question and terminating-result behaviors. **SOMENTE LEITURA**. |
| Retain the newest 2,000 per form, display the newest 50, download all retained answers as a spreadsheet (`help-content.ts:863`). | `forms.ts:73` defines retention; `form-store.ts:94–97` prepends and trims from the oldest end; `readResponses` at 144–149 defaults to that retention. `form-opportunity.ts:8` defines 50 and `app/studio/forms/page.tsx:26,62` uses it for the displayed set. CSV handler `app/api/store/forms/export/route.ts:20,25–29` reads the retained set and returns an attachment. | `tests/form-person-room.test.ts:46–75` exercises a full retained list and a deletion race; `tests/forms.test.ts:74–75` checks real CSV words/result/consent columns. **SOMENTE LEITURA**. This is not a claim that all submissions ever received remain available. |
| Joining the list is optional, the box starts empty, and joining requires the emailed confirmation button (`help-content.ts:863`). | `app/api/store/form/route.ts:85–88` requires `offerList`, explicit `consent === "yes"` and an email before `askToJoin`; `lib/store-join.ts:72` identifies the request as emailing confirmation, without directly joining. | **SOMENTE LEITURA**. No email was sent and no provider, account, consent UI interaction or full confirmation journey was executed in this audit. |
| Sensitive questions must not be asked (`help-content.ts:863`). | Existing sensitive-field validation rejects unsafe definitions at save. | `tests/form-sensitive.test.ts:20–47` inspects detection, save rejection and editor explanation. **SOMENTE LEITURA**; this audit does not claim arbitrary sensitive-data detection. |
| Sharing a funnel transfers definitions, never its form answers (`help-content.ts:834`; `feature-pages.ts:1265`). | `lib/funnel-bundle.ts:70,593` models/imports the definition; `lib/funnel-bundle-store.ts:46–52,130` collects/imports forms. The transferable form schema contains no response list. | `tests/funnel-share.test.ts:188` checks creation of a form while importing a starter. Its assertion alone counts created forms and does not independently establish a zero response list. Other bundle/copy tests are antecedents, not new runs here. **SOMENTE LEITURA**. |
| A whole-store copy includes form/quiz questions and no answers (`help-content.ts:843–844`; `feature-pages.ts:2311`). | `lib/store-copy.ts:343` writes copied definitions, rather than copying response lists. | `tests/store-copy.test.ts:193` explicitly checks the copied quiz definition and a response total of zero; lines 210–214 inspect excluded records. **SOMENTE LEITURA**. |
| A creator's main-data export includes forms and their answers (`help-content.ts:419`; the form clauses of `feature-pages.ts:820,2608`). | `lib/store-export.ts:122–124` constructs `{ form, answers }` from real readers. In the corrected comparison, unavailable reads reject and the stream marks an unread part at lines 147–148. This is a different operation from copying a store or sharing a funnel. | `tests/help-export-promise.test.ts:23–40` is an exact textual contract for the export paragraph and its inclusion words, rather than a full runtime export proof. Corrected `tests/k-form-store-sibling-shapes.test.ts:76` checks an unread forms section. **SOMENTE LEITURA** here; any earlier passing run belongs to its identified owning unit. |

## CSV and PDF scope

The dedicated Forms FAQ at `help-content.ts:857–863` explicitly promises a spreadsheet. It does not explicitly promise a PDF. Other public PDF references concerning product files or course certificates cannot establish a Forms PDF promise.

The studio does expose real PDF functionality: `components/form-answers.tsx:100–101` offers “Download as PDF”, with a response identifier; `tests/form-response-pdf.test.ts:99–105` covers stored-response identity, refusal/missing responses and a generated download. This is inspected existing evidence, **SOMENTE LEITURA**, not a new browser/PDF execution or a PDF/UA certification.

The all-retained CSV link is `components/forms-editor.tsx:249–251` (“Download all answers”). The local filtered CSV explicitly uses only loaded responses: `components/form-answers.tsx:21,29–33` filters `latest`, and its filename includes `shown`; line 43 labels its search “Search loaded answers”. `tests/form-response-filter.test.ts:35–39` checks that subset export excludes unselected responses. These scopes should remain distinct when assessing “all”.

## Proven presentation issue and unresolved hypotheses

**COMPROVADA — historical-choice interpretation, not backend data loss.** Separate immutable proof commit `8ac27da109660d09e4a619a7036cc363bdd1480b` contains `tests/k-form-historical-choice.proof.ts`, `proofs/k2/form-historical-choice.mjs` and `docs/reviews/k2-form-historical-choice.md`. Its actual frozen-main execution recorded **25 checks: 23 pass, two fail**. The real definition writer removes one option while retaining two; the same persisted response and raw answer remain intact and are returned by the real reader. Actual `responseTexts` nevertheless labels that retained, currently uninterpretable answer “No answer.”, matching a separately stored genuinely unanswered control. Restoring the option ID with a current label makes that current label visible. The safe expectation is an explicit changed/uninterpretable-answer notice; an unavailable original label must not be invented.

That earlier proof ran direct modules with the repository MemoryRedis fixture: 27 application/inspection commands within four pre-admitted 40-command scenarios, a 120-second ceiling, and zero external/provider/HTTP calls. It did not run a browser, native Redis/Lua, authentication handler, or generated PDF. Its result is reused here without rerunning it. The two failures do not establish a separate false public PDF claim.

**HIPÓTESE — wording and retention.** The `funnels` feature at `feature-pages.ts:1269` says “Every answer is kept for you, as a file too” without repeating the explicit retention qualifier from FAQ line 863. Static inspection establishes the contrast with the 2,000-response retention policy; this audit did not execute an overflow scenario tied to that public sentence or decide how a reader interprets its context. No new RED or severity is assigned.

**HIPÓTESE — historical choices in CSV.** `forms.ts:639` cannot resolve an option removed from the current definition, and `responsesCsv` at line 676 uses that same `answerText`. The historical proof above executes `responseTexts`, not CSV. A blank historical choice in a downloaded CSV is therefore a call-graph hypothesis here, not an executed CSV result. It must not be reported as proven export loss.

## Corrected unavailable handling and limits

The public Forms/help text is byte-identical in frozen main and #2857. The corrected source distinguishes unavailable form/answer reads from a confirmed empty collection; its real-page/handler fixtures are in `tests/form-response-unavailable.test.ts:15–22,53,81–109`. The corrected email page reuses its form read, reports unavailable choices and prevents unsafe sequence setup (`app/studio/email/page.tsx:65,93,234,292,303`). These are source bindings, **SOMENTE LEITURA** in this unit; they are not a fresh assertion that #2857 has passed CI or an independent review.

Lesson quizzes in the separate `quizzes-and-certificates` topic (`feature-pages.ts:1582`) are not the own-page Forms quiz. The store inbox/contact form is also distinct. Developer/API auditing belongs to another reserved lane. No finding is manufactured by applying these features' rules to one another or by passing impossible typed inputs with no real consumer.

## Work actually performed

This unit performed targeted local source/test reads, claim searches and Git-blob hash calculations, then wrote only this report. It ran no product tests, historical proof, browser, application HTTP, provider request or CI; existing suites listed above were inspected rather than rerun. Only the dedicated historical proof has an executable result reused under **COMPROVADA**. Other earlier passing evidence remains attributable to its original owning unit, not a new execution of this documentation audit.

Validation actually completed for this report: the `findings` function from `scripts/check_public_data.py` returned an empty list on this exact path, and the direct trailing-whitespace check found no lines. `git diff --no-index --check /dev/null docs/reviews/k2-form-help-contract.md` produced no whitespace diagnostics; its status was 1 for the newly added file, not a zero-exit claim. The report ends with a newline. The targeted detector intentionally covers this new report without staging it or claiming a fresh full-repository scan.

No product, library, test, configuration, index, Git ref, reservation file or remote channel is changed by this unit. This inventory alone does not certify a complete journey, deployment, accessibility conformance or nine green checks.
