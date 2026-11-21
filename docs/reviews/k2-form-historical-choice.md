# Historical choice response — evidence only

Reservation: parent channel receipt 41b5901768562f548cc67f8a017fbdb59f2d3282. Product sources are read-only. The selected source snapshot is main 5c07315505e1d53ee6401021601cd688fa98ecda. This unit is distinct from #2857 and from the separate form-save acknowledgement evidence.

The proof uses the real parseForm, writeForm, addResponse, readForm, readResponses and responseTexts. Only the Redis transport is the repository MemoryRedis fixture. A valid three-option form receives an actual stored answer, then the same definition is edited to remove the selected option while keeping two options. The raw stored option ID and response identity are compared before and after. A genuinely unanswered response and a restored current option are controls.

The safety contract does not invent the original option label. A stored answer that the current definition cannot interpret must be distinguished from a genuinely unanswered question, rather than certified as No answer.

## Run

    TMPDIR=/dev/shm timeout 120s node proofs/k2/form-historical-choice.mjs /path/to/source

The optional next argument is the expected 40-hex blob of lib/form-response-pdf.ts; the default is 041350383f465dbe639e943c3854db305924208a. The runner prints hashes of forms.ts, form-store.ts and form-response-pdf.ts from the selected source. The fixture remains in the evidence checkout, while product imports resolve to the source checkout.

Four scenarios are admitted before the first fixture write, each with at most 40 application/inspection commands, total ceiling 160. The reproduction command imposes a 120-second hard timeout including compilation; the execution subprocess receives only the remaining budget. All HTTP/fetch/provider calls are forbidden. No auth/HTTP handler, browser or generated PDF is executed: the actual PDF text formatter is the presentation boundary under test.

## Result

Executed against the exact selected source snapshot: **25 checks, 23 pass, two fail**. Both failures are limited to the removed-choice presentation contract. The same confirmed form/response identities and raw stored answer remain intact. The reader still returns opt001 after the real definition writer removes it from the current options. responseTexts nevertheless renders No answer., the same text as the separately persisted genuinely unanswered control. Restoring the option ID with a new current label renders that label normally.

The observed command counts are baseline 13, removed-choice 5, genuinely-unanswered 4 and restored-current-label 5: **27 total**, each below its 40-command ceiling. Fixture setup, writes, ordinary reads and direct raw inspection are all counted; no hidden setup exemption is used. HTTP/fetch/provider attempts are zero. MemoryRedis supplies in-memory script behavior; no native Redis or Lua engine was exercised.

This establishes the formatter's false absence under a valid edited definition, not loss of the stored answer. No severity is assigned by this proof. The parent/reviewer can reproduce and classify it. It is not an ACK failure and does not reopen #2857.

Actual scoped TypeScript used the selected source snapshot's tsconfig and real imports for one proof root: zero diagnostics. The TypeScript proof and runner pass directed ESLint; runner syntax passes node --check. The test ran under the pre-admitted 120-second command bound without changing any functional assertion after observing its result.

## Limits

This evidence cannot prove backend data loss: it explicitly checks that the saved raw answer remains intact. It does not recover a removed historical label, certify PDF/UA or a complete download journey, or demonstrate exposure across stores. No product, configuration, alias registry, CI, branch ref, index, price, limit, account, payment, supplier or external contact is changed.

## Exact source and observations

```json
{
  "evidenceRoot": "/workspace/scratch/76b48832dbcf/k2-form-siblings-exact",
  "sourceRoot": "/workspace/scratch/76b48832dbcf/k2-audit-form-main",
  "expectedPdfBlob": "041350383f465dbe639e943c3854db305924208a",
  "sourceHashes": {
    "lib/forms.ts": "9d7417785334afa621a40544a279fa13508d9b1d",
    "lib/form-store.ts": "a54d5798f6e6f78c3d0990af66a459face0ea6d2",
    "lib/form-response-pdf.ts": "041350383f465dbe639e943c3854db305924208a"
  },
  "checks": 25,
  "failures": [
    {
      "name": "removed-choice: a retained answer is not certified as No answer",
      "actual": true,
      "expected": false
    },
    {
      "name": "removed-choice: uninterpretable historical choice is explicitly distinguished",
      "actual": false,
      "expected": true
    }
  ],
  "observations": [
    {
      "scenario": "baseline",
      "formId": "history001",
      "responseId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "rawAnswer": "opt001",
      "text": "Original option A"
    },
    {
      "scenario": "removed-choice",
      "formId": "history001",
      "responseId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "rawAnswer": "opt001",
      "rawRecordUnchanged": true,
      "currentOptions": [
        "opt002",
        "opt003"
      ],
      "text": "No answer."
    },
    {
      "scenario": "genuinely-unanswered",
      "responseId": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "hasChoice": false,
      "text": "No answer."
    },
    {
      "scenario": "restored-current-label",
      "responseId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "rawAnswer": "opt001",
      "text": "Current option A"
    }
  ],
  "bounds": {
    "scenarios": 4,
    "commandsPerScenario": 40,
    "commandCeiling": 160
  },
  "commands": {
    "baseline": 13,
    "removed-choice": 5,
    "genuinely-unanswered": 4,
    "restored-current-label": 5
  },
  "forbiddenFetches": 0
}
```
