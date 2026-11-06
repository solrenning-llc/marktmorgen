# Claude 5: an unknown Redis reply read as "no store" (storeForId / storeForEmail)

Proof only (CX-123 rules 24 and 30). No product file changed. Base: origin/main at 5c0731550. Branch:
claude5/store-read-unknown-proof. Proof: `tests/store-read-unknown.proof.test.ts` (68 checks, all passing on the base,
in-memory Redis from tests/redis-stub.ts, Stripe/PayPal/video `fetch` stubbed to fail, nothing real called).

```
node /tmp/claude-0/-home-user-marktmorgen/361ec33b-f141-511f-85d1-8d3b681bab1b/scratchpad/one.mjs . store-read-unknown.proof.test.ts
```

Each part runs a healthy control, then the same call with one GET answered in four unknown shapes (no slot, a number,
an object, a record cut short). A check named DEFECT passes while the defect is present; after the fix each must be
inverted into a regression test.

## The root

- `storeForEmail` (lib/store.ts:1087-1100): `if (!Array.isArray(reply) || reply.length !== 1) return null;`, and
  `parseStore` (:924-1080) answers null for a non-string, an empty string, unparseable JSON or JSON without
  handle/name/email.
- `storeForId` (lib/store.ts:1228-1234): `const [ref] = ...; if (typeof ref !== "string" || !ref) return null;`, then
  `storeForEmail(ref)`.

Both answer the same null for "no store" and for "could not read". **105 call sites** (39 storeForId, 66 storeForEmail,
one of them storeForId's own call) in **73 files** under lib/ and app/, plus wrappers that pass the null on
(`storeOf` in lib/usage-billing.ts, `resolveAccess` in lib/studio-route.ts, lib/creator-invites.ts:134). 19 of the call
sites also wrap the read in `.catch(() => null)` / `.catch(() => undefined)`, which turns any future throw back into
"no store".

## Already in flight: #2878 (Claude 4, claude4/store-read-exact, head 97abb22d)

It makes both readers exact (nil is null; any other shape throws `UnknownReplyError` from lib/redis-reply.ts, via
`repliesFor(..., 1)`), and changes four swallowing callers (paypal-payouts:586, payment-requests:143,
discord-access:91, affiliates route:219). This proof was run against that head (a scratch copy, nothing pushed):

| Part | On main | On #2878 head 97abb22d |
| --- | --- | --- |
| 0 readers | null | throws, except **storeForId with the id key's value cut short**: still null (see gap A) |
| 1 claimHandle | store overwritten | throws (fixed) |
| 2 settleAllPayPal | taken out of the set | kept for 3 shapes; **cut short still taken out** (gap A) |
| 3 releaseRestarted | "gone", out of line | **unchanged: still "gone"** (gap B) |
| 4 eraseClosed | out of the due line, never erased | **unchanged** (gap B) |
| 5 removeStored | `{files:0, clean:true}` | throws `UnknownReplyError` in all four shapes (run); the final walk, lib/plan-closing.ts:1081-1084, catches it and keeps the store "held" (by reading) |

- **Gap A.** storeForId reads `nl:store:id:<sid>` and passes whatever string it holds to storeForEmail. A ref cut short
  (or any non-ref text) reads a different owner key, which is nil, so the answer is null "no store". Fix: before the
  second read, the ref must be exactly an owner address or `#<sid>` (`extraRef`), else `UnknownReplyError`; and once
  the record is read, a store whose sid differs is unknown, not null (only nil at either key is "no store").
- **Gap B.** 15 swallowing call sites are not touched by #2878; two of them are proven harmful here (parts 3, 4), and
  data-recount:217, erasure-request:150, app/l/[code]:25 and affiliates route:254 are harmful by reading (below).

## Callers by harm

### Proven (tests/store-read-unknown.proof.test.ts)

1. **ALTO, creator's store overwritten** - lib/store.ts:1731 `claimHandle` (app/api/store/claim/route.ts:64). An
   account that already has its first store claims again with another handle; the unknown read says "no store", the
   handle is taken and `SET ownerKey(email)` writes a fresh empty store over the existing record. The original sid no
   longer reaches any store (products, plan, Stripe link orphaned). Same chain reachable from lib/studio-route.ts:140
   (studio sends a creator with "no store" to the claim page). createStore (:1777) is the opposite (refuses "first",
   harmless).
2. **ALTO, affiliates' money on its way never settled** - lib/paypal-payouts.ts:586-590 `settleAllPayPal`. `SREM
   nl:pp:stores` for a store with an open PayPal batch: the daily job never reads the batch again, its affiliates stay
   "on their way" (excluded from every new batch and file by `onTheirWay`), never marked paid nor released to owed.
3. **ALTO, held members of a restarted store never let go** - lib/closing-holds.ts:422-426 `releaseRestarted`. A
   store whose plan runs again is answered "gone" and ZREMed from `nl:closing:held`; nothing adds it back, so its
   members' held charges are never released and the buyers are never told the store stays.
4. **MÉDIO (privacy, retention), closed store's data never erased** - lib/closed-store-data.ts:592-598 `eraseClosed`.
   The store is not prepared into the batch but is ZREMed from `nl:closed:due`: no walk deletes its records and the
   finisher (owner email) never runs.
5. **ALTO (erasure certified), files kept** - lib/plan-closing.ts:579-580 `removeStored`, read by closingDay
   (:904-909, :975-). Answers `{ files: 0, clean: true }` without listing a folder; closingDay saves `removed` and
   emails the owner that it was removed while every file is still there.

Proven earlier on claude5/sweep-a5 (docs/reviews/c5-sweep-a5.md, same root, not repeated): plan-closing.ts:706-710
`closeOne` (store taken out of ENDED/FINAL, closing day never runs: buyers' unused time not given back) and
plan-refund-flow.ts:418-424 `finishPlanRefunds` (refund note dropped, plan stop never taken back).

### Harmful by reading (no proof built)

- MÉDIO money/data: lib/creator-invite-credit.ts:205-208 (credit set `state: "gone"`, SREM owed: the inviter's credit
  is lost); lib/share-settle.ts:483-486 (SREM sharing index, HDEL applied and read-until: given-back shares never
  settled; latent while COMMISSION_LIVE is false); lib/data-recount.ts:217-227 (measured bytes HDELed without being
  applied: storage count stays wrong); lib/team.ts:281-286 (member's index entry SREMed: the store disappears from
  their list for good); lib/team.ts:646-647 (address move skips the store: membership left on the old address).
- MÉDIO email: lib/payment-requests.ts:143-148 (buyer's payment reminder dropped; fixed by #2878);
  lib/welcome-offer-send.ts:115-118 (ZREM first, then dropped: the reminder is never sent); lib/erasure-request.ts:150
  (deletion link emailed for fewer stores, or not at all, while the answer was already "sent");
  app/api/store/affiliates/route.ts:254 (a person who has a store gets an inbox invitation instead of the studio one);
  app/api/store/address/route.ts:77 (move invitation sent to an address that has a store; re-checked at the tap).
- MÉDIO cost ceiling: app/api/cron/usage/route.ts:111 via `storeOf` (a store over its video limit is not paused this
  run); lib/usage-billing.ts:223 `settleUsage` (usage owed computed with `store = null`).
- LEVE public cache: app/l/[code]/route.ts:25 (302 to /l/ended with `s-maxage=600`: a live link served as ended for
  ten minutes).
- Discord: lib/discord-access.ts:91 (counted "gone", not rescheduled; fixed by #2878);
  app/api/discord/callback/route.ts:32 (trip already taken, buyer sent home: LEVE).

### Harmless (404, sign-in redirect, empty list, retried next run)

The other 35 call sites in 34 studio API route files under app/api/store/ read the signed-in creator's store (answer "no store",
nothing written), app/numbers/[id]/page.tsx, app/api/numbers-link/route.ts, app/library/page.tsx,
app/affiliate/page.tsx, app/invite/[code]/page.tsx, lib/buyer-library.ts:116, lib/affiliate-directory.ts:238,
lib/affiliate-hub.ts:93 ("error"), lib/api-guard.ts:150, lib/team.ts:553/597, lib/meta-ads.ts:497 ("none"),
lib/imports.ts:1264/1324/1432 (skipped, next run), lib/creator-invite-credit.ts:76/116, lib/erasure-request.ts:243
(already throws) and :307 (already "later"), lib/watch.ts:138 (falls back to the calendar month), lib/move-repair.ts,
lib/store-copy.ts:411, lib/clickfunnels-funnel.ts (falls back to the store in hand), lib/plan-refund-flow.ts:250/256
(same), lib/demo-seed.ts, lib/plan-disputes.ts:63, lib/plan-pause.ts:694, the lib/store.ts internal readers
(moveStoreToRecords answers false; the others refuse). app/api/auth/move/route.ts:187 already maps a throw to
"unknown" but reads null for an unknown shape; on #2878 it is right.

## Proposed fix shape

1. Readers (as #2878, plus gap A): nil at the id key or at the owner key is the only "no store"; every other shape,
   a ref that is not an address or `#<sid>`, a record that does not parse or lacks handle/name/email, and a record
   whose ref or sid does not match what was asked throw `UnknownReplyError("a store's record")`.
2. Writers and cleanups (rule 30, every swallowing site): remove `.catch(() => null)` where null deletes, drops or
   certifies, and catch `UnknownReplyError` as "try again later": closing-holds:422 and closed-store-data:592 (keep in
   the index, `continue`), data-recount:217 (keep the field), erasure-request:150 (answer "unavailable" before saying
   "sent"), share-settle:483, creator-invite-credit:205, team.ts:281 and :646, welcome-offer-send:115 (ZADD back, not
   drop), app/l/[code]:25 (503 with `Cache-Control: no-store`, never the cached "ended"), affiliates route:254 (503).
3. Request handlers: the studio routes and claim/address routes let it throw or answer 503 `unavailable`
   (`Retry-After`), never "none", "taken" or a create; public pages answer a 503 that is not cached, never `notFound()`.
4. Regression: turn each DEFECT block here into the opposite expectation (store kept, still in line, file deleted,
   throw or 503), keep the healthy controls as they are.

Not verified: the real Upstash REST reply shapes under failure (the four shapes are synthetic); the money consequence
in part 3 beyond the index removal (by reading of releaseHolds); the callers marked "by reading".
