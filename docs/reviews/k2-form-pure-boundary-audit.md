# Form-family pure and rendering boundary audit

## Scope and provenance

Reservation: C4-2930-CX-179, parent channel receipt c0cc3895. This is a read-only product audit, not a new product PR or a claim that the whole form family is fixed.

Frozen source: main 5c07315505e1d53ee6401021601cd688fa98ecda, extracted at `/workspace/scratch/76b48832dbcf/k2-audit-form-main`. Each of the four audited files was hashed and compared with that exact native Git tree before writing this report; all four matched.

| File | Git blob |
| --- | --- |
| lib/form-deal.ts | 0ed04df64156a359210390540a9449e018907da3 |
| lib/form-response-filter.ts | 519839b1eb28e44f309925a75ca52372a41de5a5 |
| lib/form-response-pdf.ts | 041350383f465dbe639e943c3854db305924208a |
| lib/form-starters.ts | f86358f8900ca315c703b3dd6fcc0ea1b4d5bb1b |

The only written file in this audit is this report. Product code, ACK evidence, configuration, refs, index, PRs, workflows and the coordination channel were not modified. Local helper commands were bounded to 120 seconds; no application or test function was invoked. The pre-admitted productive IO ceiling for this read-only audit was zero Redis commands, zero HTTP requests and zero provider operations. There was no external network access.

## Input contracts and consumer trace

| Boundary | Where inputs come from | Absence or fallback meaning | What blocks an unknown storage or write result |
| --- | --- | --- | --- |
| formDealDraft, form-deal.ts:5–14 | FormDef and FormResponse passed by FormResponseDeal:11–12 from the authorized Forms page | Invalid contact text becomes an editable blank email; unrenderable date is omitted; notes are truncated with an explicit flag | It only prepares a reviewable draft. FormResponseDeal:25 prevents saving when existingDealsAvailable is false; server conversion validates the source again |
| matchingFormDeals and formDealMatchKey, :20–28 | User-editable email plus the CRM snapshot supplied by StudioForms | Blank or syntactically invalid email has no meaningful contact match; an empty acknowledgement key means no matches in the supplied known set | StudioForms:46–62 carries reviewData.available separately. readOpportunityReview, crm.ts:412–452, returns available:false on malformed reads; FormResponseDeal:25 and :49 keep creation unavailable |
| confirmedFormOpportunity, :32–39 | The JSON deal in a conversion response, plus the exact 64-hex source reference | A malformed, incomplete or mismatched acknowledgement returns null; it is not treated as a new link | FormResponseDeal:35–44 first uses crmAnswer(response.ok,data), then requires an acknowledged exact source and state created/existing. Unknowns enter an explicit uncertain/error state |
| mergeFormOpportunities, :43–45 | Refreshed server records plus records accepted by confirmedFormOpportunity | Newly acknowledged records fill only missing IDs; current server records win | The merge is not a database read or a write acknowledgement. The server reader rejects duplicate/invalid IDs; rejected acknowledgements never enter recorded state |
| filterFormResponses, form-response-filter.ts:7–18 | Only already-authorized, already-loaded response objects, client query/outcome strings, and a separately available CRM-link view | An invalid/outdated filter selection disables that optional filter; no current outcome is an explicit supported category | links.available:false does not turn every response into unlinked. It skips the link predicate and retains the loaded subset; FormAnswers:18–21 and :57–67 disable that control and say links could not be checked |
| responseTexts, form-response-pdf.ts:54–64 | A current form definition plus one confirmed loaded response and route-produced timestamp text | Missing optional answers are rendered as No answer.; a missing current outcome is omitted; consent is displayed from the normalized boolean | It does not read storage. The actual download route authenticates export permission, validates identifiers, reads the definition and answers, finds the exact response, and checks drawable text before creating a file |
| wrap, responseDrawable and responsePdf, :25–48, :68–132 | Real embedded font measurements and the ResponseSheet above | Wrapping allocates lines; unsupported characters refuse the download rather than producing boxes | responseDrawable calls canDraw before PDF creation in the actual route. loadFonts, certificate-pdf.ts:63–81, reads local repository font assets and propagates failure; responsePdf does not catch a storage/read failure and manufacture an empty file |
| FORM_STARTERS, form-starters.ts:12–72 | Static definitions and the actual editor's ID generator | Empty form ID, empty completion copy and updatedAt 0 are unsaved draft fields, not evidence of a saved form | FormsEditor opens the draft and the server save route parses it and assigns/preserves its persisted ID. The separate ACK defect is already evidenced elsewhere and is not certified by this audit |

### Details that must not be misclassified as r24 findings

- `formDealDraft` removes unusable contact text from a draft for review. It does not say a CRM opportunity was saved or subscribe anyone to marketing. Its truncation flag is consumed by FormResponseDeal:66, which warns that only the beginning was included.
- A caller fabricating an inherited getter, Proxy or arbitrary malformed object is not a demonstrated path through native response.json(). The acknowledgement boundary still receives untrusted JSON and validates the exact reference, derived ID, title, email and stage. No new failure is asserted merely by bypassing that consumer contract.
- Link filtering is explicitly gated by availability. `refs:new Set()` combined with available:false means do not apply the link filter, not no linked opportunities. Existing tests describe and preserve this distinction.
- Search and outcome filtering may return an empty *selection* of a known loaded subset. FormAnswers:69–77 says Showing N of M loaded answers and No loaded answers match this selection; it does not claim the stored response inventory is empty.
- `wrap` assumes a real font and the positive fixed page width 468 with font sizes 11/12/20 supplied by responsePdf. An artificial width function returning Infinity or an impossible nonpositive page width would not establish a reachable product failure. No such fake-font experiment was executed.
- The PDF module is not wholly pure: responseDrawable/responsePdf load local fonts and allocate/serialize a PDF. They do not perform Redis, payment, mail or supplier operations. No PDF/UA, reader or accessibility certification is inferred from source comments or this audit.
- Malformed persisted FormResponse values that a reader might normalize are an upstream-reader question, not automatically a defect in these typed presentation helpers. The existing readResponses implementation requires an exact envelope and non-null parsed rows (form-store.ts:144–158). This audit does not certify every semantic field of that parser, nor does it recreate the separately owned form-store repair.

## One healthy-workflow hypothesis: a historical removed choice

**Status: static hypothesis only, no severity and no executed proof.** Reported to the parent before any request for additional proof paths. This is not classified as Redis corruption, backend data loss, or a confirmed r24 defect.

`responseTexts`, form-response-pdf.ts:58, substitutes No answer. whenever `answerText` returns an empty string. `answerText`, forms.ts:635–640, returns an empty string when a stored choice ID no longer appears among the current field's options. That differs from an actual unanswered question.

A candidate reachable path uses valid types throughout:

1. Save a form with one choice question and at least three valid options.
2. Save a real response selecting option A.
3. Edit that same form/field and remove option A while retaining two valid options. The editor allows this at forms-editor.tsx:418–420, and the CRUD path at app/api/store/forms/route.ts:44–61 saves the definition without rewriting its answer list.
4. Read the same persisted response ID, whose raw answer remains option A, together with the edited form.
5. The current text formatter may label that answer No answer. because the current definition cannot interpret the historical choice.

A truthful result would distinguish an uninterpretable historical/currently changed choice from genuine absence; it must not invent the deleted label. The same answerText result can omit the question from formDealDraft:10–11 and remove it from searchable display text in form-response-filter.ts:17. These related consequences are static candidates, not additional proved findings.

A proof should compare the same response and raw ID before and after a valid definition edit, plus a genuinely unanswered control, through actual save/read helpers or handlers and responseTexts. The parent is reserving separate proof files before any code is written. No extra test, proof runner or application modification was created by this audit.

## Existing coverage inspected, not rerun

| Existing file | Assertions read |
| --- | --- |
| tests/form-deal.test.ts | Draft contact normalization, note truncation, contact matching and explicit reviewed CRM save with unchanged marketing list |
| tests/form-opportunity-links.test.ts | Wrong/missing source acknowledgements cannot establish links; exact acknowledgements and refreshed records retain stable identity |
| tests/form-response-filter.test.ts | Current labels, accents, outcomes, loaded-subset-only search, formula-safe selected CSV and unavailable CRM-link filtering |
| tests/form-response-pdf.test.ts | Line wrapping, normal and missing answers, PDF structure/tags, multiple pages and authorized download behavior |
| tests/form-starters.test.ts | Static examples survive server parsing with fresh IDs, remain within bounds, ask no sensitive questions, and open unsaved with focus on the name |

No tests were rerun here. Prior successful executions owned by the parent remain their own evidence, not newly counted passes from this audit. The historical-choice transition is not covered by the specific existing cases inspected above: the PDF missing-answer control uses an actually empty answers object, not a retained old option ID.

## Outcome and limitations

No new product fix is justified solely by this read-only audit. The four modules' known/unknown contracts and active consumers are mapped above. One real-workflow hypothesis is queued for separately reserved causal proof. The audit does not close the form-store sibling unit, certify a browser journey, claim a backend loss, or reopen #2857. Product sources remain byte-identical to frozen main 5c073155.
