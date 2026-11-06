# Unknown form-response reads become confirmed empty results

Codex K2, C4-20261106-1710-K2-101. Snapshot main
`ffb354bc30a15d05030998d363c53a642570d8bb`, 6 November 2026.
Reservation before proof: channel `28d3c6015da9683beca0ca861ff57add1116b9e3`.

## Reproduced finding: LOW, unknown presented as known data

The real `readResponses` in `lib/form-store.ts:144-153` converts unknown
LRANGE results to an empty array, filters unreadable rows, and converts
unknown LLEN results to zero with `Number(total) || 0`. It also accepts
negative/fractional counts and ignores incomplete or extra pipeline results.
No stored answers are erased by this proof.

The permanent discovered test calls the real function and parser, replacing
only the existing Redis pipeline boundary. Sixteen cases make one existing
two-command LRANGE/LLEN call each, with a ceiling checked before returning.
Confirmed empty and confirmed answer controls pass. Fourteen unknown cases
return a successful result instead of explicit UnknownReply: missing/extra
results, unknown list, unreadable/mixed rows, and unknown/invalid count.
Result: **32 checks, 14 causal failures, 18 passing assertions/controls**.
No expectation was changed to the observed successful result.

Examples: missing results and null LRANGE become `{responses:[],total:0}`;
mixed valid/null rows become one response with total two. Negative and
fractional counts remain negative/fractional. All cases stay within the
existing read; no write, deletion, provider, account or new storage exists.

## Consumers and corrective boundary

Static consumer inspection: `app/studio/forms/page.tsx:62` passes the result
as SavedForm total/latest; CSV export uses responses directly; response-PDF
looks for an answer and otherwise says it is no longer kept. Person-copy
and store-export also read responses. This proof does NOT execute those
pages/routes or certify their final HTML/status/export contents.

Proposed correction: exact two-result envelope, readable list throughout,
native nonnegative integer LLEN, explicit unknown on unreadable evidence.
Preserve known empty, valid records, chronological order, optional legacy
fields, existing IO/ceilings, privacy and mutations. The callers need an
honest unavailable state rather than a fabricated zero or an unhandled
page failure. `app/studio/forms/page.tsx` is occupied by open #1969 in the
fresh 148-PR inventory. Coordinate that integration with C4 before changing
the reader's error contract; do not edit the other author's file.

Related same-file static candidates, not separately proved: readForms,
readForm, responseCounts, addResponse/dropForm receipts. Report to C4;
this evidence does not authorize or implement those corrections. The
independent lib/flows.ts candidate remains assigned to Claude 3.

## Scope and reproduction

Only this report and `tests/k-form-response-read-evidence.test.ts` change.
`lib/form-store.ts` remains byte-identical to snapshot blob
`2ea0e6ea96f864b79b9a5f9752098827f40589c3`.
The test is discovered by tests/run.mjs and uses existing testAliases and
MemoryRedis; RED exits nonzero intentionally. Actual scoped TypeScript
including imports has zero diagnostics. No browser, native Redis, actual
provider, complete journey, production, data loss or global AAA claim.
No paid-operation/zero-dollar-cost claim; the fixture is entirely synthetic.

## Corrective implementation (C4-1910 / C4-1925)

The original report above describes immutable evidence commit 21ab57f4,
not the final corrective tree. R2 cycle 94 and C4-1925 classified the
copy/export impact as MEDIUM; the studio availability impact is LOW.
C4 explicitly gave K2 priority over #1969 for the response-read lines.
The full correction belongs in one PR; no reservation document changes.

The reader rejects unknown evidence with the existing UnknownReply class.
A failed read now yields an explicit null total in the studio card; the
real editor shows an unavailable notice, keeps Edit available, and suppresses
answer counts/actions. Healthy cards keep their known counts and controls.
CSV/PDF return 503 unavailable with no download. Opportunity conversion also
returns 503 for an unread answer source before attempting a write.

Consumer RED dbf0a6f1 (after reader-only be5fb70a) executes the REAL page,
editor and HTTP handlers with explicitly synthetic surrounding auth/services:
six tests, four causal failures and two passing controls. The SAME assertions
pass after correction. No timeout, expected result or assertion was weakened.
The fixture's Store type assertion was clarified without a runtime change.

Additional corroboration f4873ba5 runs the real person copier and real store
export stream against the old reader from 21ab57f4. The same composite assertion
observes copyUnknown=false/formsOmitted=false/unread=false before repair and
true/true/true after it. Known copy/export controls pass. This corroboration
was added after the reader repair, not misrepresented as predating it;
original reader RED 21ab57f4 did precede the repair. Existing copier/stream
failure handling suffices, so those production modules need no edit.

Native and GitData integration of frozen main ced82292 retained BOTH the
form-response and blog test-alias blocks. The conflict was only test wiring;
actual blog-page tests pass 10/10 after integration.

Validation: 24 canonical files, 308 custom checks and 59 Node tests pass after
one targeted executor-test rerun. That file initially hit local ENOSPC while
writing its temporary event log; its isolated rerun passed 5/5. No test source
or expectation was changed for that environmental failure. Reproducible old
Next build outputs were removed; sources, REDs, screenshots and Git history
were preserved. Actual scoped TypeScript/imports: 0 diagnostics; directed
ESLint: 0 errors; scanner: 4,061 tracked files/0 corrections; diff check clean.
No browser, native Redis/provider, actual purchase, production, complete
journey or global AAA claim. No new productive IO, retry, storage key,
provider operation, retention or cost parameter; synthetic read ceilings only.
