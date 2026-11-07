# Local execution follow-up for #3034

Reviewed product head: `12b73d60faa4a51489e1b3498489f1c8b5008685`.
Prior J opinion: `5808324331`; independent P opinion: `5808315232`.

This report adds runtime evidence for two existing LOW findings; it does not
repeat the independently reproduced P lost-update finding or claim another
independent opinion. The author product, ref and CI are unchanged. Evidence
remains local under C4-3050/C4-3070 until literal MAIN VERDE.

## Result

`node scripts/j-review-3034-sent-links.mjs`: **5 tests, 3 passing, 2 failing**.
These are three controls (including the network negative control) and two
causal failures, not GREEN. The earlier four-case run had the same two
causal failures and two healthy controls; the final run only adds a transport
negative control. The recorded output is adjacent to this report.

1. With 19 valid prior changes, restoring the original succeeds and appends
   the twentieth history entry. With 20 valid prior changes and a current
   non-original destination, the same real `changeLink` returns `ok:false`
   instead of permitting the undo offered by the page/component. No cap was
   raised or product code changed. This confirms the previously reported
   promise/action mismatch; the synthetic valid history is setup data.
2. The real component callback calls the real POST route and real
   `changeLink`/data-room code against MemoryRedis. The intercepted `SET`
   is applied normally and only its acknowledgment is replaced with null.
   The route returns 503 / `unconfirmed`; the persisted destination is the
   new one; the visible error correctly says it could not confirm the save.
   The actual component's polite live-region state nevertheless becomes
   `Link 1 was not changed.` One internal request, one history SET and four
   Redis commands are observed. The matching confirmed-write control returns
   200 and announces the destination actually kept.

## Scope and limits

- `changeLink`, `needData`, MemoryRedis, the POST handler, the React component
  and its callback are real. Only authorization and broadcast lookup are
  fixed fixtures. The fixture store supplies only fields consumed by this
  graph, not a complete loaded store/session. No authorization conclusion is
  inferred from this exercise.
- React is real with a controlled hook dispatcher, and the elements/callback
  are inspected without ReactDOM, hydration, a browser or assistive technology.
  The live-region string is verified, not actual screen-reader output.
- Fetch, HTTP(S) and sockets are blocked before the product graph loads.
  The explicit negative control rejects fetch and socket attempts. The only
  fetch accepted during the component case is the exact internal POST routed
  directly to the local handler. No email, recipient, provider or account is
  contacted.
- The command budget is 1,000 commands per component case, at most eight
  cases total, 120 seconds per process and 256 KiB captured output. The
  actual component cases each use four Redis commands; the entire proof
  finishes below one second.
- `node scripts/j-review-3034-sent-links.mjs --author` reproduces the unchanged
  canonical author test: **71/71**. This is ordinary baseline coverage, not
  closure of either LOW or the MEDIUM concurrency finding. Author RED was
  not replayed in this follow-up, and no hosted CI was queried or rerun.
- The two existing LOWs retain their prior severity. The privacy wording
  and monetary-byte-bound observations remain source-review conclusions;
  this follow-up does not claim legal, privacy, all-cost or AAA clearance.

## Validation

Directed TypeScript uses the repository's actual ES2017 target and imports;
the first fixture-only TS2352 cast diagnostic was corrected explicitly as a
partial synthetic fixture, without changing product types or assertions.
Final directed TypeScript: exit 0 under ES2017, zero diagnostics. ESLint on
the proof, world and runner: exit 0. The staged public-data scan reports
4,162 tracked files and zero corrections; staged diff check is clean.
The committed output removes trailing spaces and its last blank line only;
the raw capture remains `/tmp/j-review-3034-low-final.log` unchanged.
All source files from the author head remain byte-identical. No provider,
price, visible limit, commission, flag, gate, account or commercial term changed.
