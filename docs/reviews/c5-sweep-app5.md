# Sweep app5 (Claude 5): unknown provider reads shown as facts on server-rendered pages

Proof-only sweep against CX-123 rule 24 (a reply that is unknown is never empty, zero, "does not exist" or success
when it decides what a person is told, a grant or an offer) and rule 30 (the same defect fixed in one place is fixed
everywhere). Scope: `page.tsx` and `layout.tsx` under `app/[handle]/**` and `app/studio/**`. No product file was
changed. Every proof is synthetic: the in-memory Redis double (tests/redis-stub.ts) and, where Stripe is read, a
stand-in that fails; nothing real is called.

Base: origin/main at 5c0731550. Branch: claude5/sweep-app-5.

Left out on purpose (other agents hold them): app/studio/calendar/page.tsx, app/[handle]/p/[product]/page.tsx,
app/[handle]/page.tsx, app/[handle]/shop/[collection]/page.tsx, app/embed/**, app/[handle]/renew/** and the stock and
win-back topics (Claude 6). Not reported again: `isSoon` and `heardOff` (claude6/a8-handle-sweep), `askPlace` and
`takePlace` counts (claude5/sweep-a3), `requestOf` (codex/t-single-record-unknown-proof), passkeys
(claude4/r24-passkeys, claude5/sweep-a5), `assistantLeft` (claude5/sweep-a6).

Run every proof from the repository root with:

```
node /tmp/claude-0/-home-user-marktmorgen/361ec33b-f141-511f-85d1-8d3b681bab1b/scratchpad/one.mjs . \
  sweep-app5-group-places.proof.test.ts sweep-app5-event-places.proof.test.ts sweep-app5-totals-members.proof.test.ts
```

Result on 5c0731550: 3 files, 20 checks, all passing (every control healthy, every defect reproduced). Each proof
prints a healthy control first; a check named "DEFECT" passes while the defect is present. Once fixed it fails and the
proof should become a regression test with the opposite expectation.

Grades: ALTO (money, another person's data or service, security), MÉDIO (a wrong write, email, limit, grant or
deletion, or a false statement a person acts on), LEVE (a wrong display that decides nothing, or fails closed and is
right on the next load).

## Findings reproduced by a proof

### 1. MÉDIO — app/[handle]/group/[group]/page.tsx:132 with lib/group-buy.ts:155-160, a full group purchase shown as all places open

- Scenario: someone bought a product for two people; both places are taken. The link is opened again (by a third
  person it was shared with). The places count is read with `placesTaken(group.id).catch(() => 0)`, and `placesTaken`
  reads its GET with `Number(raw)`, an unknown shape being 0. Either way the page says "2 of 2 places are still open"
  and shows the "Send me the link to my place" form: the person types an address and asks for a place that does not
  exist (with the same unknown reply, `askPlace` also sends the email: sweep A3, part 2).
- Proof: `tests/sweep-app5-group-places.proof.test.ts`, rendering the real page with `renderToStaticMarkup`. Control:
  "All 2 places have been taken.", no form. Defect 1 (GET answers `{ unexpected: true }`): `placesTaken` = 0, "2 of 2
  places are still open", form shown. Defect 2 (the read throws): the same, through the page's `.catch(() => 0)`.

### 2. MÉDIO — app/[handle]/community/events/[event]/page.tsx:75-96 (and the list, events/page.tsx:71) with lib/community-events.ts:684-692, a member with a place is shut out of a live event

- Scenario: a capped community event (2 places), both taken, doors open. `rsvpNumbers` reads HLEN with
  `Number(x) || 0` and HEXISTS with `Number(x) === 1`. Answers in an unknown shape are "nobody is coming" and "you are
  not coming": the event reads "0 going · 2 of 2 places left" with "Take a place" instead of full, and the member who
  holds a place is not told so; `wayInFor` (line 87) then withholds the way in (the room link) from that member while
  the event is live. A paying member with a place loses access to the event for as long as the read is unknown.
- Proof: `tests/sweep-app5-event-places.proof.test.ts`. The page's lines 83-96 are reproduced with the real
  `rsvpNumbers`, `wayInFor`, `joinWindow` and `placesWords` (rendering the page needs a signed-in community session;
  the fix's regression test should render it). Control: going, full, way in = the room. Defect: not full, "0 going",
  `youAreGoing` false, way in `null`.

### 3. MÉDIO — app/studio/totals/page.tsx:44-45 with lib/account-totals.ts:92-97, members and recurring revenue undercounted or $0 with no note

- Scenario: a person with several stores opens "All your stores". Each store's members are read with
  `keptMembers(store).catch(() => null)` inside a read whose state stays "ok"; `sumStores` adds a store's members only
  when present and names in "Not added in" only stores whose state is not "ok". When Stripe cannot be reached,
  `keptMembers` throws: the store's paying members, trials and monthly recurring revenue are silently left out. With
  every store failing the page says 0 paying members and $0.00 a month (`moneyLines`, line 25) with no notice; with one
  failing, a smaller figure presented as the whole.
- Proof: `tests/sweep-app5-totals-members.proof.test.ts`. The real `keptMembers` with a Stripe stand-in answering 500
  throws (so the page's catch gives `members: null`); then `sumStores`. Control: 43 paying, $387.00, nothing left out.
  Defect: one store failed, 3 paying and $27.00 shown as the whole, `left` empty; both failed, 0 / 0 / no money lines,
  `left` empty.

## LEVE, not proved (each decides nothing or fails closed and is right on the next load)

- Rule 30 siblings of `assistantLeft` (sweep A6): studio counts read as 0 when unknown, each with
  `Number(x) || 0` in the lib and `.catch(() => 0)` on the page: `answersUsed` (lib/answers.ts:74-75,
  app/studio/page.tsx:1971, "0 of N AI attempts used"), `welcomesOffered` (lib/welcome-offer-send.ts:169-170, page
  :2019), `nudgesThisMonth` (lib/member-nudge.ts:115-116, page :2039, "Sent this month: 0"), `yearlyAsksThisMonth`
  (lib/yearly-ask.ts:173-174, page :2044). The sends themselves use their own counters.
- app/studio/page.tsx:2045: `readKind(store, "recurring").catch(() => [])` makes `offersYearly` false, so the yearly ask
  editor reads as if no membership had a yearly price.
- app/studio/course/[product]/page.tsx:83 with lib/auto-captions.ts:359-360: `autoRefundsOwed(...).catch(() => [])` and
  `Array.isArray(members) ? members : []` hide the "refund not confirmed by Stripe, write to support" notice for a
  stuck AI-captions refund (silence, not a false sentence; back on the next good read).
- app/[handle]/manage/page.tsx:57 and manage/leave/page.tsx:52 with lib/tier-switch.ts:59: `liveTiers` and its
  `readListings(...).catch(() => [])` hide the plan-switch and cheaper-plan choices from a member.
- app/[handle]/move/[product]/page.tsx:51: `readMove(...).catch(() => null)` tells a member moving their membership that
  the invitation expired (fails closed; the button is not shown).
- app/[handle]/orders/page.tsx:177: `discordFor(store).catch(() => null)` leaves the Discord way in off a paying
  buyer's orders page.
- app/[handle]/community/search/page.tsx:135-140: `searchRoom`/`searchMessages` `.catch(() => [])` counted as 0 hits
  (the lib side of `searchRoom` is in A8).

## Read and found sound for this rule

Read with care: app/[handle]/thanks/page.tsx (group link: an unknown `readGroup` says "We could not get your link
just now"), app/[handle]/media-kit/page.tsx (`readVerified` refuses an unknown shape and the counted block is left
out), app/studio/requests/page.tsx (says the list could not be verified), app/studio/email/page.tsx (strict reads,
`held` stays `null`), app/studio/affiliates/page.tsx (PayPal checks counted, never guessed), app/[handle]/sign
(through `requestOf`, reported elsewhere). Every other `.catch(() => null | [] | 0)` and `?? 0` in scope was listed by
grep and skimmed; the rest either draw a "could not be read" state or concern a default after a known read.
