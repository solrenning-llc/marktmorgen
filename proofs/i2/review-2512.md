# Independent Codex I2 review of #2512

Head113e03680ec84df0716572180689b65789d37c1e. Complete four-file diff read, with sender/counter paths, actual studio caller and NudgeEditor output traced. Result: DO NOT MERGE: one inherited MEDIUM plus one inherited LOW. No author product, branch, reservation or CI changed.

## MEDIUM: successful-send bookkeeping can discard period ownership

lib/member-nudge.ts:100-111 increments its local accepted count after sendEmail returns true, then awaits INCR/EXPIRE. Either a failure before that bookkeeping applies or an acknowledgement lost after it applies enters the catch that DELs the period mark. A second real nudgeStore call acquires the mark and invokes the accepted transport collaborator again for the same member/period. Actual proof output in both variants: first1,second1,retainedAfterFirstfalse,transportAcceptances2. Healthy control: first1,repeat0,transportAcceptances1,mark retained.

This proof uses real nudgeStore and MemoryRedis with the author's controlled scoring/consent/transport collaborators. It demonstrates duplicate authorization and accepted collaborator calls, not a live provider delivery. The legacy SES marker in email.ts:324 is86400 seconds and does not replace per-paid-period ownership; the source itself disclaims lifetime idempotency. Preserve ownership after a confirmed acceptance, separating subsequent bookkeeping failure from a confirmed no-send path. Do not roll back a completed send merely because its count failed.

## LOW: unknown monthly count is presented as a known value

lib/member-nudge.ts:119-122 destructures an unchecked GET envelope and uses Number(n)||0. Missing/undefined/boolean/empty/garbage become0, negative/fraction/infinite values remain numeric, and an extra slot is ignored. app/studio/page.tsx:2001 also catches errors to0; NudgeEditor prints Sent this month:0. All nine malformed vectors produce a known number. Confirmed [null], [\"0\"] and [\"12\"] remain valid0/0/12 controls. Require unknown or explicitly partial data and coordinate the occupied studio page with its owner; throwing only in the library is not sufficient while the caller substitutes0.

## Proof and validation

Immutable proof codex/i2-review-2512-nudge-effects/7de7665a357189dd6278ea608c4d7dc714261dad,15 tests/11 failures and4 valid controls, SAME result on original productd1cdc9c1 and current head: these findings are inherited. This does not reattribute the author's fix. The unchanged final author test produces31checks/13failures against the original product and31/31 on the head. Linked member-health19,cost registry24,data registry7 ->81 ordinary green checks including author31. Scoped strict types/imports,focused lint,public-data scanner3597/0,proof syntax and complete four-file diff check pass.

No native Redis,browser,full global build,real provider,inbox,live customer or deployment was certified. No outgoing payment or commercial rule changed.

Rule30 STATIC candidates only, not independently counted findings: yearly-ask.ts:132-153 has analogous post-send counter/catch-DEL and Number(n)||0; payment-recovery.ts:281-287 and430-435 has post-send count/catch-DEL; winback-send.ts:193-196 has the same unchecked count conversion. These occupied/lane-owned files were not edited and need owner triage/proof.
