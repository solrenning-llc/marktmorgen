# Proof: unknown funnel-share acknowledgements become business outcomes

Status: **proof only; coordinator classification and independent R2 execution required before any fix**. Proposed medium impact for the creation/admission findings is not an accepted severity. The revoke cases are reported separately for classification. No source repair, product PR, merge or publication claim.

Base: `5c07315505e1d53ee6401021601cd688fa98ecda`.
Reservation: channel commit `14e35c4c1c84dbcf843212b80b19bcee53958a37`.
Only new files: `tests/t-funnel-share-ack.proof.ts`, `scripts/t-funnel-share-ack.mjs`, and this report.

## Creation: a real write is reported as full; a real refusal is reported as success

`createShare` generates a secret code locally, stores only its fingerprint, and returns the code only on success (`lib/funnel-share-store.ts:98–123`). The writer's actual Lua script checks existing keys/capacity before writing the index, snapshot and expiry (`:84–92`). The response reader checks the outer pipeline length and then coerces its only acknowledgement with `Number(...)` (`:119–122`).

After a real EVAL returns numeric **1** and writes a valid snapshot/index, replacing only that response slot with null, false or an empty array makes `createShare` return `{ok:false,error:"full"}`. The actual index has one entry; its metadata, outline and bundle match the real writer's input. The secret code is withheld from the caller. This is a false capacity explanation for a write that occurred. The proof does not recover, guess or log the withheld secret, and does not claim that the inaccessible code leaked.

Conversely, after an existing healthy share fills the synthetic capacity of one, the next actual EVAL returns numeric **0** and creates nothing. Replacing that response slot with true or `[1]` makes `createShare` report success with a newly generated code. A subsequent healthy `openShare` rejects that new code, while the original share still opens; the original index and snapshot are unchanged. This is an acknowledged share link with no stored snapshot, not an extra share created past capacity.

Actual caller: **POST action `share`**, `app/api/store/funnel-share/route.ts:159–163`. A false result becomes `shares_full`; a true result returns the code and share link. The proof executes the store function, not the HTTP route or UI. The route's catch returns `server_error`/500 (`:266–268`); this report does not substitute a 503 claim.

## Use counter: an unknown shape is accepted below the true count

`countUse` runs SET NX followed by INCR, coerces the increment response with `Number(...)`, checks a positive safe integer, and compares it with the supplied limit (`lib/funnel-share-store.ts:170–174`). The real in-memory first increment is **1** and correctly admits; the second is **2** and correctly refuses a synthetic limit of **1**.

Changing only the second increment's returned slot to true, `[1]`, or `[[1]]` makes the same function return **true**, even though a subsequent real GET reads **2**. This proves incorrect admission by the shared predicate. It does not execute a downstream import, export, provider request or payment, and does not establish a real financial loss. Null and a short pipeline remain unavailable and are passing controls.

The predicate is used before sharing (`app/api/store/funnel-share/route.ts:151`), preview (`:174–175`), and export (`:287`), among other actions. These references establish that the predicate is operational; no downstream route behavior is newly certified here. The synthetic limit does not modify any product limit, allowance, flag or gate.

## Revoke: unknown reads or delete acknowledgements become false absence

`revokeShare` parses the initial HGET slot and returns false whenever parsing fails, then coerces the HDEL acknowledgement after issuing real DEL/HDEL (`lib/funnel-share-store.ts:127–133`). A healthy existing share is actually revoked and returns true. **Known HGET null is valid confirmed absence** and correctly returns false without delete commands.

For a live share whose real HGET returns a valid stored string, substituting false, undefined, `[]` or `{}` produces false without deletion. The original index and snapshot bytes remain, and a subsequent healthy open still succeeds. The defect shown is false absence in the response, not a claimed successful revocation, private-data disclosure or privacy bypass.

For a healthy live share, the actual delete pipeline removes both snapshot and index and returns numeric HDEL **1**. Replacing that acknowledgement with null or `[]` makes the function return false after the real deletion. The resulting healthy open is null, as it should be after deletion. This is a false negative response, not an unrevoked link. The POST revoke caller maps false to `unknown`/404 (`app/api/store/funnel-share/route.ts:167–170`). No claim that the UI tells the sender revocation succeeded is made.

## Reproduction

Use the already installed repository dependencies. No installation or network access is needed:

```sh
node scripts/t-funnel-share-ack.mjs
node scripts/t-funnel-share-ack.mjs --linked
node scripts/t-funnel-share-ack.mjs --types
node node_modules/eslint/bin/eslint.js tests/t-funnel-share-ack.proof.ts scripts/t-funnel-share-ack.mjs
python scripts/check_public_data.py
git diff --check
```

The proof deliberately exits **1** on the unchanged base: **22 cases, 8 passing controls and 14 failing cases**, with **134 recorded post-observation checks / 22 failed checks**. Additional fixture assertions validate the real bundle, writer and healthy open before the faulted revoke/counter/full-capacity cases.

| Group | Passing controls | Failing cases | Causal observation |
| --- | --- | --- | --- |
| Creation | 2 | 5 | Applied write becomes full in 3 cases; actual full becomes a success with a broken new code in 2 cases |
| Counter | 4 | 3 | Actual stored count 2 becomes admitted under synthetic limit 1 |
| Revoke | 2 | 6 | Four unknown reads become false while the link remains live; two unknown delete acknowledgements become false after deletion |

Exact summary:

```json
{"cases":22,"passed":8,"failed":14,"checks":134,"checkFailures":22,"dispatches":206,"commandUnitsIncludingLuaAllowance":325,"appliedFaults":16}
```

Every response fault is applied exactly once, after executing the actual MemoryRedis commands. Non-short faults preserve the correct outer pipeline length. Production `createShare`, `countUse`, `revokeShare`, `listShares` and `openShare` run unchanged; no crypto mocking, fake writer result, hand-seeded index or fake open outcome is used. Each share comes from actual `FUNNEL_STARTERS[0].bundle`, accepted by production `readBundle`, and production `outlineOf`. The proof checks persisted metadata and original snapshot bytes as well as returned values.

## Prior ceiling and validation

The prior ceiling is **40 cases, 5,000 total synthetic command units, 120 seconds per execution and 128 KiB captured output**. The measured proof uses **206 dispatches / 325 units**, allowing eight units for every share-writer EVAL: its dispatch plus seven Lua Redis calls, conservatively including refusal paths. No paid IO, HTTP request, provider request, real credential or real account is used. CPU/storage/provider costs are not certified as zero by this synthetic ceiling.

The runner verifies installed and locked esbuild **0.28.2**, reuses the repository's canonical alias helper, and aliases only Redis to the new in-memory fixture. A banner blocks fetch, HTTP/HTTPS/HTTP2, sockets, TLS, DNS, datagrams and subprocesses before the application graph. **Network/subprocess attempts: zero**. The `.proof.ts` suffix keeps the intentional RED outside the automatic test-file runner.

Scoped TypeScript and lint pass. Linked tests pass: `funnel-share.test.ts` **79/79**, `funnel-starter-catalog.test.ts` **71/71**, and `funnel-sharing-review.test.ts` **12/12**, totaling **162 checks**. The full sharing test records 647 synthetic dispatches / 682 units including the known share-writer Lua allowance; the two pure linked files dispatch none. All record zero network/subprocess attempts. Linked counts do not certify real-provider costs for other Lua scripts.

Public-data scanning includes the three new proof files in the local index: **4,135 tracked files, zero findings**. Diff check and source-identity check pass. Product sources and existing test infrastructure are unchanged. The relevant source blob for `lib/funnel-share-store.ts` is `4f7ee5216a190dec15b035f00ad376f61968ce63`; `lib/redis-memory.ts` is `175b715979482857023cc404fdd8593face64e5a`.

R2 must execute this exact durable proof before classification or any medium fix. No creation, counter, revoke, retry, cleanup, transport-contract, payment, price, commission, visible limit, flag, gate, consent or terms repair is included.
