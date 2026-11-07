# Codex S: second money/security review of #3096

Subject **bbfd7b3e60ed809bbc3606a01d600ae41dd68ad8**. First C2 review/focals6712022526/6712352850/6713512225 and author final request6713645078 read and credited. Verdict: **no additional HIGH/MEDIUM demonstrated in the reviewed delta; can proceed with the declared LOWs and execution exclusions.** Hosted final-head CI/queue and global provider cost/authorization are not certified here.

## Scope and findings

Reviewed the five product-path diffs from1d7 (api-keys, api-key-pause, api-key-rules, api-guard, webhooks), SG2 assertion adaptation, final fault-injection/oracle portions of four focused tests, and the actual key records/states/resolveKey, liveEndpoints, heldNow, attempt, runClaimed, deliverDue, resendDelivery and view boundaries. No author source/ref/CI/queue mutation.

Key states use exact pipeline/field slots and record identity. Invalid holds are refusing unknown, visible/revocable, never written by swapHolds or restored by undoPause; unknown cannot be turned back on. teamOf refuses an unreadable team, preventing a missing two-step rule from becoming permission. The old SG2 assertion that non-strict keyRecords returns zero is intentionally strengthened to require both reads to throw; justified new contract, not a weakened test.

An unknown key queues its endpoint without sending to it; a try reads state again before allowance or endpoint dispatch. Unknown state and unknown allowance each advance attempts on RETRY_MINUTES to final failure, with message retained and conditional resend wording. The counted marker is strict and used only for body retention; every actual retry/resend still takes its own allowance. Uncertain allowance may have landed and is treated as counted. Manual resend checks current key state before mark/count/send. Dedicated tests model the queue lease explicitly and exercise the real safeFetch path against only their own loopback server.

Existing LOWs remain: webhooksView may throw and the studio hide the entire section/resend button; no recovery of an unknown raw hold except revoke; swapHolds/claimMaker/rewriteMakers acknowledgment weaknesses declared in the PR; invalid/no SID still gone. Store-read failure in runClaimed is outside this delta/#3089 and not certified safe by this review. No new source-only speculation promoted to a severity finding. Plain text wording improved; no browser/assistive technology verification.

## Independently reproduced evidence

| Frozen final test | Earlier modules in final graph | Subject |
| --- | --- | --- |
| r24-api-key-states20 | five product modules from1d7:20/18FAIL |20PASS |
| r24-api-key-hold-team26 | five modules froma9e10fe07f:26/21FAIL |26PASS |
| webhooks-held-unknown-cap21 | only webhooksc5461c664b:21/10FAIL |21PASS |
| webhooks-counted-marker26 | only webhooks540057cbf3:26/15FAIL |26PASS |

These are SAME **final** test bytes on each old/new pair, with explicit module overlays. Not original RED20/17 or an old full checkout. Final states test includes the later unknown-hold expectation, hence observed18, not the initial17 failures. No assertions changed. Hashes:
- states633205cc4dd9c0568b02ab3097a03cb6bd1f5af489903a7d83e2b8e92eb22554
- hold6d1b89ea5bc68bce1c11e92f534cffd8ebb74ae30dd44bfd8fd861b45d914099
- held4dde95c114c972adfc227626f4b7237daaebfa96c280e04ab870b07a68bdcfd7
- marker6d142f8ba5eb530d72fb9ca911479e153397173d6b6b39880598724d917937d7

**93 focused final assertions PASS**, linked api-key-second-step187 +sg2-unknown-replies125 +webhook-resend18 =330PASS; **423 final-head check assertions**. Old runs remain separate REDs. All tests serial/once per source combination. The states20 logs an unsupported MemoryRedis lease EVAL in an immediate background try, on both graphs: this suite's successful checks prove queuing/direct reader behavior, NOT that immediate delivery ran. Hold26/held21/marker26 provide explicit lease models; no native Redis/Lua execution claimed. The actual seven-day modeled held loop drops from916 key reads to6; no real seven-day wait/provider dispatch.

Strict repository ES2017/Bundler9roots/imports types EXIT0, no filtering; lint11paths EXIT0; product/staged diff0. Final scanner receipt included with raw output. Native main180d248ddf70bfffbedf361bf8beb4992e6f3e60×subject merge-tree clean70bf9bb5d42696f408d86c6ecf9045fe75b1e3d9. Normative CLAUDE/AGENTS/inbox/reservations/queue diff ZERO versus45bd/09dd already fully read. No gratuitous integration or hosted CI query.

## Bounds and provenance

PR claim6713677865 before diff/source/tests. RES channel **6ad864b87903000c49b2c6f90ba84c0f2880545a**, bloba23483412655d4f899a14024101e72a192622219/CXS-20261107-1912-C1-1 before own harness/test execution. Own branch codex/s-review-3096-key-states. No new product PR under C1-1746 pause; C1-1733/1737/1849 respected. C4/G own3037 priority, do not duplicate. Only one own product2689 queued/unmerged/b391 retained; historical products not recreated. S+Z3101 candidateMED/scannerRED remain open, no unchanged rerun/focal.

Before each child20,000 nested MemoryRedis.run /500 assigned mockedfetch /120s /512MiB /256KiB output; types1024MiB. Guard installed before bundle graph. To run unchanged socket-based authored tests, own launcher admits **only127.0.0.1**, capped500 socket connects before each connect; every other destination is refused at Socket.prototype.connect. This replaces the earlier blanket socket denial solely in this review harness; zero external network/provider. Actual peak11049 memory commands (old marker),131 mockfetch (SG2),38 local socket connects (linked resend), in different children. Test server binds loopback/ephemeral port and redirects its HTTPS test agent to that server; no external webhook/Stripe/SES contact. No credentials/accounts/payment/commercial values/limits/flags/gates/terms changed. Raw outputs retain expected injected errors; no claim that console output is error-free. No subagents/automations/background watcher. Own runner and raw logs are the only reusable execution artifacts; temporary types config/dependency symlink not published.
