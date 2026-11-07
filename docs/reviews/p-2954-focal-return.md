# Codex P focal return on #2954

Requested head: `a4d410bfce6dd0018f42610346ccfd7de52c4f0e`, author reply `6707351111`.

The original orphaned-mark MEDIUM `5808258472` is closed in the executed delayed-recovery scope. The original frozen proof is preserved byte-identically (`a958a6f8137cdd37fc9cb894262888857b95e64f`), and still gives 3 checks/2 failures on this head: it demands immediate mark removal and an immediate send. Those expectations are not the new safe recovery contract. The first assertion (uncertain claim/release keeps the reminder due without sending) passes. No original assertion was changed or relabeled green.

A separate additive proof checks a fresh orphan remaining due, recovery after eleven minutes, another sweep not resending, and two sweeps reading the same aged mark before either compare-delete. These five checks pass: one send, no duplicate, queue empty after completion. This does not prove recovery after arbitrary process suspension or native Redis behavior.

## Verdict: not clean, one conditional inherited MEDIUM

`madeOrTakeOver` in `lib/community-event-mail.ts`, the `raw !== null` branch, treats **any string** as evidence that a send was made. `parseJob(raw)` is only used to decide whether to requeue a sending record; if parsing fails it still returns `made`. The sweep then removes the due member.

Independent causal cases inject `{cut` and `{"id":"invalid"}` only into the paired GET response for mark and job. The actual stored mark is a valid aged claim; the underlying job is confirmed absent. With either unknown response, the current head sends nothing and removes the due member. Removing the fault and running a healthy sweep still sends nothing because there is nothing left due. These are malformed-read evidence cases, not a claim that the production Redis service spontaneously truncates valid values.

`tests/p-review-2954-orphan-return.test.ts`: **11 checks, 7 pass, 4 causal failures**, 101 MemoryRedis dispatches. The two confirmed-absence controls pass. This is an inherited unknown-evidence class left in the changed taken-mark path: the same proof also fails on the previous source modules. Do not count the two malformed strings or the failed healthy retries as four distinct defects.

Requested correction after Revisor 2 reproduces/classifies: a non-null job response must establish a valid, correctly identified send before the helper can call it made; malformed/unknown evidence must keep the reminder due without sending, releasing another run's claim, or silently assuming confirmed absence. Add the same cases as permanent regression checks and request a focal return. No repair was made by P.

## Executed validation

| Test | Author RED modules `399b396bf` | Final head modules |
| --- | --- | --- |
| Unmodified `nx-community-mail` | 56 checks / 9 failures; 291 dispatches | 56 pass; 366 dispatches |
| Independent additive orphan proof, byte-identical | 11 checks / 9 failures; 46 dispatches | 11 checks / 4 failures; 101 dispatches |
| Frozen original P proof | Previous durable RED retained, not rerun | 3 checks / 2 contract-mismatch failures; 14 dispatches |
| `rsvp-list-exact` | Not rerun | 19 Node tests pass; 37 dispatches |
| `community-mail-read-evidence` | Not rerun | 120 pass; 578 dispatches |
| `claim-mark` | Not rerun | 5 pass; 12 dispatches |
| `lock-release-atomic` | Not rerun | 31 pass; 51 dispatches |

The RED comparison substitutes only the three old product modules into the final test graph; it is not a checkout/run of the entire old repository. The additive proof's first five failures on old modules become passes on the final modules, which supports closing the original orphan-loss defect separately from the malformed-job evidence defect that remains.

The final copy uses pinned main `0ade0faf` plus exact final PR files and exact claim/reply/MemoryRedis blobs fetched from the requested head. The later main `599cc662` adds queue workflows; the selected normative files are byte-identical. The source blobs were checked against fetched Git SHAs. This is a selected module graph, not full-project or full integration certification.

Strict TypeScript for the new proof and imported graph completed with zero diagnostics. Focused ESLint, scanner and whitespace checks are recorded with the review. No global suite, hosted CI, native Redis/Lua, actual sender, browser, provider or production delivery was exercised. The flow tests intentionally use the repository's synthetic community/mail fixtures; the separate RSVP test calls the real reader.

## Reproduction and resource bounds

Copy the new test and `proofs/p-2954-return.mjs` into the exact reviewed checkout. Run `node proofs/p-2954-return.mjs p-review-2954-orphan-return.test.ts`. The runner uses repository aliases (the same fixtures as `nx-community-mail`) and environment, blocks fetch, and counts every MemoryRedis.run, including nested calls, **before dispatch**, with a 20,000 command ceiling, 120 seconds, 512 MiB and 256 KiB output per child.

For the RED module comparison, materialize the three named old modules from immutable `399b396bf` under `/tmp/p2954-red-modules/lib/`, then set `P2954_SOURCE=red`. Evidence branch history intentionally retains the older product snapshot: always copy the proofs into the requested checkout, never mistake that historical source for the final PR. Author source/ref/CI remained read-only. Review claim preceded this work; no merge or publication is implied.
