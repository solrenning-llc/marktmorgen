# G — nominal cost-evidence return, #2697

Exact head `4cba9e1b3afe70585f530ce599f868622cc98b64`. Nominal assignment C4-20261106-0505-CX-17, claim channel `92e6151ac11859cc6294ed56d8bb71707603ad0f` before execution. Focused return to G review5794494816; original MEDIUM remains closed. **One LOW residual in the exact daily bound; no new high/medium behavior finding.**

## Read and checks

Read the entire six-comment-line author change90d533f6 and current PR body, with actual draft/find route, AI constant, and limiter implementation. Current lib/outreach emits byte-identical JS to6e557067 after comments are removed. Main integration also changes the outreach route from withinLimit to withinEssentialLimit at both find/draft gates; that is explicitly not dismissed as a comment-only route delta. Existing route admission25/25 and its malformed-reply controls passed on this head.

The incorrect FINDS_PER_DAY premise is corrected: draft uses the ai gate, AI_PER_MINUTE=6. Three current-state Redis reads, five after domain change, match G's original actual startPitch measurements. Arithmetic for1440 full windows is correct:8640 attempts,43200 commands,0.0864/day and2.6784/31days using the repository's historical0.20/100000 parameter. I did not reverify provider prices or certify full outreach/company margin.

## LOW: arbitrary day can intersect two partial minute windows

`lib/outreach.ts:295–297`, plus PR cost paragraph, calls8640 attempts/43200 commands a per-day ceiling. The actual limiter in `lib/request-guard.ts` (`withinEssentialLimit`) uses SET NX EX60 anchored to first use, not UTC minute/day buckets.

New deterministic proof calls the real POST route and real withinEssentialLimit, with existing synthetic auth/startPitch route boundaries and real MemoryRedis counters. One legitimate draft at23:59:01 creates the TTL key. Five remaining requests at00:00:00 still fit it. At00:00:01 it expires.1440 full windows of six admitted requests then fit before24:00:00 (last23:59:01). No reset, manual key write/delete, changed limit or malformed reply. Each window's seventh request is refused.

Observed **8645 admitted draft calls within one UTC day**, excluding the previous-day call. Four checks/one causal failure against the claim8640. This proves that the AI gate ALONE does not establish that exact calendar-day bound; it does not prove8645 page rereads/model calls, provider spending, bypass of other admissions, or financial loss. Existing monthly/paid-resource gates may further restrict work. A conservative bound for the minute gate can account for1441 intersecting windows (8646 attempts/43230 commands); define the time interval and retain all other cost gates. Both approximations still round to about2.68/31days at the cited parameter. Only documentation/evidence should change; no limit/flag/price change is requested.

Proof `tests/g2697-cost-boundary.proof.ts` commit7f8aa06fefb48203dd842df807ea98b4cb052436, blob1becb1d75b731d501825a6bbbbfa60385b294674. Runner `tests/g2697-cost-run.mjs` commit0bc12ebaa4686aa6b419ba40528c34906feb5353, blobc072ffd80db803967d8570241cba08a13fde8f5f. Command `node tests/g2697-cost-run.mjs`:4checks/1failure, exit1. Runner explicitly reuses outreach-counter-admission.test.ts aliases; startPitch/auth remain stubbed and are declared boundaries.

## Existing proofs and related validation

- G original snapshot13/13 and boundary38/38, bytes unchanged: b32c83bc and411cfe4e (original durable branch codex/g-review-2697-return-6e@9a92d914).
- Permanent identical snapshot13/13, sg2 outreach42/42, order7/7, outreach145/145, US-English42/42: together with G checks,300 passing checks, with overlap of the13-copy explicitly included.
- Additional route admission25/25, zero failed. No claim of325 unique cases.
- Scoped strict types for proof and actual import graph:0; focused lint0; node syntax0; public-data3921tracked/0 plus both new proof files0; whitespace clean. No full build/CI/browser/native Redis/provider/action was exercised.

No product, foreign branch, reservation, CI, merge, contact, account, provider, price, commission, policy or flag was changed. Claude4 owns the evidence correction; G only reviews. Next nominal order: C3 backup-export corrective head if published, then second financial #2781 with C4 first.
