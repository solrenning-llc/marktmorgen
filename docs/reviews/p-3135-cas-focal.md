# Codex P focal: expired hand-in lease (#3135)

Subject: 3974cac3f0d6801fb3d62b5c6cd8a73a032e4ff0. Prior: f76c1f859146c76cb143d33792ab2fa2ecc1d92e. Request6714676111; claim6715049015 BEFORE new source/diff/tests. This is P's nominal return on P5815585499, not a third global financial review. N has a separate nominal focal6714999758.

## Verdict

P's conditional residual MEDIUM is closed at its cause in this exact delta; no new blocking P finding demonstrated. The compare-and-write uses the exact raw submission read, atomically installs submission/file index/waiting/all-work index only when that raw record still matches, and returns exactly1 or0. A stale holder receives0, throws HandInChangedError, deletes only its own new file, credits only that successful deletion and answers409 busy. Unknown ACK throws, retaining files/space. The old file's deletion/credit cannot follow the rejected stale write. The record-space reservation left counted after conflict is conservative overcount, explicitly not guaranteed returned credit.

Lua GET/SET/HSET/ZADD/ZREM and the corresponding MemoryRedis interpreter were read in full, as were route cleanup, exact raw reader, fault-injection changes and permanent lease test/config. All SIX corrective paths read. Stored malformed/non-string/non-null submission still throws; absence alone maps to empty expected raw. Response parsing validates the singleton envelope and scalar. The creator-review writer outside this lock, failed-delete orphan discovery and finite lock wait remain earlier declared limits, not silently closed. No real Lua/provider/production exactly-once certificate.

## Original and derivative proofs

Frozen original P proof remains byte-identical06d0749b190fec201df86113eccb12b7e564566c. Its old SET-only hook no longer intercepts the conditional EVAL. It was NOT executed/rebranded GREEN on the new head: that schedule is structurally incompatible/inconclusive. Previously recorded original RED at f76 remains unchanged.

Separate P derivative0dc65d9d9f0ceeb77089ef6214ddbd99d58bf1fb changes ONLY the two write-interception predicates to accept SET or EVAL first-key. No assertion, clock advance, result expectation, setup or limit relaxed. In the final graph with ONLY old f76 assignment+route substituted:2cases/1FAIL; current2PASS. Old observation: both200/two files/used1000/originaldelete2/staleA wins. Current: A409/B200/one stored file/used1000/originaldelete1/B kept. Control expired holder alone passes both.

Permanent author task-hand-in-lease.test.ts blob19cac9b345cd4e5a39280f94590f13d24c3cfd00 is BYTE-ID RED65842f647 and final head. Independently run in same old-module graph2/1FAIL -> current2PASS. It broadens the hook and ADDS stronger oracles: one deletion, stale409, successor200, exact successor record/file/count/index. This is not byte-identical to original P2 and does not replace it. Existing task-hand-in-kept hook also accepts EVAL, with all8 cases intact.

Separate P ACK boundary proof1596ba8e427e80f57800cccdc8dd73cede77ddc3: FOUR real-route cases after applying conditional write, then returning missing envelope, null, string1 or extra slot. All4PASS:500/notok, applied record remains, both physical files/2000 counted bytes retained, neither original nor new file deleted. These are synthetic transport-shape controls, not four new product defects.512dispatch/0mock.

## Directed validation

Current: P derivative2, permanent lease2, kept8, replacement4, room-unknown10, assignment-room5, assignment-drop11, sweep21, registry7, ACK4 =74 node:test cases PASS; assignments52 + redis-reply-envelope23 =75 check assertions PASS. Shared exercised paths and duplicate lease schedules are overlap, not149 independent scenarios/defects. Per-child dispatches:291/292/821/638/909/123/13/46/399/0/0; ACK512. Total4044 dispatches/50 response-only mock HTTP. Old derivative289 and permanent289 each1FAIL (same cause, not two defects).

Real repository ES2017/strict/Bundler tsc, seven roots and imports,1024MiB:exit0/empty diagnostics. ESLint9files:exit0/0errors/2unused-helper warnings (copied lessonFiles helper in P proofs). Official public-data scanner4371 indexed subject files/0findings plus six own artifacts checked directly. Original index exactly subject tree4aa2c62fb94a09397ba0a556296079ee1e6984d3; source unstaged diff clean; actual six-path diff --check clean; own new code whitespace clean. No author/source/shared index changed. A premature git diff before fetch finished reported bad object; no source ran and fetch then supplied exact object. Not a product RED.

Limits established BEFORE dispatch:20000 MemoryRedis.run including nested,100 response-only mock fetches,120seconds,512MiB,256KiB output per child; socket/HTTP/TLS blocked before dynamic product graph. Serial/no agents/providers. Four known blob-fixture missing-export build warnings concern unexecuted paths. No full suite/build/CI/browser/AT/realRedisLua/Upstash/blob/SES/globalMR. Author-reported other15 suites are not P executions. Unknown cost is not zero; no paidIO. No foreign source/ref/CI/queue/merge/product PR or policy mutation.

Reproduce from this evidence checkout with installed repository dependencies:

```sh
git show f76c1f859146c76cb143d33792ab2fa2ecc1d92e:lib/assignment.ts > /tmp/p3135-old-assignment.ts
git show f76c1f859146c76cb143d33792ab2fa2ecc1d92e:app/api/store/course/task/route.ts > /tmp/p3135-old-route.ts
P3135_OLD=1 node proofs/p-3135-focal-run.mjs p-3135-cas-hook.proof.ts task-hand-in-lease.test.ts
node proofs/p-3135-focal-run.mjs p-3135-cas-hook.proof.ts task-hand-in-lease.test.ts p-3135-cas-ack.proof.ts task-hand-in-kept.test.ts hand-in-replace-exact.test.ts task-room-unknown.test.ts assignments.test.ts assignment-room-exact.test.ts assignment-drop-exact.test.ts task-upload-sweep.test.ts redis-reply-envelope.test.ts store-data-registry.test.ts
```

First invocation intentionally fails. Do not run the frozen SET-only probe on the new EVAL graph as if it exercised the old pause. Do not merge this evidence branch into product. Formal review requires fresh subject/timeline; merge/queue gates remain separate.
