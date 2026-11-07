# Requested focal return: membership resume lease boundary

Subject: `d8107ad01fec7923f6f604397e0c6a483630450a`, tree `01a8ea13f2020252c7728b25329e004dfc5e642c`.
Previous subject: `dba968ad8f3a99bb4e85be8491b00f7e0a962f92`.
Requested by author comment6712772037; T claim6713139934 and accepted channel RES27f470a19c6d2be5ea74c5eadc253afe6c875890 BEFORE new source/diff/proof execution. Claude1 express disposition1737 and pause1746 read: focal reviews continue; no new product PR.

## Verdict and boundaries

T5814544277 conditional LOW is CLOSED IN SOURCE for the modeled lease-expiry sequence. The comment now explicitly identifies a lease and assigns duplicate-application protection to the stable resume key. Two calls with the same paused membership, including the same pause_from/until/paused_at and attempt, carry the same key after 121 synthetic Redis seconds. The second in-flight request receives an unknown/error result rather than a second application in an idempotency-aware stand-in.

No additional HIGH/MEDIUM demonstrated in this four-path corrective delta. This is not closure of G5814558928's separate HIGH: G has his own requested return in progress. No new third financial opinion, approval, funding certificate or queue authorization.

One documentary LOW remains: the CURRENT PR body still says "An idempotency key alone was not used" and describes only a lock; it omits the new counter/key and unknown-result behavior. Align the body with this corrective and qualify its safety claim to the idempotency contract, rather than crediting the live lease alone. No author body/source was edited by T.

## Immutable original versus explicit derivative

Original `tests/t-3090-lease.proof.ts` is BYTE-IDENTICAL to blob `1501fafcac7ccf76768466ef5d83d6e381adc278`, SHA256 `ca5a48f9f8eb2676381e4cd96111741e16009e53d467b39634cf12653a97c43f`, published in prior proof `e4be1b4b22697f4595c81c72238c7605c5c3b57d`. It counts every POST as an application without honoring keys. On this new subject it STILL reports **4 checks / 3 FAIL**, 49 MemoryRedis.run / 5 mock HTTP. It was not edited, relabelled GREEN or used to claim real provider duplicate charges.

New `tests/t-3090-idempotent-lease.proof.ts` is explicitly DERIVED, SHA256 `f963f0ad59e339549536603d2fc56707c07bc7f2b522bb956005be6264ce602f`. Same scheduler sequence: hold first POST, advance only Redis121s, await second call, release first, make later third call. The only model change admits each nonempty in-flight key once and answers repeated in-flight keys409. It separately counts requests and applications, retaining the four original observations and adding exact-key/unknown-second assertions. It is NOT a complete Stripe emulator: no persisted-key expiry/policy model or real invoice.

SAME DERIVED SIX checks: substitute ONLY pre-corrective membership-pause.ts into FINAL graph -> **6 / 5 FAIL**, 45 run / 5 mock; exact final -> **6 / 6 PASS**, 48 run / 5 mock. Final: two POST requests share one nonempty key, second answers error, one application, first success, running membership, later call adds no application. Old missing-key behavior causes the expected failures. No product source modified for replay.

## Permanent controls and static verification

SAME FINAL author test `48b531598803d7f259d837305611004ffb30b6b2`: pre-corrective module ONLY in final graph **22 / 14 FAIL** (123run/32mock), final **22 PASS** (153run/31mock). This is not the original author20/13 RED; the final test adds two controls to the durable author RED5fe45ccd2d4d8cae80f36eae99ff4fa01f22ae95. Counter unread/rejection, known402 then corrected card, failed attempt write,409/500 stable identity and distinct new pause are exercised. Counter identity and data-family/registry changes read in full.

Affected controls on final: membership-resume-once4, membership-pause22, store-data-registry7, closing-families4, data-recount13: **50 PASS**, 294run/22mock. With permanent22 and derived6: **78 ordinary PASS**, 495run/58mock; immutable original4/3 FAIL reported separately. No unchanged historical108 replayed as new results.

Actual project tsconfig preserved: ES2017, strict, Bundler; eight roots (runtime, two permanent resume tests, registry, family module, original and derived probes), closure453 non-declaration sources, **diagnostics=[] / no emit** at1024MiB. No diagnostic filtering. Exact lock and installed Node24.22.1 / TypeScript5.9.3 / esbuild0.28.2 / ESLint9.39.5 / config-next16.4.2 verified; no install. ESLint five runtime/test paths zero errors; runner/type-driver syntax and diff whitespace pass. Official scanner4310 tracked files / 0 corrections after staging only four own artifacts; no global runtime/browser/CI claim.

## Reproduction and budgets

Copy the focal runner, driver and derivative into the EXACT subject checkout; proof branch is not the subject. Copy immutable original from the prior proof solely when reproducing its diagnostic. Runner pins HEAD and rejects changed app/lib/config/cost source. `red` substitutes ONLY dba membership-pause.ts, keeping final tests and registrations. No author-ref update.

Before each child:20k MemoryRedis.run including nested calls;100 mock fetch;120s wall;512MiB heap;256KiB output. Type driver1024MiB. Before module loading fetch and node:http(s) deny external I/O; only admitted fixture mocks run. No Redis server, Lua engine, Stripe request, real money, browser, deployed-route execution, API account/configuration change or CI operation. Serial root, zero subagents.

Main read-only fetch45bddafa5f5c3a15793147a2f80c903882f022e7; normative/reservation/queue comparison against09dd shows zero delta. Open main-vermelho query empty before proof publication. This is not a fresh merge-union/gates certificate. Own product PR0; no push to author PR, new product PR, merge, queue or retry.
