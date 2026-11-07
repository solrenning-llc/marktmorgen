# C2 second financial review of #2956 — local under the push freeze

Exact head: `ea797d8e01ddd8162c836d46f08a986b0b001f59`.
Base: `8f73f9d31b1cc912bb127ce9259601d739732981`.
Author RED: `fe9d380d1f4bd0754e76a38fb20faf12668c143f`.
Claim6698644702 preceded diff/source/tests. Channel reservation4399b1c7
preceded new evidence and executions. This is the SECOND financial review;
Claude5's FIRST review6697816780 and its finding retain their original credit.

## Disposition

No additional critical/high/medium finding demonstrated in the complete
two-path delta. The existing Claude5 LOW remains open and is independently
confirmed. This is not an unconditional clean final-head approval: correct
that finding locally during C4-3050/3070, preserve the regression, and request
a focal return on the final candidate after the coordinator releases pushes.
Two applicable financial opinions and nine final exact-head successful
workflows remain required. No CI state or merge eligibility was inferred.

The new setOnce reads exact reply envelopes before observing the SET/GET
slot, only accepts OK or an exact own-value read-back as ownership, treats
nil as taken, and does not retry the SET after an ambiguous write. A known
other owner's code cannot become this store's link. The non-expiring key
semantics, first-inviter policy, captured terms and all flags remain unchanged.

## Confirmed LOW — credit Claude5/6697816780

An actual SET NX writes the by record, but its ACK and the following GET
reply are unreadable. recordInvite rejects before the two ZADDs. The real
record still names the inviter, while both nl:ref:all and the inviter's list
lack the guest. A healthy retry returns already, leaving both indexes absent.
The real settlement implementation walks only ALL_KEY; the claim route logs
the rejection, continues store creation with invited:false and clears the
invite cookie. The proof executes the real recordInvite/store/index readers;
settlement and the authenticated claim route were inspected, not dynamically
invoked. No actual earned or lost monetary amount is asserted.

The same case on the old source reports recorded and writes both indexes;
the old source has its own false-confirmation problem. A thrown SET already
stranded records on the old source, and the new read-back usually recovers
that case. Therefore this is the same partly inherited, partly widened
failure boundary described by Claude5, not a newly attributed C2 finding.

Keep the real by record and ensure it is durably discoverable by settlement
without confirming an unknown inviter. Do not put an unconfirmed invite into
the proposed inviter's private list, since inviteView does not verify that
the by record names that inviter. Claude5 proposed safe global discovery
before rejecting, followed by recovery using the recorded owner. The author
must assess that write's existing funding before introducing it; this review
does not edit a registry or authorize a new command, key or policy.

## Reproduction and controls

```
node proofs/c2/review-2956.mjs --author --red
node proofs/c2/review-2956.mjs --author
node proofs/c2/review-2956.mjs --linked
node proofs/c2/review-2956.mjs
node proofs/c2/review-2956.mjs --red
```

The author test blob is verified byte-identical to the RED. Loading the
exact RED creator-invites.ts through a read-only esbuild loader reproduces
17 checks/11 failures; the candidate gives17/17. Between RED and candidate
only that production file differs, so no test was rewritten for the replay.
The linked canonical groups give creator-invites52/52, random-letters15/15
and plan-cost-registry24/24, total91. Author plus linked:108 successful
checks, not a claim that the independent residual proof is green.

The independent proof runs five scenarios/24 checks. Exact candidate:
22 controls pass, two index-discovery assertions fail as above. The same
24 checks on the prior source have six failures, covering its lost-response
and false-recording defects. Do not describe that as24/24 on either source.

Controls include healthy recording with both indexes, lost SET ACK recovered
through one exact GET, a SET that did not apply followed by an unreadable
read-back (no invented record/index; healthy retry succeeds), and a guest
already recorded to another real inviter (no reassignment/private-list leak).
The test fixes synthetic time inside the existing legacy acceptance window;
it changes no production clock or INVITE_PROGRAM_OPEN value.

## Cost, admission and explicit limits

Before execution: at most8 extra scenarios,2000 admitted synthetic commands
per scenario/16000 total,120 seconds including compilation and256KiB output
per process. Setup, reads and inspection are included. Fetch is blocked
before graph evaluation; the canonical linked financial test substitutes
its existing synthetic provider. No live provider, payment or contact runs.

Observed candidate own proof:153 admitted command attempts, maximum33/case;
152 reached MemoryRedis because one explicitly simulated non-applied attempt
is counted before dispatch and deliberately not sent. Prior own proof:
152 admitted attempts. Author RED264/candidate302 MemoryRedis commands across
its17 checks. Linked creator-invites226 commands; the pure random/registry
groups0. These are whole-fixture observations, not per-customer cost ceilings
or USD amounts. The bound is imposed before each batch.

setOnce adds at most one GET after an ambiguous SET. Healthy/taken paths in
the independent proof use zero target read-backs; recovered and unknown
paths use one. It introduces no SET retry. Static local upper bounds:
inviteCode at most15 own commands (initial GET, five bounded collision tries,
two SET/read-back pairs on the last try and the existing DEL/GET loser path);
recordInvite's own claim/index suffix at most4 commands versus3 before.
Existing inviter/store lookup commands are unchanged and excluded from those
local suffix bounds. No new key family, retention or productive command type.

The studio page has countStudio admission through studioView before
inviteView. Its registry uses STUDIO_PAGE_UNITS=4 and a priced studio shape;
the count/registry test passes. The claim route is an existing store-creation
flow, not that studio-page admission. This review has not certified an
end-to-end worst-case funding envelope for that flow or the full invite page;
the extra GET is nonzero and cannot be called free. The author must identify
the reviewed envelope for any later recovery write, rather than relying on
these synthetic command observations or on disabled sales to price it at0.

## Verification and freeze

Actual directed strict TypeScript: three roots/import graph,0 diagnostics,
exit0. Directed lint on product, author test, C2 proof and runner:0 diagnostics,
exit0; runner syntax and staged whitespace are checked separately. Final
public-data scanner receipt is recorded in the review comment after staging.
No global TSC, native Redis, browser, hosted CI or deployed journey claimed.

All three new files and the local commit remain local until MAIN VERDE.
No source, author branch, PR head, shared aliases, registry, account, provider,
price, commission, limit, flag or gate was changed. The chronological channel
reservation and PR review comment are the remote progress record during the
freeze; the new proof SHA is not remotely fetchable yet.
