# Stored form record parsing — evidence only

Source snapshot: main `5c07315505e1d53ee6401021601cd688fa98ecda`, prepared by the parent at `k2-audit-form-main`. The runner selects that checkout explicitly and prints actual source blob hashes. No production code, CI, refs, shared aliases or staging is changed by this evidence.

```sh
TMPDIR=/dev/shm node proofs/k2/form-record-parser.mjs /workspace/scratch/76b48832dbcf/k2-audit-form-main
```

## Contract examined before the proof

`parseForm` explicitly sanitizes editor input and legacy data. It preserves a usable form and drops malformed questions; it supplies optional defaults. Existing scoring tests intentionally expect malformed points to normalize to zero in this pure parser, while the write route separately checks `badPoints`. Those contracts must not be broken by a blanket strict-parser change.

The ordinary minimal legacy record used here omits optional text, outcomes, time and per-question option/default fields. Its two valid questions must remain readable. `form-sensitive` deliberately examines labels narrowly; ordinary questions remain allowed. This proof does not claim a new sensitive-field bypass.

## New question

Does a persisted-record reader reuse that input sanitizer and silently certify a shortened form as complete when one stored question has an impossible label type? The selected responses remain dense, valid envelopes. This is not another outer HVALS/HGET envelope, count, KEEP, drop or identity-binding case.

The real original record has two questions and one saved response containing both answers. Only the selected definition JSON is substituted with a same-id record whose second question has numeric label `17`. The real parser, readers, JSON store stream and CSV HTTP handler execute. CSV owner authentication is an explicit synthetic boundary. Original form and response bytes are inspected separately afterwards.

Controls cover a canonical record and a minimal valid legacy record. A malformed pure editor input is still expected to sanitize, so this proof does not demand changing that parser contract.

The application has a pre-dispatch ceiling of sixty Redis commands per JSON/CSV pair; setup has a separate pre-dispatch ceiling of one hundred commands. Two fixed direct inspections follow each case outside those counters. Local GET URLs are bounded to 4 KiB; the runner has a 120-second process ceiling. Provider fetches are refused and counted. All data and storage are synthetic MemoryRedis fixtures; no native Redis, supplier, production, complete journey or zero-dollar claim is made.

## Result: same 41 checks on both sources

Executed unchanged against frozen main `5c07315505e1d53ee6401021601cd688fa98ecda`, then against the parent-confirmed source of K2 product head beginning `85e32750`. **Each execution: three integration scenarios plus parser controls, 41 checks, four failures and 37 passing.** The four safety assertions and all scenarios were identical; no expectation was adjusted between runs.

| Scenario | Definition JSON substitution | Exported form definition | Saved answers in JSON | CSV |
| --- | --- | --- | --- | --- |
| Canonical | None | Both questions | Both answers | 200 attachment, both columns and answers |
| Minimal valid legacy | One HVALS and one HGET | Both questions, optional defaults retained | Both answers | 200 attachment, both columns and answers |
| Partial stored record | One HVALS and one HGET, same id and dense valid envelopes, second label is number 17 | **Only the first question; no unreadPart4 warning** | **Both answers remain present** | **200 attachment, second column and its answer omitted** |

The four failures require the unreadable forms section to be marked rather than certified as complete in JSON, and the CSV to return unavailable without attaching a partial spreadsheet. This proves a shortened exported definition and an omitted CSV column/answer. It does **not** prove that JSON omitted the second saved answer; JSON retained it under its original field id. Both real stored original records remain byte-identical after each scenario.

Every scenario observes nine application Redis commands under the pre-dispatch limit of sixty, and eight setup commands under the separate setup limit of one hundred. Canonical substitutions are zero; legacy and partial-record substitutions are exactly one selected HVALS and one selected HGET each. The actual CSV handler requests the export permission exactly once from the synthetic owner boundary. No provider call was attempted. Direct post-call inspection comprises two fixed commands outside those counters.

## Proposed classification and repair boundary

**Proposed MEDIUM, conditional portability and veracity.** A structurally malformed stored question is silently sanitized away by a parser whose editor-input contract intentionally permits sanitization. The read boundary then presents the shortened definition as a known complete saved form. The consumer reproductions show the actual loss of a question definition from the JSON copy and of its column/answer from the downloaded CSV, even though the original storage has not changed.

The condition is an anomalous record returned by the selected reads. This is not evidence that healthy Redis changes data, a public visitor can inject the reply, or data was irreversibly erased. It is not a cross-store, privacy-disclosure, provider-cost or authorization finding. No product repair or head move was performed here; independent execution/classification is required before repair.

An eventual repair belongs at the persisted-form read boundary, not a blanket change to `parseForm`. It must reject an unreadable present question instead of certifying a shortened saved definition while preserving the demonstrated legacy records with omitted optional defaults. The pure parser's sanitizing behavior and `badPoints` write validation remain intentional contracts. The ordinary-question `form-sensitive` check is a control only, not an assertion of comprehensive abuse detection.

## Actual source blobs

The runner prints these hashes from the source selected on each invocation. The parent supplied the main snapshot and separately confirmed the current product source anchors.

| File | main5c073 | K2 source85e32750 |
| --- | --- | --- |
| lib/forms.ts | 9d7417785334afa621a40544a279fa13508d9b1d | same |
| lib/form-sensitive.ts | 9a68f05ad3dae70886869069b1d98589a5ca4a38 | same |
| lib/form-store.ts | a54d5798f6e6f78c3d0990af66a459face0ea6d2 | e9571c04bd61c27fa34a6a1ac9e4e6e3e1a9a23d |
| lib/store-export.ts | 8b0190b47af4de021899f84d888ace64990591b8 | same |
| app/api/store/forms/export/route.ts | c234472fae9e817a52cbbca2970c4bbb75ca6e19 | bd67c5770ae6f893aa918f4c20be1bd777a628c8 |

Logs are transient `/dev/shm/k2-form-record-parser-main.log` and `/dev/shm/k2-form-record-parser-2857.log`. The repository test and runner reproduce the cases against either checkout. Runner syntax and directed ESLint of the proof/runner pass. Scoped TypeScript of the actual proof root and real imports passes independently with both selected source roots (zero diagnostics each). Direct public-data scanning of all three new evidence files finds zero corrections; whitespace and final-newline checks pass. These are local evidence checks, not a complete product CI or browser certification.
