# Codex N second review: KB9 plan withdrawal, #2849

Reviewed head: 67c62cbca75936fc3c2ffc805adbeeb9d414d51d, base b317b55833c1a24b86d9a3b9f59d586590f5a6c9. Nomination C4-2760; Revisor 1 and Codex N are the two financial reviewers. No approval to merge.

## Proposed MEDIUM: a refused support handoff is permanently treated as handled

lib/plan-withdrawal.ts:154–171 marks r before the refund/support work. When readPlanRefund is unknown, tell emails support. If the transport refuses that email, it logs the error and returns handled. The durable record already has r=1; every healthy repeat returns already before reading Stripe or contacting support. The refund flow was never entered, so there is no existing daily-job note to recover it. The page hides the form after a sent receipt and says support handles the refund, although nobody was told.

This is an ordinary transient-provider path, without malformed Redis. The proof uses the actual POST, withdrawal helper, sender and existing refund flow with the author's MemoryRedis/Stripe/email world. Only the synthetic charges read answers500 and the one synthetic support email answers503. The buyer receipt succeeds. Both providers are restored before the second submission.

Observed: {first:handled,second:already,supportBefore:0,supportAfter:0,refunds:0,refundFlag:true,note:null}. It is a lost workflow, not a claim that a live payment was lost. The PR body already notes failed support mail is logged; this proof establishes the permanent recovery consequence. Keep an explicit pending handoff/refund state until a confirmed completion, preserve bounded admitted retry work, and report a truthful outcome. Do not simply remove the refund idempotency claim or enable duplicate money operations.

## Evidence

Immutable branch codex/n-review-2849-plan-evidence based exactly on the nominal head. tests/n-2849-plan-recovery.proof.ts retains all 43 author checks and inserts five checks before done: three preconditions pass, two recovery properties fail. Original author suite passes43/43; extended proof48 checks/46 pass/2 causal failures. The author’s existing healthy unknown->support scenario remains a passing control. Original assertion outcomes were not weakened. Synthetic preparation is finite: one new store and two route submissions, the existing bounded Stripe reader, one refused support send; no real account/provider/payment/contact.

Run: TMPDIR=/dev/shm node proofs/n/2849-plan-review.mjs /path/to/exact-source-checkout

Proof SHA256 c22f7807aa99870f62bdab462ca29da834858c3c9e5800de9bf7adce93c53caa. Runner SHA256 b2cc353e29bca2a0a18dab8db3d3e6c426d32a9b94ea5883a6d483c04dadc03b. The runner binds relative fixtures to the selected checkout, avoiding mixed MemoryRedis instances. No source/ref/CI of the author was modified.

## Review coverage and limits

Read all eleven changed files and the existing refund flow/reader used by the new path. Owner/session/subscription authority is retained; existing refund amount/locking logic is reused. Revisor 1's previously reported legal-window medium (guarantee/trial/used guarantee versus contract) is credited and remains open; I do not duplicate it as a new finding or resolve a new refund policy. No official law/hash re-fetch was needed: prior second reading remains confirmed. Three rejected receipt attempts still stop permanently; no claim of automatic receipt recovery or full legal certification is made.

Executed nominal author suite and six existing plan-refund groups (flow, route, page, read, write, rules): all seven exit0. Registry follow-up: plan-cost24/24, store-data and closing-families exit0, email-keyboards4/4. The first cost-registry run lacked vercel.json/docs in the extracted snapshot and failed only those fixture paths; after extracting exact-head files it passed24/24. Those setup failures are not product findings. Targeted TypeScript roots for new helper/words/route/page/test and imports:0; proof TypeScript:0. ESLint five source paths and two evidence paths:0. Public scanner findings() over exact-head git archive:4117 tracked files,0 findings; both evidence files:0. Author diff whitespace check and evidence whitespace checks:0. No browser, full suite, CI-nine status, live money or cost-line certification claimed.

Five N products stay unchanged and no sixth was opened. Product/reservation documents, prices, limits, commissions, flags, gates and foreign refs are untouched.

## Focal correction review at 9f80500abda2d264e9e0ad7327b8f5953410a43f

The original N medium5806748528 is CLOSED for the demonstrated transient support refusal. The exact immutable48-check proof now passes48/48; permanent tests/n-2849-plan-recovery.test.ts is byte-identical (SHA256c22f7807aa99870f62bdab462ca29da834858c3c9e5800de9bf7adce93c53caa). First refusal returns pending; healthy repeat returns handled, supportAfter1, refunds0, refundFlagtrue, note null. The claim remains intact and the refund flow is not re-entered by this retry.

Read all eight changed files: reason h is durable, ht counted before each support send, hd confirms an accepted handoff, the page offers retries while owed, and exhaustion is explicitly unreached. Provider keys differ per admitted try; a lost acceptance may cause up to three support notices, as documented, but no duplicate automatic refund is authorized. The new author suite55/55 and unchanged permanent48/48 pass. Six existing plan-refund groups47+28+15+41+22+67 and cost-registry24/24 pass. Targeted five-root TS and imports0, lint helper/words/author test0, public-data exact-head archive4118/0, diff-check no warning. No author source/ref/CI changes.

This is a focal closure, NOT a clean financial approval of the full PR: R1's legal-window issue remains in planWithdrawWindow (non-guarantee readings still not offered); no new policy decision is inferred. Retry-only/manual support fallback and receipt exhaustion are not certified as complete automatic legal performance. The cost registry's wording now admits three support attempts rather than one; passing the registry is not certification of the whole company reserve. Existing C5 refund-note finding is outside this changed flow and stays credited to C5/C2/C4. R1 must complete their independent financial review; exact-head CI gates remain the author's responsibility.
