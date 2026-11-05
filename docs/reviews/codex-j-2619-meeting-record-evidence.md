# Independent review of #2619 — meeting record evidence

Exact reviewed head: e972bc4ac6be3dd2b9c8a9bacea3a66e5e5215d0.
Reviewer: Codex J. Before-work claim: 9b831669a97ecd6f97d154e885a5622ab911e366.

## Decision

One inherited MEDIUM consumer issue remains: unknown meeting reads still become a known zero calendar sequence in linkUpdates. I do not approve whole-flow incorporation until W/C1 coordinates that residual. The new strict reader itself closes the original malformed-record and shortened-batch cases; the real creation caller also stops overwriting the existing record in my independent case.

All three changed-file diffs were read. Only lib/meet-records.ts and the new regression test are product/test changes; the third file adds the author's reservation row. The PR description cites the superseded05h05 reservation wording. Current05h20/CX126 rules and the explicit existing-row/no-head-churn instruction must govern; no reservation/head/CI was changed by this review. This metadata point does not change the technical finding below.

## Original RED and preservation control

Author RED59efd7eea73b72b09ee5fc5414ceb247dbcf4747 was checked out unchanged: 19 tests,14 causal failures,5 passing controls. Exact final19/19. Test blob3a261d41c1230648dfe68064e1a046d07cdad32b is identical. The reader validates exact batch length, own data slots, explicit null, complete fields and matching scope, while preserving the two documented later-field defaults. Active links use the existing cleanRoom policy. The exported tolerant parser is unchanged.

Independent frozen [cdda5ac1](https://github.com/solrenning-llc/marktmorgen/blob/cdda5ac19c526cc6d76e79e92f81231fbd87a5aa/tests/j-review-2619-meeting-preservation.test.ts) calls real meetingFor with a previously stored complete record. Only its record GET is made unknown; normal lock/Redis behavior stays real against MemoryRedis, with a fail-fast provider HTTP sentinel. On original source the same case fails at one attempted replacement record SET; on final it passes with zero replacement SET, original stored JSON retained and zero provider calls. This is one reproduced RED case, not a live-provider or native-lock concurrency proof.

## MEDIUM — unknown calendar update count becomes zero

Location: lib/meet-links.ts:604–611, especially catch(() => [null,null]) followed by updates ??0.

The new readRecords correctly rejects a short batch, but linkUpdates swallows that rejection and returns0. It does the same on a Redis exception. That number is consumed as part of the calendar SEQUENCE in lib/calls.ts:1282 and app/api/store/ics/route.ts:43. Confirmed absence is legitimately0; unknown update evidence is not evidence that no meeting-link updates occurred. Returning0 can lower the emitted sequence relative to a prior known update count, so a calendar client may retain an old invitation. I executed the real helper; source consumers were inspected, not an actual HTTP route, calendar client or received invitation.

Durable [dfe35b4e](https://github.com/solrenning-llc/marktmorgen/blob/dfe35b4eb859dafe661b5003208787e463f6d047/tests/j-review-2619-calendar-unknown.test.ts):
- confirmed [null,null] returns0;
- a complete real-shaped record returns7;
- incomplete [] must refuse, but returns0;
- thrown read must refuse, but returns0.

The same unchanged four tests produce2 passing controls/2 failures on BOTH original and reviewed sources. It is explicitly inherited, not introduced by this reader. No claim that the reader's original14 failures remain open. W/C1 should assign the consumer correction within the existing coordination for occupied meeting/call paths, keep confirmed absence at0 and propagate an unknown result/refusal to calendar consumers. I did not edit any of those product paths.

Same-pattern triage only: meetingFor's outer fallback reread at lib/meet-links.ts:253 catches unknown as null; unlike linkUpdates it returns an explicitly unrecorded fallback and my control confirms it does not overwrite the record. I do not count that as a second demonstrated medium.

## Verification and limits

Ordinary final checks:19 Node tests plus179 custom checks (team100, setup21, pages21, dispute28, person-copy9). Independent preservation case adds1 passing Node test. Calendar finding remains separately4 tests/2 pass/2 fail and is never counted green.

Strict scoped TypeScript checks actual new/independent tests and real imported reader/meeting code: exit0. ESLint implementation, author test and two J proofs: exit0. Scanner with a private index including both proofs:3726 files/0 corrections; real index unchanged. Whole product diff and proof diffs:exit0. No aliases, assertions, timeouts, author ref/product/reservation/CI were changed. Normal test wiring ran with TMPDIR=/dev/shm because root disk is full.

No native Redis, provider, browser, actual calendar-client behavior, global TypeScript/full build/hosted CI or deployment result is certified.
