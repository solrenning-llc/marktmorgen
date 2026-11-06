# Independent Q review: #2845

Reviewed head: `8a1ab1c23e74a8f6a2b2617e0d2ddc11b1453cb2`.
PR base: `e6daff3287a52b70fe51d1899de641f4a6f0bdaf` (`claude4/ad-events-exact`).
Author RED: `275897c6944df692b50fd1ea6d9c5b9f0c9fa5c5`.

## Assessment

No demonstrated severe or medium defect introduced by this change. The protected pre-mutation configuration reads reject the additional unknown replies tested, preserve every sealed token, and make no configuration writes. The configuration fix may enter, subject to the coordinator's final decision and the repository's required checks; this review did not inspect CI.

R1's prior clean reading of this same head was reported by the coordinator. It is credited separately and is not represented as Q execution.

## Conditional inherited robustness gap (low severity)

`lib/ad-events.ts:161` validates `last` only as a JSON object, then asserts the stronger `ServerSetup.last` type. The producer at `lib/ad-events.ts:548` normally stores a numeric timestamp, a conversion kind and string platform answers. No ordinary producer path to the malformed values below was established.

When the stored value or its GET reply is malformed but still valid JSON:

- `{}` is accepted and the real `ServerEventsEditor` renders `Last purchase sent Invalid Date:`.
- `{"at":"not-a-date","meta":{"bad":true}}` renders `Invalid Date: Meta: [object Object]`.
- `{"at":{"toString":null,"valueOf":null},"meta":"Received"}` passes `serverSetup` but the real editor's static render throws `TypeError` at its `new Date(last.at)` expression (`components/server-events-editor.tsx:191`).

This behavior is inherited from the previous `parse` cast; it is not a new normal-Redis failure. It narrows the PR body's statement that `serverSetup` reads `last` exactly. A future exact validator should require a finite valid timestamp, supported kind and string answers, or treat the read as unknown. The proof renders the real component through React's server renderer; it does not prove a browser crash or the full StudioPage result.

## Post-write unknown response: scope of the no-write claim

The route first updates the config, then reads `serverSetup` to refresh its response and stored platform list. Injecting unknown replies only into that final two-command read after a healthy initial GET produces HTTP 503 after one successful config SET. A Meta removal has already taken effect while the store list still includes Meta. Repeating the same removal with healthy reads returns HTTP 200 and converges the list to the remaining three platforms, preserving their sealed tokens.

This is a conditional uncertain response after a successful write, not evidence of foreign-token loss. It does not justify a medium defect on its own. The broad route comment/body phrase "503 ... writes nothing" should be read as applying to the initial pre-mutation unknown configuration read; it is not a transaction guarantee for the final refresh.

## Execution

The complete four-file diff was read through GitHub after the coordinator's GO and channel announcement. Source execution used a private detached sparse worktree; every loaded product file came from the exact frozen head. The author RED was checked out in that same private worktree, run, and restored before further tests.

- Author test at RED: 36 checks, 31 failing.
- Author test at frozen head: 36 checks, all passing.
- Independent proof: 58 invariant assertions, 6 post-write/retry assertions and 5 malformed-last assertions, all passing as observations of actual behavior.
- Related tests: server-conversions 42/42; ad-events-exact-marks 11/11; ad-event-ids 56/56; ad-event-relay 28/28; sg2-unknown-replies 125/125; numbers-five 37/37. Total: 299/299.

The independent negatives cover extra pipeline slots, sparse slots, explicit undefined, JSON booleans/arrays/null, nested or null config fields, raw objects, sealed token byte preservation, no config SET before validation, sender rejection before any provider fetch, and malformed customer-list data. Healthy changes retain the other four fields and Pinterest account. Existing exact claim tests cover only `OK` ownership and exact `EXISTS` values; this PR does not modify those helpers.

The initial disk exhaustion happened while writing the runner, before any test, and was a setup failure. Additional sparse-file omissions caused setup-only ENOENT/build attempts; after including the exact required files, the affected tests passed. Already-passing related files were not repeated. The own proof was extended and rerun to verify newly added convergence and render observations.

## Consumers and cost

`sendServerPurchase` reads the configuration before its claim; `sendPaidOrders` and `sendRenewals` do preliminary existence reads but read the configuration before taking a sent mark; `sendServerLead` reads it before its claim. Their route/cron callers catch and log the throw. No normal config write or new Redis command is introduced by this diff: the existing one-command and two-command GET pipelines remain the same. There is no new data family, retention period or provider request in the changed code. This is not a full financial or runtime-cost certification.

Not executed: native Redis, real providers/accounts, HTTP transport against a service, browser or full StudioPage rendering, global TypeScript, lint, client-bundle audit, full suite, CI, production/deployment verification, human accessibility or AAA certification.

## Reproduction

Run `TMPDIR=/dev/shm node proofs/q/review-2845.mjs q-2845-config.proof.ts` at the frozen product head plus these review artifacts. The runner uses the repository's own `testAliases` and `testEnvironment`; Redis and provider calls are synthetic. For the author's RED, run the runner with `ad-events-config-exact.test.ts` on the exact RED commit. No product source, author branch or author CI was changed by this review.
