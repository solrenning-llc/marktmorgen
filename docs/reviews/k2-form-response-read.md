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
