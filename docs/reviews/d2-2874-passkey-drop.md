# D2 independent security review of PR #2874

Exact head: e46c69c51628ca97db9e3c302e9abd715ae9cee7.
Claim before diff/source/tests: channeld6a86e8af2918292b1503d4654894f583cb08535.
Coordinator Claude4 only. C5's original A5 finding and corrective work are credited, not rediscovered or replaced.

## HIGH proposed, conditional and inherited: non-null empty removal evidence still authenticates a due key

Location: lib/passkeys.ts:459-463 (the final moments.length conditional of readDrop), reaching signInWith:816-818 and app/api/auth/passkey/signin/route.ts:54-103.

Only a GET null is the reader's confirmed absence. Modern writeDrop DELs an empty record; it never SETs an empty atOf map. However the parser accepts a non-null JSON record with zero moments and returns null. The modern and legacy variants both fall through this path.

Executed three independent vectors, with a genuine overdue removal record still stored:
1. GET answers JSON {atOf:{},told:0}.
2. GET answers legacy JSON {ids:[],at:past,told:0}.
3. GET answers {atOf:{},ids:[theDueKey],at:past,told:0}.

Each vector reaches the PRODUCTION local passkey POST handler with a freshly signed P-256 assertion. It answers HTTP200 and sets the real SESSION_COOKIE. The genuine stored due-removal record remains byte-identical. Once the read is sound again, the SAME credential is refused401 and actually removed. Healthy controls also verify ordinary no-removal login200+cookie and genuine due-removal refusal401+no cookie.

Thus the observed residual is a due credential authenticating from unknown/non-writer removal evidence. It requires the malformed read boundary; no public remote exploit or ability to change Redis is asserted. No additional claim is made that the proof seeded/cancelled an authenticator-reset request: that downstream action was source-inspected only.

The exact SAME11 assertions give3causal failures/8controls on BOTH the original8b4ceab6 product preimage and finale46c. This is an INHERITED missed vector, not a regression introduced by the PR. It extends the original A5 class rather than claiming the original discovery.

Suggested correction: a non-null record with no valid removal moments must throw UnknownReplyError, keeping known absence exclusive to GET null. Preserve healthy nonempty modern/legacy records; no new command, policy, key or flag is needed. Revisor2 is asked to execute the unchanged proof and confirm the proposed HIGH classification before it is called resolved.

## Durable proof and bounded execution

The proof was durably published BEFORE grading:
codex/d-review-2874-passkey-drop@5b87461a1a9931918accf925a1f0b9ccfacd7189
- tests/d2-2874.proof.ts, blob a9fec307e54dfe6c943f65d2b0bc3b29d34ddce2.
- 11 assertions,3 failures and8 controls; immutable.
- 246 synthetic Redis commands under a5000 ceiling installed before setup.
- Synthetic provider fetch ceiling20 installed before setup; actual syntheticFetches0.
- The actual installed WebAuthn server verifier checks synthetic P-256 assertions; no browser/hardware credential or remote service is used.
- Native MemoryRedis and local NextRequest/POST functions, not native external Redis or a deployed authenticated browser flow.

Run at the reviewed product snapshot or this evidence branch, with existing dependencies:
```sh
node proofs/d2/review-2874.mjs proof
node proofs/d2/review-2874.mjs validation
```
Proof mode is expected to exit1 while the3 failures remain. It uses the immutable proof commit and overlays exactly two pinned preimage production modules for the historical comparison. No assertion changes or prototype fixture corrections were required.

## Canonical fix verified, with limits

- SAME authored test97checks/51failures on8b4c -> finale46c97/97.
- 16exact-head linked files1069/1069, including authored97, API second-step, claim/list/move, locked deletes, reset notices, second-step gates, security pages/FAQ, unknown replies, sign-in history, team sessions and two-step.
- Directed strict TypeScript745source files/0diagnostics including independent proof, two product paths, authored test and transitive imports.
- ESLint: proof stdin and all three changed source/test paths pass.
- Public-data scanner4128tracked files/0corrections; no claim the tracked scanner also scanned the in-memory proof. All fixture addresses are fictional example.com data.
- Diff check passes; own checkout index/working files match native exact tree828ca26e77d58379ad636b080b8cdf6982f66be1.
- readDrop callers inventoried: signInWith/removeDue, pendingRemoval/pendingNow, unlessSetToGo, cancellation/removal/scheduling, discard/holds/move, liveSecondStep/mayAddNow and login completion/move routes. The route cleanup/cookie behavior was read in full. Ordinary malformed vectors now refuse as intended; empty records are the demonstrated residual.
- The author's already disclosed studio pending-removal notice fallback is not counted as another D2 discovery.
- No global TypeScript/client build/CI certification, native Redis, browser, screen reader or external provider/account/payment/contact.
- Accessibility: no new UI was edited by D2; expected refusal uses the existing server_error path. No human AAA certification.
- No author source/ref/CI, visible limit, price, commission, flag, gate, reservation document or policy was changed.

This is ONE independent findings review, not either of the two qualifying clean security opinions or nine exact-head successes. Do not merge as clean while the residual persists. Repair in the same author PR with unchanged11 as RED, register a permanent normal-CI regression, then request the focal return.
