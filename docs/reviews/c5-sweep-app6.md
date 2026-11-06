# Sweep app-6 (Claude 5): client components that read a failed or unknown answer as success

Proof-only sweep against VR item 2 (nothing shown to a person that is not true for them now) and AX274 3.3.7 (no
typed data lost). Target: client components (`components/**/*.tsx`, "use client") that treat a failed or unknown
server answer as success: a reply whose `ok` is never read, a `.catch(() => {})` that leaves a success message or old
figures on screen, a 503 read as a fact. No product file was changed.

Base: origin/main at 5c0731550. Branch: claude5/sweep-app-6.

Run any proof from the repository root with:

```
node /tmp/claude-0/-home-user-marktmorgen/361ec33b-f141-511f-85d1-8d3b681bab1b/scratchpad/one.mjs . sweep-app6-<name>.proof.test.ts
```

How the proofs run a client component: the repository has no DOM library (no jsdom, no testing-library) and
`renderToString` never runs effects or click handlers, so `tests/sweep-app6-hooks.ts` calls the component function
directly with React's own hook dispatcher swapped for a small one (useState, useEffect, useRef,
useSyncExternalStore, useMemo, useCallback, useId), re-renders it after each state change and runs its effects. The
component's real code decides what is shown; `fetch`, `window`, `navigator` and the push subscription are synthetic
stand-ins. Nothing real is called. Each proof prints a healthy control first, then the defect. A check named "DEFECT"
passes while the defect is present; once the code is fixed it fails and the proof should become a regression test with
the opposite expectation.

Grades: ALTO (money, another person's data or service, security), MÉDIO (a wrong write, email, limit or deletion, or
a false statement to a person), LEVE (cosmetic or self-correcting).

## Findings reproduced by a proof

### 1. MÉDIO — components/next-offer-box.tsx:33-44, "It won't be suggested again" said without reading the answer

- Scenario: after paying, the buyer presses "No thanks" on the next-product suggestion. `hide()` awaits the POST to
  `/api/store/assistant-next` but never reads it, and a thrown error is swallowed ("Hidden here either way"); the box
  always turns into "Okay. It won't be suggested again for this order." The route answers `{ ok: false }` with 429
  when the dismissal is rate-limited (app/api/store/assistant-next/route.ts:31) and with 404 when
  `dismissNextOffer` kept nothing (route.ts:32-33; lib/next-offer.ts:333-339: no kept choice, Redis not configured or
  failing). In those cases the kept choice has no `x` mark, so `shownOf` (lib/next-offer.ts:107) shows the same offer
  again on reload: the buyer was told something false.
- Proof: `sweep-app6-next-offer.proof.test.ts`. Healthy control: 200 `{ ok: true }`, the sentence shown. Defect: 429
  `{ ok: false }`, 404 `{ ok: false }`, a non-JSON 503 and a dropped connection all show the same sentence, with no
  error and no way to try again.

### 2. MÉDIO — components/store-cart.tsx:155-175 (shown at 186-187, 306-335), stale total after a failed re-read

- Scenario: the cart panel reads GET `/api/store/cart` again whenever its items change. When that read fails, `if
  (!live || !data.ok) return;` keeps the old state and `.catch(() => {})` swallows a non-JSON page or a dropped
  connection. After the buyer removes product B ($20) from a cart of A ($10) + B with a 10% deal ($27.00), the list
  hides B (`shown` is filtered by the ids) but "Total", the button "Check out · $27.00" and "10% off for buying more"
  stay from the earlier read, with no notice. Stripe charges the server's figure, so no money moves wrongly; the
  buyer is shown a false amount and a deal that no longer applies (VR item 2). Adding a product the same way leaves it
  out of the list and out of the form's ids while the button shows the old total.
- Proof: `sweep-app6-cart.proof.test.ts`. Healthy control: the second read answers, the button says
  "Check out · $10.00" and the deal row is gone. Defect: `{ ok: false }` 503, a non-JSON 503 and a dropped connection
  all leave "Check out · $27.00" and "10% off for buying more" for product A alone, with no alert.

### 3. MÉDIO — components/community-push-toggle.tsx:118-134, notifications shown as off while still on

- Scenario: a community member presses "Turn off on this device". The POST `{ action: "off" }` is sent with
  `.catch(() => {})` and its answer is never read (line 125-130); `subscription.unsubscribe()` is awaited with
  `.catch(() => {})` and its boolean is never read (line 131). Whatever happened, the count drops by one and the
  switch goes back to "Turn notifications on" with no error (lines 133-134). When the server answered `{ ok: false }`
  or could not be reached and the browser kept the subscription (unsubscribe resolved false or rejected), the device
  keeps receiving notifications the member was just shown as turned off, until the page is opened again and the
  effect at line 58-60 reads the subscription back as "on".
- Proof: `sweep-app6-push-off.proof.test.ts`. Healthy control: off sent, switch back to "Turn on", browser subscription
  gone. Defect: (503 `{ ok: false }`, unsubscribe false) and (connection dropped, unsubscribe rejects) both leave the
  browser subscribed while the switch shows "Turn notifications on" with no error.

## Findings by reading only (LEVE)

### 4. LEVE — components/store-cart.tsx:160-175 with 213-214, first read failing leaves "Checking the prices…"

- Scenario: the first read after opening the cart fails (`{ ok: false }`, non-JSON 5xx, network). `lines` stays
  `null`, so the panel says "Checking the prices…" with `role="status"` indefinitely: no error, no checkout button and
  no retry until the cart's items change or the page reloads. Not a false fact, but an endless status. Same root as
  finding 2 (one fix: on a failed read, clear the figures and say they could not be checked, with a retry).

### 5. LEVE — components/community-push-toggle.tsx:125-131, device row kept on the server

- Scenario: the POST `{ action: "off" }` fails but the browser unsubscribes. The UI is right for this device, but the
  member's device row stays on the server, counted toward `MAX_MEMBER_DEVICES` (lib/community-push.ts:49, the "full"
  refusal at line 112) and the store's data room, until a push to that endpoint is answered 404/410
  (lib/web-push.ts:283). Self-correcting at the next push.

### 6. LEVE — components/email-sync-editor.tsx:146-157, audience list read swallowed

- Scenario: on opening the page with a connected email platform, the `targets` read fails with a non-JSON answer or a
  dropped connection; `.catch(() => {})` leaves `targets` at `null`. With no saved target the select keeps saying
  "Reading your account…" (line 286); with one, only the saved audience is offered. "Refresh list" (line 294) recovers
  it, and an `{ ok: false, message }` answer is shown. No false fact, no lost input.

### 7. LEVE — components/import-tool.tsx:518, 532, 551, cancel after a failed send swallowed

- Scenario: a batch or the finish step is refused, the error is shown (correct), then `post({ action: "cancel" })` is
  sent with `.catch(() => null)` and the job is cleared locally whatever the answer. If the cancel fails, the import
  stays "receiving" on the server until it expires; the creator was not told the import succeeded, so no false
  statement.

## What was checked and found sound

- All 174 client components under `components/` that call `fetch(` (minus the exclusions below) were scanned for a
  success branch reached without `ok`: each `fetch` was read with the condition that follows it. The large majority
  require `response.ok && data.ok === true` (often with an echo of the saved values), or go through a local helper
  that turns a non-JSON body or a thrown error into `{ ok: false, error: "server_error" }` (passkey-manager,
  licence-key-editor, team-manager, community-studio, community-events-studio, domain-editor, waitlist-panel,
  discord-studio, inbox-studio, paypal-payouts, store-assistant) and whose callers check `ok` before any success.
- Fire-and-forget beacons are by design and say nothing to anyone: store-beacon.tsx:16, page-depth.tsx:15,
  affiliate-click.tsx:41/86, store-pixels.tsx:314, mail-click.tsx:25.
- Reads that fail say so instead of reading as empty: workflow-tools.tsx:345 ("This does not mean there are no
  runs"), team-event-editor.tsx:111, inbox-studio.tsx:111, mark-shipped.tsx:46 (keeps "not recorded"),
  older-purchases.tsx:57, orders-bundle.tsx:60, stats-panel.tsx:536.

## Not covered

- components/page-editor.tsx: left to PR #2904 (Claude 6).
- components/course-editor.tsx and components/bundle-editor.tsx: left to Codex J, who is proving them (LessonEditor
  loadText/Save; bundle-editor GET and empty render). No finding is reported here for those two files.
- Components that reach the server only through a helper in `lib/` or a server action were not traced beyond the
  `fetch(` scan; no browser, assistive technology or real network was used.

## Acessibilidade

No interface changed. Findings 2 and 4 bear on WCAG 4.1.3 (status messages: a stale total and an endless
`role="status"` with no alert) and 3.3.1 (an error that is never identified); finding 3 on 3.3.1 as well. Not
verified with a screen reader. 0 → 0 steps and decisions in any task (nothing changed).
