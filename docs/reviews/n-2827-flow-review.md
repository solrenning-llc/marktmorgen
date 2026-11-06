# Codex N review of KB9 unit 1b — #2827

Reviewed head: 70244c2cfeac566c29f2ea67bbb3901c1e22b24a. 6 November 2026.
Nomination: C4-2630/C4-2640/C4-2700, second reviewer alongside Revisor 1.

## Proposed medium 1: a refused acknowledgement cannot recover

lib/withdrawal.ts:82–97 writes the one-time marker before sending, then returns already whenever SET NX sees that marker. A single temporary 503 from the synthetic email provider makes the actual route return unsent. Repeating the same valid submission after the provider is healthy returns already, with zero accepted acknowledgement emails. The record only contains a timestamp; there is no pending content/recipient or recovery state in this new family. The page suppresses further confirmation after the marker exists.

Observed: {first:unsent, second:already, refused:1, acknowledgements:0}.

Article 11a(4)'s durable acknowledgement is not fulfilled by an on-screen timestamp or an instruction to ask for a copy. Preserve the declaration once, but keep unconfirmed delivery recoverable with bounded, pre-funded attempts and an explicit pending state. Do not make a delivered marker mean that receipt delivery was confirmed.

## Proposed medium 2: creator notice refused by a real quota, but reported done

lib/withdrawal.ts:99–102 ignores fileContact's boolean result. The actual inbox limiter accepts sixty fixture preparations and then refuses another new conversation. A valid withdrawal still returns done, the buyer's acknowledgement claims it was passed to the creator, and readInbox returns zero conversations. This ordinary quota path does not require an anomalous Redis reply or provider failure.

Observed: {state:done, inbox:0, claimsPassed:true}.

The owner's decision makes this notification the route by which the creator learns to cancel/refund. Preserve a recoverable notice or return a truthful pending/unavailable outcome; do not silently discard it or state it was passed on. Its storage, retry and delivery costs need the existing explicit per-order ceiling and admission before spending.

## Reproduction

TMPDIR=/dev/shm node proofs/n/2827-flow-review.mjs [source-checkout]

The proof preserves the author's complete original five tests and fixture byte-for-byte as its prefix, then adds two independent scenarios using the real POST route, withdrawal helper, sender path, inbox and limiter. It uses only the project's synthetic Stripe/email fetch fixture and MemoryRedis. The provider refusal replaces one synthetic email response with HTTP503; the inbox case consumes the real limiter through its public function, without forging a Redis receipt. The preparation has a finite bound checked before its calls. All fetch changes are restored in finally. No provider, account, payment or contact is real.

Result at the reviewed head: seven tests, five original controls passing, two independent causal failures. The assertions and original test prefix are immutable evidence for focal re-review.

## Other scope

The official source/hash second reading is already complete in the earlier report. The existing pre-order scheduled-release medium and Revisor 1's late physical-delivery issue remain open at this head. No additional full certification is claimed for the plan's cost registry by its email-site entry alone. The complete sixteen-file patch and the new withdrawal page, route, rules, helper, buyer order consent fields, registry changes and seven-language words were read. No Stripe write was added by the feature.

The author branch/ref/CI and all five N product units remain unchanged. This evidence adds no product, reservation document, workflow, price, limit, commission, flag, account, payment, term or external contact. Unit1b is not clean pending the two recovery issues and the outstanding rules findings.
