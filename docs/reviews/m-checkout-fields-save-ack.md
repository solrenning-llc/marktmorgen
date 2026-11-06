# Checkout-question save acknowledgment evidence

Codex M, 2026-11-06. Proof only; classification and assignment requested from Claude 4.

Target: `components/checkout-fields-editor.tsx` blob `48397330d47572bd875b1dcb716168152b314033`, published in product head `6af9100ed56795f025d98c6f84c19246a4eecf97` (#2834). The save acknowledgment code predates that hydration-only change. Reservation preceded repository proof code in channel commit `a16a357f27fcfde869a16d60d30aeebaf23c2965`.

Run after installing the repository dependencies and a compatible Chromium:

```sh
TMPDIR=/dev/shm node proofs/m/checkout-fields-save-ack.mjs
```

The runner refuses a different component blob. It bundles and renders the real component, hydrates it with the installed React in real Chromium, opens its actual form, types a synthetic question, and presses its real submit control. The AppRouterContext is synthetic: refresh only increments an observation counter. The toast event is observed without replacing the component or its save handler. Only the HTTP reply is injected.

Before execution the exercise admits exactly four scenarios, at most one local POST (4 KiB) and one response (128 B) per scenario. All requests outside the loopback fixture are refused. No Redis, signed-in application, account, real provider, actual checkout, payment or external request is involved. CPU and hosting costs are not estimated as zero. This proves UI acknowledgment behavior, not a backend data-loss event.

| Reply | Expected UI | Observed UI |
| --- | --- | --- |
| 200, `{"ok":true}` | Close; one refresh and success toast | As expected |
| 200, `{"ok":false,"error":"signed_out"}` | Keep form; no refresh or success toast | As expected |
| 200, `{"ok":"true"}` | Keep form; no refresh or success toast | Closes; one refresh and `Checkout questions saved.` |
| 503, `{"ok":true}` | Keep form; no refresh or success toast | Closes; one refresh and `Checkout questions saved.` |

Result: **24 checks, 6 failures, 18 passing checks**. Each anomalous reply fails the three independent observations (form, refresh and toast). All four scenarios submit exactly one bounded POST containing the question actually typed, and have no hydration/page error. Chromium's expected resource-error log for the deliberately injected 503 is distinguished from hydration errors.

Cause: the real save handler casts JSON to a TypeScript interface and then uses `if (data.ok)` without validating its runtime type or the HTTP success status. A truthy string or a failed HTTP reply becomes confirmed success. No state or prototype is forged.

Proposed boundary, for coordinator decision: require a successful HTTP status and exact boolean `ok === true` before closing, refreshing or announcing success; preserve the form and an honest error for every other acknowledgment. No productive IO or monetary change is needed. The same 24 checks should become a permanent regression without weakened assertions. #2834 source, ref and CI are unchanged by this proof; do not treat the prior clean hydration review as clearance of this newly demonstrated acknowledgment issue.

Related-pattern search is recorded separately as static candidates; it does not certify additional defects. The original hydration regression remains 14/14 and its unrelated linked checks remain valid.
