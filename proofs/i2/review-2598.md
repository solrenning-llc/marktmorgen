# Independent review of #2598

Codex I2, exact source cad528b440bb9b599b2e8e663cdb4f0042aacd1a. One LOW remains in the new wording; no final no-finding/may-merge opinion. Read the entire two-file diff and the real thanks-page/preorder fulfillment paths.

## LOW: the new present-tense purchase-access claim precedes fulfillment

lib/buyer-words/preorder.ts:24 (English, with equivalent purchase-access wording in the other six translations), rendered by app/[handle]/thanks/page.tsx:243. The page selects thanksOut solely because soonOne says the product is no longer coming soon. Confirmation is scheduled in after at230, not awaited; when canConfirm is false, it is not scheduled at all. This condition does not prove that the hand-over grant already exists. The text now says "The way to open it is in your purchases" even while the real preorder remains ungiven and importedFor is empty. The paid buyer's entitlement is not disputed; the issue is the asserted currently available opening path.

Independent proof executes the ACTUAL ThanksPage and React server renderer, with controlled page-context adapters and real soonOne, confirmPreorder, queueRelease, readPreorder and importedFor. Valid hexadecimal statsId is used. A genuine stored preorder is recorded while coming soon; its release is then queued without running the hand-over. Released-page HTML asserts the opening path while grant count is0/given=false, both with confirmation deferred and with the canConfirm adapter false. The deferred test observes the two after callbacks without invoking them. Draining those callbacks in the positive control really grants access despite synthetic sender refusal; an upcoming-product control does not select released wording.

SAME four proof tests: corrected pre-product24a80da6b1f0db98051d7f92382b533bb5d6b2d5 gives4/4; final gives2controls pass/2causal failures. Only the seven product wording lines differ between those trees. This isolates the newly introduced present-access sentence; it does not declare the previous unconditional email wording correct.

Prefer wording that directs the reader to purchases without claiming that asynchronous hand-over already completed, or gate a present-access claim on confirmed hand-over. Preserve conditional email, ownership and all seven languages. A copy-only fix need not add provider calls. Keep this original counterexample and request a delta return.

## Author regression and verification

The corrected author RED24a80da6 (French nonbreaking punctuation fixed before product) is17 checks/7phrase failures,10controls pass. Final17/17 + preorders31 + languages980 =1028 ordinary green checks. Scoped strict TypeScript of the TWO CHANGED files and imports passes. ESLint of those files and the own TS proof passes. The in-memory page-context adapter is syntax-checked and both source executions complete; I do not claim a strict static typecheck of the unchanged full Next page or the transformed adapter graph. Public-data scan including the own proof and runner3700/0, staged diff-check and node syntax check pass.

Harness limitations: actual server component and React SSR, but verified-order/store/admission/headers/after/tracking/affiliate context is synthetic; unused page dependencies throw if reached. The page source is not edited: only imports are redirected in memory. This is not a signed-in HTTP/Next server/browser/real Stripe verification, inbox, native Redis, full build/global TSC/hosted CI/deployment or operating-margin certification. Real service calls use the existing Redis adapter and refusing synthetic transport. No author source, branch, reservation or CI was changed.

Rule30: nearby thanksWhen/thanksWhenAddress still promise future email delivery, as do several receipt/release strings. These are inherited triage candidates, not additional findings proved in this review, and their runtime files are not edited. The released-copy correction must not be treated as proof of every other asynchronous state.
