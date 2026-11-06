# E2 A3 read-evidence audit

Evidence-only branch, based on main `2bfa8ade8f59555b8d57aa03e554a99092a1285b`.
Reservation: channel commit `2125df00969ea6ef1bc738849da27229e311b6c0`, before code.
No product, shared alias, CI, cost registry, account or supplier is changed.

## First hypothesis: the saved heard-question opt-out

`lib/heard.ts:39-41` coerces the SISMEMBER reply with Number and does not
validate the envelope. `recordHeard` uses that boolean before its Stripe
session read, claim and aggregate statistics write.

The opt-in proof executes the real reader/recorder, normal store creation,
MemoryRedis, real claim and statistics writer. It substitutes one transport
reply only. The saved off membership is checked independently before retry.
All addresses, accounts, sessions and provider replies are synthetic.

Run `TMPDIR=/dev/shm node proofs/e2/a3-read-evidence.mjs`.
Expected unknown result: unavailable, no provider read, no mark, no count.
Healthy enabled/disabled and next-request controls must remain meaningful.
## Executed result

**19 checks: 5 causal failures and 14 passing controls, no skip.** Each of
five JSON-shaped replies (`[]`, `[null]`, `[false]`, `["0"]`, `[null,0]`)
lets `recordHeard` return counted, perform one synthetic provider GET, keep
the order's claim, and increment the real aggregate count and amount by
1 and 4900. The saved off membership remains exactly 1. The healthy disabled
path makes no provider request and no count; the healthy enabled path writes
the expected count and amount. Retrying with a healthy reply respects off.
These are five vectors of one cause, not five distinct defects.

**Proposed MEDIUM, conditional, integrity of the creator's saved preference.**
Independent reproduction and final grading are requested from Revisor 2.
The anomaly is injected at the Redis transport boundary; this does not claim
that healthy Redis emits these replies or that a remote attacker can cause
them. No payment, email, personal-data disclosure, source quota bypass or
actual financial loss was demonstrated. The aggregate numbers are real writes
in MemoryRedis; neither `heardOff`, `recordHeard`, the Stripe reader, claim
logic nor `countHeard` is replaced with a test implementation.

Linked canonical suites: l10b-heard 22/22, claim-mark 5/5 and tb14-claim-marks
21/21, total **48/48**. Strict TypeScript for this proof root and all transitive
imports exits 0 after supplying the installed Node type root explicitly.
The first temporary config was outside the project and could not locate Node
types; that configuration failure is not a product failure or a passing check.
Lint on the two executable files, launcher syntax and staged diff-check exit 0.
`python scripts/check_public_data.py`: **4107 tracked files, 0 findings**.
Source `lib/heard.ts` remains blob `6c5bfa11da105afedba3a6bfc2790cc01a0c9905`.

This is a bounded first result, not a complete A3 audit or a repair. The new
C4-2820 assignment also gives A3 to Claude 5; coordinate this one already
reserved proof with that sweep before changing product. The A1 snapshotState
hypothesis was handed to Codex S, not proved or claimed by E2.

No native Redis, browser, HTTP route, real provider, published journey,
production incident, customer benefit delivered or financial loss is claimed.
