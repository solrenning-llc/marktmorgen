# G — second independent financial review of #2781

Exact head832c5b8600f71c2fd86140c71791a104b564019c, exact stacked base732e55d04b92432d61e995fbda777a1fe2db31f8 (#2759). Assignment C4-20261106-0505-CX-17; first reviewer C4, G second, R1 released. Claim75cb5690 then paused621ac6df for higher-priority2783; resumedbdec5115. **Two MEDIUM findings; not cleared.**

Read entire2-path diff185 additions/32 deletions (group-buy65+/32-, new test120lines), actual reader/refund validator, group persistence/openGroup, and checkout-sweep caller. The caller catches failure and proceeds with other work; it supplies no continuation cursor to this refund walker.

## M1 — later pages starve after the page cap

lib/group-buy.ts:502–507 and552–559; misleading promise at101 that a refund past the cap waits for the next run.

The starting_after cursor is local and reset to empty every invocation. At10pages with has_more true, whole remainsfalse and no anchor/continuation is stored. The next healthy invocation starts the identical firstpage again. A1001st refund can therefore remain onpage11 without ever being examined while the first1000 remain in the query window. Not advancing an incomplete anchor is correct; absence of resumable progress is the residual.

Independent proof creates a paid group through real startGroup/createCheckout/settleGroup with synthetic provider responses. Provider fixture gives11valid chronologically ordered pages (100rows each on first10, one targetrefund on11), all fully readable. Three runs read the same10cursors, first=null every time, anchor=null every time, target openGroup still non-null. Positive control puts another refund onpage10 and confirms10reads+closedgroup. No request was made to increase/remove the10-page bound. Resume safely within the same bound and keep complete-vs-pending explicit; do not advance the committed anchor past unprocessed work.

This is a residual of the incomplete-pagination fix; the prior one-page version already missed later pages. It is not presented as new regression from a formerly working11-page traversal. A future change to source-window contents might make some pages reachable; the demonstrated stable-window executions and actual local-only cursor cannot guarantee that.

## M2 — dedup mark commits before work, preventing recovery

lib/group-buy.ts:526–531. Inherited processing inside the function this PR changes.

SADDseen occurs before a confirmed PI mapping/group-close. A transient failure leaves a permanent handled mark but an open paid group. Later healthy runs see fresh=0 and skip the uncompleted refund.

Two independent injected transport cases, with real MemoryRedis mutations:
1. SADD+GET completes, then the actual group SET is intercepted and throws BEFORE application. First invocation fails; seen=1, paid group remains open. Two later healthy invocations still leave openGroup non-null.
2. SADD+GET is applied to the real store, but the returned mapping slot is lost ([1] instead of two slots). The mapping still exists. Code silently skips and may commit the list anchor. Two later healthy invocations also cannot close the group because seen is already1.

Both have a control asserting exactly one interception, real seen=1 and still-open group before retry. No actual refund/payment/email/contact occurs. This proof establishes failure to revoke the refunded group/new-place access; it does not assert tested existing-member enrollment cleanup, external financial loss, or successful cash refund creation. Do not repair by indiscriminately deleting seen or increasing budgets: retain safe dedup plus recoverable ownership/completion and exact evidence. Product design/correction remains the author/coordinator's work.

## Executed proof and validation

- Author same final test on red401a3dcab7f912125ef6cc13f6fd1ac85f6645a4:14checks/13failures; exact final14/14.
- New independent derivative reuses only author's synthetic creation fixture, with independent assertions:7checks/5failures on prior401a3dc ->7checks/3causal failures on final832c5b860. Four controls pass on final. Page10 control improves; page11 and two interrupted-claim recoveries remain failing. No repair GREEN claimed.
- Durable proof4aff4e8d949125b117d18f3d7430c3d40741ad7a, tests/g2781-recovery.proof.ts, blob4d773ff7e02b86c4f94f1926c78132fe5d1435de. Runner19c8bce7e6415682c8726fd6680f279b988bb490/blob6a87180d uses repository aliases/environment. Remote proof matches local git hash-object.
- Ordinary11groups:293passing custom checks (author14,group61,bought12,l6sweep6,lot1reader58,flow32,digitalconsent93,placecopy17) plus34passing node:test tests (closingfamilies4,taxjournal6,costregistry24), zero failures/skips. These do not make the independent failing proof green.
- Scoped strict TypeScript actual group/refund/reader imports and proof0. ESLint0errors,3unused inherited fixture declarations in new derivative (readGroup, STRIPE_LIST_VERSION, GARBLED); no warning hidden. Scanner3907tracked/0 plus proof/runner0. Whitespace clean.

No native Redis, actual Stripe/SES/Resend, real accounts/buyers, browser, global build/CI or total company margin tested. Main/base/author refs, products, reservations, CI, merge, policies, prices, limits and gates untouched. No claim that the9checks are green. Dependency#2759 approvals are not an approval of this lot. C4 retains first financial review. G will repeat this same proof on a nominated corrective head.
