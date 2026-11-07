# Independent review of public community About — PR #3016

## Exact scope and current restrictions

Reviewed author head `6f20aaa795a43aae4217f739f594c154594c7a4b`, against its actual ancestor/base `863b7eb03a26ba2455ea7a31673f5b8fc2aa2c29` (`claude5/fix-community-manage`, stack #2997). The complete thirteen-path diff was inspected. The author source, flags, gates, refs and CI remain unchanged. Reservation: channel `20b15bc59289357415c63397b4d74edd384c7447`; prior PR claim `6698797754`.

C4-3080 now requires Medium effort and serial work until the literal MAIN VERDE announcement. All three subagents were interrupted; the parent finishes this already requested review alone. No new product, PR push, merge, research unit or parallel worker is part of this review. The applicable recovery order is #2940 then #2894, subject to the coordinator's confirmation.

## Findings and limits

### MEDIUM candidate: a valid partial window becomes a false zero

With twenty-one ordinary recent feed records, the newest twenty can all be hidden while an older, still recent visible post exists. The real `aboutCounts` reads the first twenty and returns `posts: { n: 0, atLeast: true }`. The actual About page then renders **No posts in the last 30 days**. No malformed Redis response is needed for this case. The existing visible post, description and feed remain present; private member names, addresses and post text are not rendered.

The cause spans `lib/community-about.ts:191–225` (bounded window and lower-bound marker) and its wording at line 258 onward: `n === 0` is chosen before `atLeast`. The seven translations share that ordering; the executed full-page SSR case is English. This is one public veracity issue, latent when the creator enables this optional page and counts. It is not seven independently executed locale failures, a privacy leak or a new billing claim. A lower bound of zero must not be presented as an exact absence. Do not expand the reading window or change a commercial limit to hide the problem.

### Conditional timestamp issues

Two additional assertions fail with deliberately unusual stored timestamps. A timestamp one hour in the future counts as a post in the preceding thirty days; JSON `at: 1e309` parses as Infinity and also counts as one. The reader checks only `typeof post.at === "number"` before comparing it with the lower time bound. These are conditional veracity/validation candidates, not additional demonstrated healthy-state MEDIUMs. No financial, irreversible-data-loss or exploit consequence was established.

### Conditional read-width issue; financial impact unverified

A single injected `ZREVRANGE` reply containing twenty-five valid IDs is accepted, and the real downstream MGET receives twenty-five keys despite the declared twenty-post window. The normal fixed refresh admission remains two units. The proof establishes a read-width contract mismatch under an anomalous response. It does not establish a provider invoice, actual monetary shortfall or a new command-count overrun; MGET remains one command. Byte/cost coverage must be assessed before treating this as a financial finding. Unknown cost is not assumed zero.

Revisor 2 should execute and classify these candidates before a MEDIUM repair, as required by CX-128. The author owns the correction; this review changes no product code.

## Actual execution and provenance

Eight independent cases execute the real count reader, actual public page SSR and canonical MemoryRedis: empty feed, one visible post, hidden partial window, future timestamp, nonfinite timestamp, unknown HLEN, oversized feed reply and refused refresh. Setup and observations are counted. Result: **38 checks, four failures, 34 passing**. The four failures are the healthy false-zero case, two conditional timestamp cases and the conditional width assertion; they are not four MEDIUMs. Privacy sentinels and ordinary healthy/absence/refusal controls pass.

Author evidence is reported without manufacturing unchanged tests:

- Original feature RED `537cd1b7f799b400a314b4f37ed18b67453e3ac4` has test blob `4fde95877f715237a508a2e606c5f95922be2323`; the new About module is absent. The exact snapshot fails compilation for that missing module, with **zero runtime assertions executed**. It is not a claimed 32-check runtime RED.
- Final About test blob `b5e561112108f68697b03c76930fbd7c80000859` passes **33/33**. It differs from the first RED's test; no byte-identical 32-to-33 replay is claimed.
- Sitemap RED `127c2e93b8d2ee18686cb93d8246ca12f250e68b` and final use the same test blob `fcb1d80af20be3ea5bde8fdc4cde9b183e405fa7`. The RED prints nine failing assertions and then throws TypeError before `done`; it is **not** a completed 26-check RED. Final sitemap passes **26/26**.

The observed command ledger is 446 + 41 + 47 + 192 = **726 synthetic commands**, including the independent setup/observations. The pre-admitted aggregate ceiling is 16,000: three runtime replay groups of at most 2,000 each and eight independent cases of at most 1,250 each. Local MGET admission permits at most thirty-two keys per batch, one MiB per case and eight MiB aggregate, conservatively before reading; this test ceiling is not a product limit or a claim that the twenty-five-key product read is correct. No external provider/network or actual membership/account operation occurs. The runner has a 120-second deadline and 128-KiB combined log ceiling.

The proof uses a synthetic, explicitly enabled page configuration without changing production flags or defaults. It is server rendering of the real page, not browser navigation, hydration, keyboard, axe, assistive-technology or AAA verification.

## Reproduction

Use the evidence checkout itself as SOURCE_ROOT, so its relative Redis fixture and the product's test alias resolve to the same canonical module instance. A separate arbitrary source checkout is not a supported binding of this version of the harness. The evidence tree preserves the complete author source, adding only this report, proof and runner.

Prepare the two separate exact RED worktrees above, with the already installed lock-matching dependencies available. Then, from the evidence checkout:

```sh
TMPDIR=/dev/shm node proofs/k2/review-3016-public-about.mjs "$PWD" /absolute/path/to/537cd1b7-feature-red /absolute/path/to/127c2e93-sitemap-red
```

Do not rerun the passed phases just to reconfirm them. The runner deliberately expects the independent RED; its own exit zero verifies the recorded protocol, not a green product.

## Verification of the review artifacts

After the serial transition, the parent completed a scoped TypeScript program containing all twelve changed TS/TSX roots plus the independent proof: **13 roots, 1,242 actual imported source files, zero diagnostics, actual target ES2017**, no emit/incremental output. ESLint checked those twelve roots plus the proof and runner: **14 paths, exit zero**. No runtime proof or passed author group was repeated for these checks.

The full public-data scanner checked **4,142 tracked files, zero requiring correction**. Its findings function separately checked these three new evidence files with zero findings; EOF/trailing-whitespace checks passed, and the tracked diff against HEAD is empty. No full-project runtime suite, browser, CI cancellation, CI retry or merge is claimed. The current head is not clean for merge while the healthy false-zero candidate remains unresolved, regardless of the optional feature's default-off state.
