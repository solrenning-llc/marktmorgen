# Codex J independent review of #3031

Exact author head: `7cea62bd0bdfd65f6be62c76ae428db38ce30606`.

**NOT CLEAN: three MEDIUM findings reproduced locally.** This is the first requested independent opinion on the student-private-note surface. Source/ref/CI remain read-only. New evidence is LOCAL ONLY under C4-3050/3070/3080; no push or merge occurred. Parallel workers were stopped immediately after C4-3080; the root completed this report and the fixture refinement serially.

## Reproduced findings

1. **MEDIUM, lost acknowledged note.** `lib/lesson-notes.ts:115–136` checks `was` and then writes in a separate HSET after room admission. Two legitimate saves starting from the same original both pass the read, both return success, and only the second replacement remains. The controlled barrier delays the two real HLEN/HGET replies until both requests have read the same state; all writes and MemoryRedis behavior are normal. Thirteen synthetic commands including setup/read-back. Healthy sequential save/stale-tab refusal passes. The source comment acknowledges this race, but acknowledging it does not satisfy the promised protection against overwriting a newer note.

2. **MEDIUM, the declared store-wide 300-note bound is not atomic.** A valid 299-note hash spread over two courses admits two different new notes concurrently; both return success and HLEN becomes301. Each course stays within the existing200-lesson bound. The count check and write need one coherent atomic protocol, together with room admission and stale-value validation. Ten synthetic commands including setup and the final count. This does not authorize raising a cap or changing commercial terms.

3. **MEDIUM, the download's complete database transfer exceeds its admitted public-request unit.** The real GET admits one `takeBuyerRead(store)`, then `notesOf` reads every course's hash before the route filters it. A healthy maximum300 notes, each4000 code points (emoji), spread200+100 over two courses, produces **4,824,321 serialized database-reply bytes** from HKEYS/HMGET and **3,209,639 exported bytes** after the same course filter. Eight measured commands including setup; the seven read commands are all included in the reply-byte measurement. The repository's database-transfer coefficient alone gives **USD0.00014472963**, already above the complete single public-request model **USD0.00006329111111111112**. Commands, compute and origin transfer are excluded from that lower bound. Admit the full measured graph before reading within the existing reviewed model; do not treat unknown cost as zero or change price/visible limits/gates.

The cost exercise invokes the real reader/formatter and checks the real route's admission/filter source; it does not invoke the authenticated GET or measure an actual provider bill. It is a synthetic bounded-cost counterexample, not a real financial loss.

## Proof and honest refinements

Final `tests/j-review-3031-private-notes.proof.ts`: **4 tests,1 healthy control passes and3 causal failures**. No GREEN is claimed for this proof. Source files are unmodified.

The initial proof is preserved in local commit `9df1e48a999c38293972a74f628b6cfdcc15bed1`. It seeded300 notes in one course and compared raw origin transfer. Root corrected only setup/measurement before this final qualification: distribute dates/fields across two courses to respect MAX_LESSONS200; apply the real course filter before formatting; compare the complete database reply to the canonical database-transfer coefficient, avoiding an unsupported raw-origin/compression premise. The three original expected safety outcomes were not weakened. Initial logs remain intact. The refined run retained the same three causal failures.

## Validation and boundaries

- Complete16-path delta and author source/test read. Author final85/85 passes.
- Seven related groups145 passes: person-data-registry20, person-copy20, person-erasure32, store-data-registry7, store-data33, buyer-actions9, plan-cost-registry24. Author85 plus related145 =230 ordinary passing checks, separate from the four-case failing proof.
- The whole author RED `3fc388cf8eeac7950c3f917db122db33c9a3a1a0` failed compilation because it uses top-level await with the canonical CJS bundler. That is a build/setup result, not85 causal assertion failures. No shim or weakened assertions were introduced to call it RED.
- Actual strict ES2017 directed TypeScript and transitive imports: zero diagnostics; scoped proof/runner lint: zero. Prior broader source lint/types also passed. Final evidence scan and diff receipts are in the output.
- The runner blocks global fetch, socket, HTTP(S) and TLS before each product graph; its transport negative control runs first. The graph uses canonical MemoryRedis/data-room aliases. No provider, email, account, real student, payment, browser or native Redis was used. Authorization/privacy ownership was read statically, not independently exercised as an end-to-end authenticated session.
- At most four additional scenarios,2000 commands per case,20000 aggregate,120 seconds per process and256KiB captured logs. Actual cases use11/13/10/8 commands. No global suite or hosted CI was run, cancelled or retried.
- No global legal/financial/accessibility compliance is certified; the private-note ownership surface still needs its second independent opinion and corrected-head returns.

Correct the same PR locally, add permanent regressions preserving these causal cases, and request focused returns after literal MAIN VERDE permits one consolidated push. Nine new final successful checks and fresh clean state remain mandatory. Existing author and evidence refs/history are preserved.
