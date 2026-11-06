# Sweep APP4 (Claude 5): unknown provider replies in app/api/ outside app/api/store/

Proof-only sweep against CX-123 rule 24 (a reply that is unknown is never empty, zero, "does not exist" or success
when it decides a write, a charge, an email, a limit, a deletion, access or what a person is told) and rule 30 (the
same defect fixed in one place is fixed everywhere). Scope: the 91 route files under app/api/ except app/api/store/
(cron, mail, auth, billing, stripe, discord, integrations, v1, privacy, takedown, mcp and the rest), following into
lib/ only where a route's decision rests on it. No product file was changed. Every proof is a synthetic test against
the in-memory Redis double (tests/redis-stub.ts) with stand-ins for Stripe, Discord and the email provider (the SES
fixture, tests/ses-mail-fixture.ts); nothing real is called.

Base: origin/main at 5c0731550. Branch: claude5/sweep-app-4.

Run any proof from the repository root with:

```
node /tmp/claude-0/-home-user-marktmorgen/361ec33b-f141-511f-85d1-8d3b681bab1b/scratchpad/one.mjs . sweep-app4-<name>.proof.test.ts
```

Each proof prints a healthy control first, then the defect. A check named "DEFECT" passes while the defect is
present; once the code is fixed it fails and the proof should be turned into a regression test with the opposite
expectation.

Grades: ALTO (money, another person's data or service, security), MÉDIO (a wrong write, email, limit or deletion, or
a false statement to a person), LEVE (cosmetic or self-correcting).

## Findings reproduced by a proof

### 1. MÉDIO (rule 30, borders ALTO) — thirteen cron jobs take an unknown lock reply as theirs and delete another run's lock

- Where: `const [got] = await redisPipeline([["SET", LOCK, "1", "NX", "EX", n]]); if (got === null) return busy;`
  then `finally { DEL LOCK }`, in app/api/cron/plans (:70-71, :173), mail (:105-106, :237), closing (:40-41, :82),
  affiliates (:38-39, :51), imports (:40-41, :62), closed-data (:26-27, :36), recount (:26-27, :36), monthly
  (:36-37, :97), weekly (:48-49, :125), stripe-check (:31-32, :66), shares (:21-22, :28), stream (:32-33, :49) and
  mail-check (:34-35, :98).
- Scenario: another run holds the lock. The SET NX answer is lost or in another shape (no reply, "QUEUED"): only nil
  is "busy", so the job runs BESIDE the other run, and its `finally` deletes the OTHER run's lock (no value check),
  so a third run can start too. These are the jobs that charge payment plans and settle subscriptions (plans), pay
  affiliates and settle PayPal payouts (affiliates), refund and undo plans and close stores (closing), erase closed
  stores' records (closed-data), and send every email queue and webhook (mail). Whether each inner step is safe to
  run twice is then left to that step's own claim; several of those claims are themselves `!== null` reads
  (sweep A6 F4, A2 #6).
- Sibling already fixed: lot L10a (a1d9267a8) moved courses, reminders, discord and quiet to lib/claim-mark.ts
  (`claimMark` → "ours" / "taken" / "unknown" → 503 `lock_unknown`; `releaseMark` lets go only our own value) with
  tests/l10a-claims-exact.test.ts. These thirteen are the unfixed siblings. Same root also in the healthy path: a
  run that outlives its lock's expiry deletes the lock the next run took (not proven here; L10a's
  `withLockTakenOver` check is the model).
- Proof: `sweep-app4-cron-locks.proof.test.ts`, on plans, mail, closing, affiliates, imports, closed-data, recount,
  monthly and weekly (stripe-check, shares, stream and mail-check return before the lock without configuration this
  proof does not fake; same lines). Healthy control per job: nil answer → busy, nothing else read or written, the
  other run's lock kept. Defect per job, for "no reply" and "QUEUED": not busy, the job's body ran (Redis read and
  written after the lock), and the other run's lock is gone. 45/45 checks.
- Fix direction: `claimMark`/`releaseMark` exactly as L10a, 503 `lock_unknown` on "unknown".

### 2. MÉDIO — app/api/discord/callback/route.ts:65-76, a server switch on an unknown read keeps the old server attached

- Scenario: a creator adds the bot to a NEW Discord server. `readServer(room)` (lib/discord-store.ts:44-48,
  `parseServer(parse(raw))`) reads a GET answering in another shape as `null`, "no server connected". So
  `forgetServer` and `leaveServer` are skipped: the new server id is written over the old one while the old
  server's product roles, member records (with the buyers' email addresses) and due checks stay on the store and
  are now read against the NEW server's id. The bot stays in the old server, where the store no longer looks, so
  paid roles given there are never checked or taken back again; the creator is told "connected".
- Proof: `sweep-app4-discord-switch.proof.test.ts`. Healthy control: the old server is left
  (`DELETE /users/@me/guilds/<old>`) and its roles and members forgotten. Defect: no DELETE sent, the product roles
  `[["prod1", [role]]]` and the member kept, server now the new one. 6/6 checks.
- Fix direction: an exact GET (lib/redis-reply.ts `repliesFor`; only nil is "none"); on unknown, refuse the switch
  (`discord=error`) before exchanging the code. `forgetServer`'s own `Array.isArray(ids) ? ... : []` (lines 60-63:
  an unknown HKEYS/HVALS leaves the address keys and due entries behind) belongs to the same fix.

### 3. MÉDIO (rule 30) — app/api/cron/weekly/route.ts:72-84, unreadable numbers burn the week's claim

- Scenario: `claimWeek` is taken before the numbers are read. When they cannot be read (lib/stats.ts readStats
  answers null when the traffic read is not known, `statsTrafficCoverage`; a throw is `.catch(() => null)`), no
  message is built, the store is counted "quiet" (nothing to report, not "failed"), and the claim is kept for its
  9 days: every later run that week skips the store and the creator's weekly email is lost. The sibling
  app/api/cron/monthly/route.ts:62-67 handles exactly this with `releaseMonth` and counts it "failed".
- Proof: `sweep-app4-weekly-claim.proof.test.ts`. Healthy control: looked 1, sent 1, one email captured. Defect:
  first run with the traffic pipeline answering in another shape → looked 1, quiet 1, failed 0, nothing sent; a
  second run the same week with Redis healthy → looked 0, sent 0. 3/3 checks.
- Fix direction: release the week's claim when `data` is null (a `releaseWeek` beside `releaseMonth`) and count it
  "failed". Not reported again here: claimWeek's own `ok !== null` (A6 F4) and weeklyOff's `Number(member) === 1`
  (A6 F3).

## By exact reading only (LEVE, not reproduced)

- app/api/cron/stripe-check/route.ts:43-47: `failedBefore` is `typeof previous === "string" && ...`; an unknown GET
  reads as "passing before", so the site's inbox is not told "all passing again" after a failure. Internal notice.
- app/api/cron/monthly/route.ts:72 and weekly/route.ts:80: `readSalesGoal(...).catch(() => ({ cents: 0 }))`; an
  unknown goal is "no goal" and the email leaves the goal line out. Omission, not a false figure.
- app/api/cron/weekly/route.ts:79: `readSpends(...).catch(() => [])` (and lib/ad-spend.ts:53 `metaLines` the same):
  the ad-spend insights are left out of the email on an unknown read. Omission.
- app/api/billing/checkout/route.ts:102: `accountStores(store.email).catch(() => [])`; an unknown read of the
  account's other stores starts the checkout without the customer already at Stripe, so one person becomes a second
  Stripe customer. No double charge (the plan reservation and checkout are per store); bookkeeping only.
- app/api/cron/quiet/route.ts:42-43: the day's cursor `Math.max(0, Number(atRaw) || 0)` restarts at the first store
  on an unknown GET; every per-store claim after it is exact (L10a), so only time is spent.
- app/api/mail/ses/route.ts:57-58 and mail/inbound/route.ts:77-82: the announcement's once-mark is "fresh" on any
  answer but nil (inbound also on a thrown Redis). A repeat is acted on again; lib/mail-health.ts:372-373 keeps its
  own per-address mark (`seenKey`), so a bounce or complaint is not counted twice; the delivery report's
  `noteMailReportEvent` takes an event id. Self-limiting.

## Looked at and found exact or fail-closed

auth (move: unknown store location keeps the move marked broken; holdsSecondStep unknown → refuse; two-step and
recovery-address reads are claude4/r24-two-step and r24-recovery-address), billing (cancel/switch/return/refund/
pause/assistant: lib/billing.ts reads only an identified subscription; unknown keeps access or refuses; refund
`refundUnderway(...).catch(() => true)`), stripe/* (errors answer `stripe=error`), cron reminders, discord, quiet,
courses (L10a claimMark), cron/usage (reads in try/catch; no email on an unknown over-allowance list),
integrations/zoom/deauthorize (claimMark), meta/deauthorize (claude4/r24-provider-deletion), mail/unsubscribe
(unknown token reads answer "Not found.", never "Unsubscribed."), mail/clicked, privacy/erase, stream/hook,
v1/codes (Stripe list state checked), v1/access, v1/hooks, creators (exact `countOf`), takedown, report, mcp.

## Not in this sweep

Roots already reported elsewhere were not repeated: claude5/sweep-a2, a3, a5, a6, codex/s-sweep-a1-proof and the
claude4/r24-* branches (two-step, recovery-address, passkeys, provider-deletion, money-flows, sends-once, reviews,
plan-disputes, plan-refund-underway, payment-requests, phone-alerts, path, outreach-clicks, review-proof).
