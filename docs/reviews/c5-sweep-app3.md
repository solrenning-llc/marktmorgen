# Sweep APP3 (Claude 5): unknown provider replies in app/api/store/[p–z]*

Proof-only sweep against CX-123 rule 24 (a reply that is unknown is never empty, zero, "does not exist" or success
when it decides a write, a charge, an email, a limit, a deletion or what a person is told) and rule 30 (the same
defect fixed in one place is fixed everywhere). No product file was changed. Every proof is a synthetic test against
the in-memory Redis double (tests/redis-stub.ts), calling the real route with a real session, with stand-ins for
Vercel Blob's HEAD (a local HTTP server) and Stripe's tax settings; nothing real is called.

Base: origin/main at 5c0731550. Branch: claude5/sweep-app-3.

Scope: the 79 route files under app/api/store/ whose directory starts with p–z (package … yearly-ask), following into
lib/ only where a route's decision rests on it. Roots already in claude5/sweep-a2, a3, a5, a6, in claude4's r24-* and
sweep-proofs branches, or being fixed in an open PR were not reported again (list at the end).

Run any proof from the repository root with:

```
node /tmp/claude-0/-home-user-marktmorgen/361ec33b-f141-511f-85d1-8d3b681bab1b/scratchpad/one.mjs . sweep-app3-<name>.proof.test.ts
```

Each proof prints a healthy control first, then the defect. A check named "DEFECT" passes while the defect is
present; once the code is fixed it fails and the proof should be turned into a regression test with the opposite
expectation.

Grades: ALTO (money, another person's data or service, security), MÉDIO (a wrong write, email, limit or deletion, or
a false statement to a person), LEVE (cosmetic or self-correcting).

## Findings reproduced by a proof

### 1. ALTO — lib/preorders.ts:128-132 waitingCount, read by app/api/store/product/route.ts:276, app/api/store/waitlist/route.ts:41 and lib/preorders.ts:141 queueRelease

- Root: `(Array.isArray(raw) ? raw : [])` over the HVALS of a product's pre-orders. No reply, a number or text reads as
  "nobody waits".
- Scenario 1 (ALTO, money): the creator presses "Remove" on a product that buyers have paid to pre-order. The guard
  "Paid pre-orders wait for it … so nobody paid for something deleted" reads 0 and the product is removed, its files
  with it, while the buyers who paid still wait for it.
- Scenario 2 (MÉDIO): "coming soon" taken off an EMPTY product. The guard against releasing a product with nothing in
  it reads 0: the buy button opens on an empty product with paid pre-orders waiting.
- Scenario 3 (MÉDIO, borders ALTO): the same off-switch on a product with content. queueRelease reads 0 and puts no
  hand-over job in `nl:pre:jobs`; the product is on sale and the buyers who paid are never handed it over (the
  five-minute job only reads that line; nothing puts it back unless the creator toggles the product again).
- Proof: `sweep-app3-preorders.proof.test.ts`. Healthy control: removal 409 "preorders", empty release 400 "empty",
  a full release queues its job. Defect (3 shapes × 3 scenarios): product removed with 1 buyer waiting; empty product
  off coming soon with 1 waiting; on sale with no job queued and 1 waiting. 27 checks.
- Not covered by #2846 (its preorders.ts change is the pre-sale reads) nor by A5's runPreorderReleases item.

### 2. MÉDIO (borders ALTO) — app/api/store/podcast/route.ts:44 (with lib/podcast.ts:31-35 readPodcast)

- Root: `(await readPodcast(podcastId)) ?? { id: podcastId, episodes: [] }`. readPodcast answers null for "no record"
  and also for a GET of `nl:pod:<id>` with no reply, a non-string or text that is not JSON (parsePodcast). Under the
  lock the route writes the podcast back whole.
- Scenario "add" (the studio's normal upload of a new episode): the record is saved with only the new episode; every
  earlier episode leaves the private feed paying listeners read, the product says 1 episode, and the earlier audio
  stays in the store's folder with nothing pointing at it.
- Scenario "disable": a podcast with episodes is called empty, taken off the product and its record DELeted.
- Proof: `sweep-app3-podcast.proof.test.ts`. Healthy control: a third episode joins the two, "disable" refused
  "not_empty". Defect (3 shapes): feed reduced to ["Episode three"], product count 1; disable answers 200, record gone,
  product no longer a podcast. 26 checks.
- #2657 adds an exact read (`audioPlayedBy`) for file deletion only; this route's read is untouched.

### 3. MÉDIO — lib/call-series-open.ts:51-55 runningSeries, read by app/api/store/tax/route.ts:31-33 (and app/api/store/currency/route.ts:67-68, rule 30)

- Root: `Number(count) || 0` over the ZCOUNT of the store's running call series. No reply, text or an object reads as
  "no series running".
- Scenario: the creator switches sales tax on while a series of calls is running. The C2-94 guard exists because a
  series' later sessions are charged off-session, with no Checkout for Stripe Tax (lib/call-series-billing.ts,
  seriesBillingProblem "tax"): the tax promised on top would go uncollected or the charge refused. Unknown → tax is
  switched on with the series running. Same root lets the store's currency change while a series booked in another
  currency runs (currency route, outside the p–z range; same fix).
- Proof: `sweep-app3-series.proof.test.ts`. Healthy control: both routes 409 "series". Defect (3 shapes): read as 0
  while ZCARD is 1; currency changed to eur; tax switched on with the series running. 14 checks.
- Siblings by reading in the same file: `tidy` (:44-46) and `markSeriesEnded` (:72-75) give back
  `(Number(gone) || 0) * seriesReleaseBytes()`: an unknown ZREM gives nothing back to the data room (LEVE, the room
  stays charged for removed members).

## Findings by exact reading only (no proof built)

- MÉDIO (rule 30 sibling of A6 F8) — lib/welcome-offer-send.ts:213-217 forgetWelcomePerson returns
  `Number(gone) || 0`; lib/person-erasure.ts:164 records the step done on an unknown DEL ("0 removed"), while the
  welcome-offer start and reminder marks keyed by the address may remain.
- MÉDIO (false statement, consent) — app/api/store/weekly/route.ts:53-71 ignores the reply of setWeeklyOff /
  leaveWeeklyTeam (lib/stats-report.ts:297-300, :326-329): an SADD/SREM answered in another shape still shows
  "Stopped … you will not get the weekly email … anymore". Not covered by #2876 (it reads the mark exactly; the write's
  reply is still ignored).
- LEVE — lib/welcome-offer-send.ts:64-65 welcomeFor: `made !== null` counts any unknown SET reply as a new person
  offered (studio counter), and `Number(kept) || start` falls back to the claim's own time (same window in practice).
  :84 scheduleReminder `first === null` lets an unknown SET NX schedule a second reminder member for another token;
  the email's idempotency key (`nimbus-wo:<sid>:<hash>`) bounds the send.
- LEVE — app/api/store/stats/range/route.ts:23 `readTitles(store).catch(() => new Map())`: every product in the range
  is named "A product no longer in your store" when the titles read fails (display only; reload corrects it).
- LEVE — lib/visit.ts:47,51 isOwner: an unknown session or team read counts the owner's or a teammate's own visit as a
  visitor (stats only).
- LEVE — app/api/store/via/route.ts:31 `storeForHandle(...).catch(() => null)`: the affiliate cookie is not set on an
  unknown read (the proxy writes the same cookie on the next page; no money moves here).

## Already reported or being fixed elsewhere (not repeated)

- isSoon / soonOne / soonState (package, paypal/checkout, book, checkout, cart): PR #2846 and #2927; review proof
  zz-rev2846-cart-soon on claude4/sweep-proofs.
- lib/team.ts readTeam/saveTeam (empty team written back, two-step requirement dropped on an unknown read): Claude 4
  sweepA7 P3, fixed in open PR #2036 (`teamFromReply`). Reaches team, weekly-team and person-tasks here.
- Product removal's course read (product/route.ts:306): PR #2807 (`readCourseExact`).
- Page, page-versions, saved-blocks, site-page reads and releasePictures: PR #2830 and #2843.
- Short links (A6 F7, #2892), store-copy (A6 F9), stream captions (A6), reviews (r24-reviews), review proof
  (r24-review-proof), path (r24-path), payment-requests (r24-payment-requests), phone (r24-phone-alerts), upsell
  (r24-money-flows), product-updates (A5 #4), podcast-access (A5 #5, #2888), paypal/return (#2895), resend (#2674),
  waitlist/leave (#2576), spend (#2924), read (#2571), recovery reminders (#2929).
- Routes read with nothing new to report: pairs, pause, pay-request, paypal (connect, disconnect, onboarded), person,
  photo, pixels, preview, recent-sales, release, remind, rename, review-summary, sale (an unknown coupon reply answers
  "stripe_refused", nothing charged), save-offer, sections, setup, shipped, shipping, signup-box, socials, stamp,
  stores (Stripe subscriptions read through observeStoreSubscriptions), stream, thanks-note, tiers, tip, tips, vault,
  visit-us, voice, waitlist (confirm, join), webhooks, weekly-ai, welcome (open), welcome-offer, why-not-ask,
  yearly-ask.
