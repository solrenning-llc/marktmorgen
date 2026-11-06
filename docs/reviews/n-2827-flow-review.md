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

## Focal re-review at b317b55833c1a24b86d9a3b9f59d586590f5a6c9 (6 November 2026)

The original seven-test evidence at 8f61e170 is unchanged. Running that bundle across checkouts initially mixed the proof checkout's relative Redis/after fixtures with the selected source checkout's aliases. Those setup failures are harness errors, not product findings. The new hash also makes direct GET timestamp assertions incompatible (WRONGTYPE in the new MemoryRedis). No such failure is counted below.

A separately named v2 variant uses the exported withdrawnAt for the four record-presence/absence assertion expressions, removes the unused withdrawalKey import, and retains the same seven scenarios, expected outcomes, quota preparation and mail assertions. The v2 runner resolves entry-relative fixture imports against the selected source tests directory. It never edits author source or the original proof. SHA-256 proof 71493f576cd27a125c4b0c5cec6d9a372f47ed8ea0a49cde7e5077b1f3551653; runner f6ff8bd903290ab05d47e3042c9aa21fafe49975a6d6eb18799f33cdf460b8e8.

Reproduce: TMPDIR=/dev/shm node proofs/n/2827-flow-review-v2.mjs /path/to/exact-source-checkout

- At original 70244c2c: 7 tests, 5 pass, 2 causal failures. Mail: unsent then already, zero acknowledgements. Inbox: done, zero conversations, buyer copy claims passed.
- At b317b558: 7 tests, 6 pass, 1 causal failure. Mail: unsent then done, exactly one acknowledgement. Inbox: done, zero conversations, buyer copy still claims passed.

The single-transient-refusal example of proposed medium 1 is CLOSED by the resend state. This does not close Revisor 1's separately reproduced exhaustion case: three refusals consume all attempts, then healthy retries return already without a receipt; store transactional quota still gates the legal acknowledgement. This report credits R1's existing case and does not claim an independent replay of that extended case. C4-2760 permits an order cost line, but the author's 66.06 first-year calculation exceeds the stated 66 ceiling and is explicitly stopped pending a decision. No ceiling or money rule was changed by this review.

Proposed medium 2 remains OPEN, lib/withdrawal.ts:155-160: fileContact(false) is discarded and only the statement that created the record attempts it. The real limiter exhaustion remains reproducible with a successful buyer acknowledgement and no stored creator notice. A declaration cannot truthfully be reported fully done with no recoverable creator notice.

Validation of b317b558: author withdrawal 6/6; rules 38/38; permanent original N rule evidence 5/5; digital-consent 93/93. Targeted TypeScript program (withdrawal/rules, author flow and permanent rule test roots with their imports): zero diagnostics. ESLint on those four paths: exit0. check_public_data.py findings on both new proof/runner files: zero. No browser, national-law certification, full-suite, nine-CI or money approval is claimed. R1's shipped propagation and quota findings remain theirs; original N pre-order medium remains closed. No full clean review of unit1b.
