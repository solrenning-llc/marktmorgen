# #2608 — local podcast erasure evidence

Status: candidate MEDIUM privacy/completeness findings for C4/R2 classification.
No product fix, approval, remote publication, new product unit, or CI operation.
This follows the finding sent to N by Claude 5 at 21:11 on 6 November 2026.

## Source and execution

Head under review: `0fad82a0e8fec7c1558124bb41d33afcdac1b656`.
Exact source blobs are checked by the runner before compilation:

- podcast-access.ts: `85599110f3f843be7817b401f86af75c5d71e81c`;
- podcast-rules.ts: `fbdf2567bd88fbce87caf7bb0581e23ae083c570`.

The original exported `forgetPodcastPerson` is bundled unchanged with its real
FEED_TOKEN validator and crypto token-key derivation. Other imports resolve to
an explicit test world: GET/SET/DEL use a Map, Redis is configured, and address
normalization is trim/lowercase. Other imported operations throw if exercised.
The email in this proof is already normalized. This does not certify auth,
paid admission, provider delivery, actual grant creation, or the whole
erasePerson flow. No native Redis or provider is used. Global fetch is blocked.

One process, four cases, **1 PASS / 3 FAIL**, 12 pipeline commands.
Fixture setup makes 12 direct Map writes, plus 2 direct concurrent-writer
writes in the race case: 26 synthetic operations including those fixture
writes, below the pre-admitted ceiling of 128. The runner enforces 120 seconds
and 128 KiB captured output; the pipeline checks its ceiling before dispatch.
No downloads, installations, account operations, or paid provider traffic.

1. Healthy control: existing index/cache/token are removed, count is 3, and
   another erasure is idempotent at 0. PASS.
2. Conditional race: the fake concurrent writer replaces the index and stores
   a new synthetic grant after GET returns but before DEL. The actual function
   deletes the current index using its stale token list, returns normally,
   and leaves the new token record stored. A second actual call still leaves
   that record because the index is now absent. Observed both times:
   `{index:null,grant:true}`. FAIL of the safety invariant: either remove the
   record or report uncertainty while preserving a route to it.
3. GET `[undefined]` is supplied instead of the real token reply. The function
   does not reject; its filtering omits the token, then DEL runs on the index
   and cache. FAIL at the rejection assertion; subsequent test assertions do
   not execute after that failure.
4. The backend applies DEL, then the wrapper replaces its acknowledgement
   with `[undefined]`. The function does not reject: `Number(undefined)||0`
   returns zero. FAIL. This is specifically an applied-write/unknown-ack case,
   not evidence that this fixture leaves records stored in that fourth case.

The race is a controlled interleaving conditional on a token replacement in
that window. The replacement itself is fixture code, not an independently
exercised public feedToken/permission/erasure route. No claim is made that a
feed remains usable, that its access gate fails, or that this schedule has
occurred in production. The demonstrated retention/index behavior is real
inside the pinned exported eraser for the supplied schedule.

## Next decision

R2 should reproduce the same four cases and C4 should classify the boundary
before a source correction. Keep ownership on the same #2608. An atomic
comparison/deletion is a candidate design, but no internal three-retry loop is
copied without counting its reads, bytes, scripts, and admission first. Unknown
cost is not zero. No product quota, terms, gates, costs, registry, or config was
changed. A future correction needs a permanent RED, same-case GREEN, linked
tests/types/lint/scanner, a qualifying review, legitimate main integration and
nine NEW exact final checks after the freeze is lifted.

The test runner is self-contained apart from an existing esbuild directory:

```sh
node proofs/n/2608-podcast-erasure-race.mjs /absolute/existing/node_modules
```

Current expected exit status is 1. Source snapshots are pinned read-only
evidence, not an alternate product implementation. Only this small received
finding was investigated under C4-3080; no broad sweep or parallel agents.

## 6 November, 22:30 Fortaleza — recovered C4 review and directed F2 replay

The PR timeline contains C4's independent review comment **6694994605**, on
the exact 0fad head, with two LOW findings. The older checkpoint that only
listed an outstanding R2 review was incomplete: preserve this qualified C4
review as well. It does not close the subsequently reported erasure findings.

- F1: an unknown essential count is shown as limited/too many. C4's original
  proof is `claude4/review-n-c2-proofs@dfd140d47`,
  `tests/c4-rev3-2608-unknown-says-limited.test.ts`,
  blob `faa62c6f4cc502adb4563004cd717d98bf48f18b`.
- F2: unknown grant evidence becomes absence/404. Original C4 route proof:
  `tests/c4-rev3-2608-feed-unknown-404.test.ts`,
  blob `ed8ca79be50a578dbdc6ae8e07d232c6bf1cb02a`.

N read both original proofs but did not execute their NextRequest route or
full contact-send fixtures. Credit and the LOW classification remain C4's.
N independently executed ONE new library-only F2 case against the unchanged
source: the same canonical grant first reads successfully, then its GET
envelope gets one extra reply; readFeedToken returns null instead of unknown.
**One test / one causal failure, two pipeline commands plus one direct setup
Map write.** This is not a second new finding or independent HTTP404 proof.

The four earlier erasure cases did NOT execute again; the runner's new
allowlisted Node name filter selected only this case. No product/interface,
registry, alias/config, reference, provider, permission or admission changed.
Budget admitted before this run: one case, at most ten commands, 120 seconds,
128 KiB captured output. All these bounds were respected; network stayed
blocked. Node syntax and git diff checks passed. No product type/lint/full
scanner/linked/nine-CI claim is added. No corrective GREEN is claimed.

Directed command (current expected exit status 1):

```sh
node proofs/n/2608-podcast-erasure-race.mjs /absolute/existing/node_modules 'C4 F2:'
```

C6 separately announced mail-clicks head 768b2894d with consent/race changes.
That occupied source was not edited or tested by N; #2700 still needs explicit
ownership/order coordination. The source remained frozen under C4-3080/3090.
