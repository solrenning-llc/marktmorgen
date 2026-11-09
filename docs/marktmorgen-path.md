# Marktmorgen Path

**From first light to first sale.** *Every step is real. Every sale is yours.*

A path of short daily missions that takes a creator from a published store to
the first real sale, with levels after it. Approved by the owner on 18 October
2026 with five corrections (below). This file is the inventory the path was
built from, its rules, what it costs, and what it will not do.

Status: **built behind the studio, nothing on sale.** `PLANS_ON_SALE`
(`lib/opening.ts`) is false, so no store can take a real order today: the
first six days can be done for real, the seventh (a real paid order) cannot
until sales open. Both the test purchase and the real order are built and
tested end to end against Stripe's test mode with synthetic records
(`tests/path-facts.test.ts`).

## 1. What every store already records (the inventory)

Nothing in the path counts anything new. Each mission closes on a record the
store already keeps; the table says which, and what the path does with it.

| Record | Where | What the path reads it for |
| --- | --- | --- |
| The store's name and line (`name`, `bio`) | `lib/store.ts`, the store's own record | Day 1, "title published": both non-empty on the public page |
| The catalog: listed items, each listing's `file`, `link`, `course`, options' files | `lib/store.ts` (`catalog.items`, `catalog.head`, `catalog.inline`), `lib/catalog.ts` (`KIND.hidden`) | Day 2, a listed product with something to hand over; First Light |
| Paid checkouts on the creator's own Stripe account, with `livemode` | `lib/stats.ts` `readPaidSales` (the same ledger the five-minute job `watchStripe` in `lib/webhooks.ts` walks for `checkout.session.completed`) | Day 3 (a paid checkout with `livemode: false`), Day 7 and the levels (`livemode: true`) |
| Refunds on the creator's Stripe account | `lib/stats.ts` `readRefunds` (exported as `readStoreRefunds`), the source of `charge.refunded` in `lib/webhooks.ts` and of the rule in `lib/refunds.ts` | A refund in full takes a real sale off; every refund is taken off the money |
| Visits by where they came from, all time (`r:<source>`) and visitors (`u`) | `lib/stats.ts`, the all-time record `nl:stats:<id>:life` (now readable whole with `readLifeRecord`); sources named by `lib/source-rules.ts`; the channel a buyer is credited to by `lib/visit-channel.ts` | Day 4 (a visit from a social network), traffic missions |
| Addresses left on the store, by channel (`fs:<channel>`) | `lib/stats.ts`, counted by `app/api/store/free/route.ts` (a free product asked for) and `app/api/store/join/route.ts` (the sign-up box) and `app/api/store/waitlist/join/route.ts` (`kind: "signup"`) when the store sends its confirmation email | Day 6, "first lead"; traffic missions. An import (`lib/imports.ts`) never counts: imported contacts are not `fs:` |
| Short links made for posts | `lib/short-links.ts` (now `countLinks`, one `HLEN`) | Day 5 (three links), traffic missions |
| The list itself, its export | `lib/free.ts`, `lib/contacts.ts`, `app/api/store/leads/route.ts` | Not read by the path (see §6, open decision 2) |
| The 14-day trial | `lib/plan.ts` `TRIAL_DAYS` | The path runs the same in the trial and on every plan |
| Phone notifications (Web Push) | `lib/web-push.ts`, `lib/phone-alerts.ts` (`PHONE_EVENTS`) | The path's reminder (second PR) |
| Trial nudges (two emails, days 3 and 9) | `lib/trial-nudges.ts` | Kept as they are; the path sends no email of its own |
| "Getting your store ready" steps | `components/studio-start.tsx`, built in `app/studio/page.tsx` | Kept; the path starts where they end. Their "Buy it once yourself" step asks for a live purchase; the path never does (Day 3 is test mode only) |
| The store coach | `lib/store-coach.ts` | Kept; read beside the path, never mixed into it |
| The month's sales goal | `lib/sales-goal-rules.ts`, `lib/sales-goal.ts` | The goal's reader (`readGoal`) bounds the onboarding's goal; the path's goal is the person's own and separate from the month's goal |

### What was missing, and what this adds

- **A record of the person's path**: `nl:path:<sid>` (`lib/path.ts`), one JSON
  value: the four answers and time zone, when the path began, the days opened
  (the latest 60), the best level reached and when, and the last reading of
  the money and the counts. Counted in the store's data room (slot `path`,
  `tests/store-data-registry.ts`). **No mission is ever stored as done.**
- **Three narrow readers** for records that were kept but not readable from
  outside their file: `readLifeRecord` and `readStoreRefunds` (`lib/stats.ts`)
  and `countLinks` (`lib/short-links.ts`). No write path changed.
- **The rules** (`lib/path-rules.ts`, pure), **the facts** (`lib/path-facts.ts`),
  **the route** (`app/api/store/path/route.ts`: `start`, `forget`).

## 2. Rules (the owner's, with the five corrections)

1. **Progress only from verified events.** `PathFacts` is the only input to
   a mission's state, and nothing a person presses can close one. Orders and
   refunds are read only from the creator's own Stripe account, server side
   (status `complete`, `payment_status: paid`, this store's metadata, never a
   tip or a payment request, never a thanks page). A refund in full takes the
   sale back off Day 7. **Levels never go down**: the best level ever reached
   is the one thing remembered (`levelKept`).
   *How "after the webhook" is read:* the five-minute job reads Stripe's
   events from the same account; the path reads the same paid checkouts and
   refunds directly from that ledger when the owner opens it (reused for ten
   minutes). Nothing reaches the path that Stripe did not confirm, and a
   refund made in Stripe's dashboard counts on the next reading.
2. **Onboarding: four questions.** The person's own monthly income goal (kept
   only as their goal, shown as "Your goal: $X a month. It is yours, and
   nothing here predicts it."; never a forecast, never compared), what they
   know and want to make something about, 15, 30 or 60 minutes a day, and
   where their audience is (Instagram, TikTok, YouTube, an email list, nowhere
   yet). The time zone comes from their browser, so days and quiet hours are
   theirs.
3. **Seven days closed by events**, in order: title published; a product with
   a file; a test purchase **in Stripe's test mode only**; the first visit
   from a social network; three post links; the first lead; the first real
   paid order. On a store whose checkout runs live, Day 3 is shown as not
   available, never asked for with a real card, and never holds the path
   back. **Then traffic missions** (social visits, post links, leads,
   visitors) until the first sale. **No failure screen**: a day not done is the
   day to do next; there is no "missed" or "behind".
4. **Levels by cumulative real money kept** (paid live orders less refunds,
   in the store's currency): First Light (title and a product), Sunrise (the
   first real sale), Morning $100, High Sun $1,000, Golden Hour $10,000, Zenith
   $100,000; other currencies on the scale `lib/money.ts` already sets prices
   on, never a conversion. Never "Hero" or "Games" (`FORBIDDEN_MARKS`).
5. **Streak**: the days the owner opened the path, in their own days. Sunday
   never breaks it; two other rest days a week are free; today is never a
   missed day. Nothing is bought to keep it.
6. **Quiet hours**: no notification from 21:00 to 08:00 in the person's own
   time (`mayNotify`).
7. **Words at no cost.** Every mission's text is a template filled with the
   person's answers. AI is only ever an option the person presses, from the
   plan's existing AI allowance with its reservation, **never in the trial**,
   and **AI never decides completion**.
8. **Ranking** (third PR): opt-in, by missions done only, never money, with no
   real name by default.
9. **Share card** (third PR): the level and the days on the path; dollars
   only if the person turns them on.
10. **Every plan and the trial** have the whole path.
11. **No "Studio pays for itself from $3,629" or "Scale from $7,273"** (an old
    commission list; a sale carries 0% today). A plan change is shown only
    near a limit, with the person's real usage, computed by code (second PR).
12. **Forbidden phrases**, tested on every text the path can draw
    (`tests/path-words.test.ts`): "make money online", "financial freedom",
    "replace your job", "passive income", any amount earned, "get rich",
    six- or seven-figure, "pays for itself", and the two figures above.
13. **Notifications**: in the studio and by push only; email only within the
    plan's own email figure.
14. **Accessible**, and one visual: the logo's sun rising in a progress ring.

## 3. Days 3 and 7 while sales are closed

`PLANS_ON_SALE` is false, so `canSell` refuses every real checkout. In a
deployment whose Stripe Connect runs in test mode (`isConnectInTestMode`,
`sellsInTestMode`), every store's checkout is a test one: Day 3 closes on a
real test purchase made with Stripe's test card, and Day 7 says plainly that a
real order can only come once the checkout runs live. `tests/path-facts.test.ts`
plays Stripe with synthetic sessions and refunds (test mode, live mode, a tip,
a payment request, unpaid, another store's, a full and a part refund, refunds
not listed in full) and walks the record end to end.

## 4. What it costs, and how the 60% floor is kept

- **The record**: one value of at most a few kilobytes, in the store's data
  room (`takeData`, slot `path`, set, so a rewrite never grows the room by
  more than it weighs), written only when something changed.
- **A reading of the money and the counts** (`visitPath`): the numbers'
  all-time record (up to `LIFE_WRITE_MAX` fields), one `HLEN`, and up to
  `PATH_SALE_PAGES` + `PATH_REFUND_PAGES` pages of the creator's Stripe
  account. It takes `PATH_READ_UNITS` (8) of the store's studio requests first
  (`countStudio`), at most once every `PATH_MONEY_SECONDS` (ten minutes);
  `tests/plan-cost-registry.test.ts` holds 8 studio requests above its cost at
  every ceiling (`PATH_READ`). When the studio's figure has no room, the path
  shows the last reading with when it was read and never pauses the studio
  for it. So the path adds no cost line: every request it makes is a studio
  request of the plan's own figure, which `tests/spend-floor.test.ts` already
  holds to 60%.
- **No email, no model call, no new counter** in this first part.

## 5. Privacy and erasure

The record is the store owner's own (`lib/person-data.ts`, "account"): their
answers, days and level, nothing about a buyer. It is deleted from the path
(`forget`), with the store (`app/api/store/stores/route.ts`) and with the
store's closing (`lib/closed-store-data.ts`, `prepareStore`). The privacy
policy says so (`/privacy#path`).

## 6. Open decisions for the owner

1. **What a lead is.** Today: an address left on the store, counted when the
   store sends its confirmation email (`fs:`), so an import never counts. The
   stricter reading, an address that used its confirmation link, would need
   either a walk of the list or a new counter on the confirmation; not built.
2. **PayPal sales** count toward Day 7 and the levels only when the store's own
   server captured them through PayPal's live API, less the refunds PayPal
   confirmed in full (12 [D9] unit 1). Whether an order was taken on the live API
   is written on its own paid record when it is captured, never read from the
   deployment that reads it later; a sandbox order, or one paid before that field
   existed, is neither a real sale nor a test purchase. A PayPal sale counts only
   while its refunds can be seen: the platform is a PayPal partner and the store
   is still connected to the PayPal account that took it; otherwise it is left
   out. A sale PayPal reports as refunded in part or reversed is taken off whole,
   since the amount kept is not read. Refunds that cannot all be read, or a reply
   off its shape, leave the money unknown. A PayPal refund of a sale the Path did
   not count is never taken off another sale. A reading takes PATH_READ_UNITS
   studio requests, which cover the PayPal records it can move (the money reviews
   on #3443).

## 7. What it will not do

- It will not mark a mission done because somebody pressed something.
- It will not predict, promise or compare earnings, or show anybody's money
  to anybody else.
- It will not ask for a real purchase of one's own; the test purchase is in
  Stripe's test mode only.
- It will not take a level back, and it will not show a failure.
- It will not notify between 21:00 and 08:00 in the person's own time, or send
  email outside the plan's own figure.
- It will not use AI in the trial, or let AI decide that a mission is done.
- It will not put a person on a ranking they did not join, or under their
  real name by default.

## 8. How it is split for review

1. Inventory, rules and events (this): `docs/marktmorgen-path.md`,
   `lib/path-rules.ts`, `lib/path-facts.ts`, `lib/path.ts`,
   `app/api/store/path/route.ts`, the three readers, the registries, the
   privacy policy, erasure, and the tests.
2. The studio page, onboarding, the reminder, the plan line near a limit, the
   feature page.
3. The ranking and the share card.

## 9. Mission guidance in the studio (19 October 2026)

The mission list shows each existing count as a visible fraction and a named
native progress meter. Each open mission has a native keyboard-operable
disclosure with its existing steps and a link to that store's studio destination.
Opening instructions changes no mission state, sends no request and uses no AI.
Recorded and unavailable missions have no action; in particular an unavailable
test purchase never exposes test-payment instructions on a live checkout.

The largest mission list stays below 30 KB of the existing Path page's 70 KB
response bound; no supplier request, storage family or quota is added.
The browser checks the keyboard disclosure, scoped link, unchanged mission state,
and expanded instructions at 390 and 1280 pixels with axe and no overflow.

## 10. Campaign discovery from a mission (19 October 2026)

An open product or sale mission links to the existing sales campaign category.
An open lead mission or lead traffic target links to the audience category, with
a clear distinction: a campaign form response alone is not a Path lead. The Path
confirmation sources in section 1 remain unchanged. Test purchases, unavailable,
recorded and unrelated missions have no campaign suggestion.

The link keeps the chosen store, validates the category against the gallery's
allowlist and scrolls to the gallery. It neither imports a campaign nor spends a
preview or AI request. Changing filters stays local; choosing a starter still
uses the existing metered preview, product mapping and capacity checks.
There are no new provider calls, stored records, quotas or prices.

## 11. Daily invitation inside the studio (19 October 2026)

The studio can invite the owner to reopen an existing Path on a day they have
not opened it, between 08:00 and 21:00 in their saved time zone. It is suppressed
for team members, unavailable records, invalid time zones, future records,
suspended stores and a kept reading with a real sale. Opening the studio does
not record a Path check-in; the invitation's link disables prefetch.

The invitation is deliberately generic: it asks the owner to read current facts
inside Path, without treating stale cached counts as a current mission.
There is no email, push, cron, model call, new key or stored completion.
One additional existing-record GET, bounded at 4 KB, fits the same reserved
studio page (81 commands / 404,096 bytes, tested against four studio units).
Pure checks cover local day, roles, quiet hours and no mutation; browser checks
the second-store link, mobile/desktop accessibility and removal after opening.
This is an in-studio invitation, not an automatic scheduled push.

## 12. Checkout context before promotion (19 October 2026)

The owner's Path shows read-only checkout context from the existing opening,
suspension, Stripe readiness and test-mode checks. Preview, paused, incomplete
setup and test mode never appear as live checkout. Nothing here enables sales,
changes the plan or bypasses a payment, tax or capacity check.

The second mission is named "Prepare your first digital product" because its
completion fact is a listed deliverable, not a paid order. The sale mission is
explicitly a real Stripe sale. Its promotion step waits for live checkout;
writing to a list is conditional on marketing consent. The studio also says
that Path counts Stripe sales and live PayPal sales, less refunds, toward the
first sale and the levels (the growth missions stay on live Stripe checkouts),
matching section 6.

No additional provider read, data record, quota or price is introduced.
The notice is checked with the Path page's existing mobile/desktop accessibility
flow; synthetic checks exercise every combination of the four readiness flags.

## Optional mission board (19 October 2026)

The owner must explicitly check consent and choose Join. The board shares only
a generated pseudonym, verified mission count and reading timestamp with joined
Path owners. No real name, store URL, answers, goal, sales amount or level is shown.
The score counts the seven day missions plus all eight traffic missions, independent
of whether traffic suggestions are hidden after a sale. Money is never a sort key.
The top 20 cached readings are shown; ties share a rank. The board is a snapshot,
updated when its owner opens Path with fresh facts; it is not a live comparison.

Joining reserves four studio requests and a conservative 2 KB shared-data allocation
in that store's room, in addition to its measured private record. The shared sorted
set and private owner reverse index are excluded from legacy room recount: each
owner's allocation is already booked atomically. One Lua operation applies consent,
revision, room and shared entry. CAS prevents an older visit restoring withdrawn
consent. The reverse index permits cleanup even when private JSON is unreadable.
Leaving preserves private answers, check-ins and reached level. Forgetting Path,
deleting the store and closing it remove the shared entry too.

The public privacy policy links to /studio/path/privacy, using the existing
essential privacy allowance rather than monthly studio requests. It records no
check-in or fresh facts. The owner can withdraw and download private Path JSON
there even after the monthly allowance is exhausted. GET /api/store/path is owner
only, scoped to the chosen store, no-store, and excludes the internal revision.
The general store export may be available to collaborators; private Path is not
added to it.

Synthetic checks cover consent/default privacy, scores/refunds, pseudonyms,
withdrawal/rejoin/deletion, room accounting and parser bounds. Disposable actual
Redis checks exercise concurrent joins, stale writes, partial-failure prevention,
corrupt-record cleanup and physical shared allocation at 1/16/128 entries.
The real-browser fixture covers explicit consent, persistence, mobile/desktop axe,
quota exhaustion, owner-only Path download and withdrawal without lost answers.
No real payment, third-party message or provider read is triggered by board join.

## Ordered Path continuation (19 October 2026)

Prerequisite PR #611 is published: the optional personal goal has an associated
inline error and focus correction; existing parser and bounds are unchanged.

1. **High Sun — complete.** The display name was already active in LEVEL_NAMES.
   Stale documentation and test labels are now aligned, and path-words checks the
   documented level list and rejects the retired display name. Stable internal
   keys, reached levels and money thresholds are unchanged; no data migration.
2. **Post-sale growth missions — complete (PR #613).** Six bounded server-fact
   missions, unknown states and their quota reservations are described below.
3. **Return mission after seven local days — complete (PR #616).** Published
   as delivery 38 after the domain, version and full checks were confirmed.
4. **Fixed Instagram, TikTok and YouTube post scripts.** Implementation and
   validation contract are recorded below; production evidence is kept separately.
5. **Optional paid, reserved and fact-checked AI mission wording — pending.**
6. **Private, accessible level certificates with money opt-in — implementation and verification below.**
7. **Imported products/pages recognised without imported leads/sales — pending.**
8. **Creator-local weekly factual studio summary — pending.**
9. **Server-confirmed live PayPal sales with refunds — counted (12 [D9] unit 1).**
10. **Leads counted after confirmation-link use — pending.**
11. **Creator-controlled store badge, off by default — pending.**
12. **Private aggregate activation/time-to-first-sale owner panel — pending.**
13. **Optional six-person pseudonymous groups — pending.**
14. **German, French and Dutch Path with prohibited-language checks — pending.**
15. **Actual NVDA, VoiceOver and TalkBack evidence — pending.** Automated browser
    checks do not certify these assistive technologies.

Each item has its own PR after checking current main, concurrent work and existing
features. All new product copy remains covered by path-words. Creator-local quiet
hours and days use the existing rules, including DST and dispatch margin. No trial
AI, unreserved supplier cost, inferred mission completion, public money or weaker
commercial/tax gate is permitted. This list records scope, not proof of the60%
net-after-tax requirement. Remaining items are not claimed built or tested.

## Ordered Path item 2: post-sale evidence

Six additional missions appear after the first verified live sale: a second published product with an attached file, a completed list campaign with a positive sent count, a returning buyer, a saved post-purchase offer, a current buyer-posted written review and ten distinct paid checkouts remaining after known refunds. Instructions never mark a mission complete. This section does not change the seven-day journey, levels, board score or reminder scheduling.

Money witnesses reuse the existing bounded Stripe sale/refund reading. They exclude other stores, test payments, tips, requests, post-purchase extras and duplicate sessions/payment intents. Full refunds remove a purchase; partial refunds preserve a paid purchase. Missing refunds mean unknown. An incomplete sales reading may prove a positive witness but cannot prove its absence. Buyer email matching is transient within the server calculation: the Path record keeps only a boolean and count, never identities.

Catalogue, campaign and review evidence reserve eight additional requests from the existing studio allowance before reading. This is an internal reservation, not a changed plan limit or price. Each visit reads at most eight published products, three recent campaigns and three recent reviews. The cost registry separately prices fifty database commands and three MB at the write-request shape and checks that the eight reserved studio requests cover it. No additional model, provider or email dispatch is introduced.

Missing, malformed, out-of-scope or incomplete records remain unknown. An explicit missing product-extras key means no saved extra configuration; a malformed or truncated response does not. Current buyer-written reviews use the existing verified-buyer public-review submission and withdrawal flow. A review with only a payment-intent reference cannot prove live mode here. Neither a sent campaign nor a configured offer proves delivery or a sale. PayPal live-sale verification remains ordered item 9; it is not inferred here.

Validation contract: pure state/refund/scope/privacy tests, strict reader failure and admission tests, actual authenticated browser verification, full checks including actual Redis and exact-head production confirmation. Publication evidence and delivery numbering are recorded only after confirming the live domain and version. Missing checkout identities or payment references leave negative witnesses unknown; a positive refund without a payment reference, or unsafe refund arithmetic, leaves money witnesses unknown. No all-tax net-margin or comprehensive accessibility certification is asserted.


## Ordered Path item 3: a small return step

After seven consecutive creator-local date changes without a Path check-in, the owner opening Path receives one welcoming task: spend about ten minutes making one useful update to the store introduction. January 1 to January 8 is seven dates; elapsed 168-hour windows are not used. The saved browser time zone and the existing local-day arithmetic apply across midnight and daylight-saving changes. Path's own day counter uses the same creator-local dates when a saved time zone is available.

The pending return task replaces the ordinary mission grid for that return date. It shows no absence counter or empty streak, and keeps the reached level, private answers, optional board and sharing controls. Opening Path is permitted at any hour. A later local date retires the cue without claiming completion or creating a backlog.

The existing private measured Path JSON keeps only the return date and a SHA-256 comparison fingerprint of the introduction at first return. Reloading preserves that baseline through the existing compare-and-swap write. Only a non-empty, current server-read store name and introduction with a changed introduction can record this task. A link click, client success reply, unchanged save, empty description or model output cannot do so. There is no completion action or extra collection. Owner-only private export includes these markers; forgetting Path, closing or deleting the store removes them with its existing record.

The optional owner-requested phone reminder uses the existing quiet-hours admission and dispatch margin: no unsolicited message from 21:00 through 07:59 in the saved time zone, no offline queue beyond quiet hours, the same twenty-unit reservation before dispatch and the same owner-device consent. There is no new schedule, email, provider read or AI call.

Costs stay within the existing measured atomic write, capped four-KB Path read envelope and unchanged reminder reservation. The stored comparison marker is measured in the existing data-room slot, including refusal when full. No prices, visible plan limits, tax rates, sales switches or supplier ceilings change. A pending return also avoids reading the additional post-sale catalog evidence. None of this certifies the sixty-percent all-tax net margin.

Validation contract: regression reproduced against the old midnight counter; local dates and both DST transitions in Los Angeles, New York, London, Berlin and Sydney; malformed history refusal; factual completion and reload persistence; private parser/export and deletion; stale-write refusal and actual Redis slot accounting; unchanged reminder admission and reservations; authenticated mobile/desktop browser checks including a forged client-only success reply; path-words and full exact-head CI. Automated checks do not certify NVDA, VoiceOver, TalkBack or comprehensive WCAG AAA. Publication and delivery numbering require the live domain and exact version afterward.


## Ordered Path item 4: fixed social post scripts

The owner can choose Instagram, TikTok or YouTube and adapt a fixed script using a published product name already loaded with the store. The saved audience selects the initial platform; the saved time available selects a short or longer preparation cue. Private free-text answers, personal goals, money, buyer identities, prices, availability and results are not inputs to the script. It never invents a product benefit: bracketed demonstration, explanation and link cues require the creator to check their own published facts and replace the cues before sharing.

Only up to three safe published names from the first eight cached head listings and first eight legacy inline listings are offered. Every choice must also exist in that store's own visible index; hidden, foreign, duplicate, malformed, oversized, instruction-like or earnings/pressure names are omitted. This is a bounded preview of already-loaded products, not a claim to list the entire catalog. The review link keeps the selected store. No additional database/provider/model request, key, saved draft, schedule, email or posting integration is introduced.

Platform/product selection stays in the browser. Copy is an explicit action with a named read-only native text area. Clipboard refusal selects that same field for manual copy and never announces that it was copied; overlapping copy attempts are blocked and stale fields cannot receive a success message. Selecting or copying does not change mission facts. The small return-day focus from item 3 continues to show only its one mission.

Reference patterns checked on 19 October 2026: HighLevel's official [Social Planner setup](https://help.gohighlevel.com/support/solutions/articles/155000005063-launchpad-setup-social-planner) separates creation, review and publication; ClickFunnels' official [publishing and sharing guide](https://support.myclickfunnels.com/docs/how-to-publish-and-share-your-funnel-url/) directs creators to review the public destination and copy its address. These are reference patterns, not integrations or evidence of conversion improvement.

Validation contract: published own-catalog filtering and bounds; all three fixed scripts; safe text/refusal and no private goal/free-text inputs; Path wording; actual rendered labels/empty states/response bound; authenticated 390/1280 native selection, keyboard copy, clipboard-refusal fallback, same-store links, no AI/completion requests and automated accessibility checks. Existing guidance was rendered before the change and its named social-script-field assertion failed. Full exact-head CI, actual Redis and live domain/version confirmation are required before delivery numbering. Real assistive technology testing and comprehensive AAA remain separate work. No pricing, visible limit, financial gate, margin assumption or quiet-hours behavior changes, and no tax-margin certification is claimed.


## Optional paid wording (ordered item 5)

An explicit optional request can restate a current first step for paid, non-trial stores with existing writing jobs. Original steps and recording rules remain authoritative and visible; checkout, consent and payment instructions always stay fixed. Model output never records mission progress or levels.

The server selects the current own-store instruction, removing free-text topic and skills. Only this fixed instruction goes to the provider, without personal goals, money, buyers or free-text answers. No model draft is saved. Conservative action, vocabulary, connector and protected-phrase checks supplement heldToFacts; neither is a formal semantic proof. Unusable output keeps the exact fixed instruction.

Each explicit attempt uses the existing writing counter (Pro 40, Scale 80), paid eligibility and monetary hold before provider fetch. One Haiku request is capped at 240 output tokens and 240 displayed characters, within the existing two-call job envelope. Started failures retain quota and monetary holds, without automatic retry or new budget. Existing owner-only bounded Path POST and studio allowances apply. Prices, limits, financial gates and PLANS_ON_SALE remain unchanged. Tax-adjusted net margin is not certified.

Validation covers the canonical pre-change route negative control, strict parsing, current-source isolation, private-field exclusion, quota and monetary-hold ordering, trial/ended/no-quota refusal, retained holds after failure and no completion writes. Browser tests distinguish actual monetary-refusal fallback from intercepted client-only accepted replies. Provider tests exercise actual application reservation code with the existing contract double; actual Lua is independently checked by the Redis suite. These synthetic checks are not real provider calls, actual assistive technology evidence or comprehensive AAA certification. Full exact-head CI and confirmed production version are required before counting a delivery.


## Private reached-level certificates (ordered item 6)

The owner-only Path page offers a certificate for each level up to the server's saved best. First Light comes from the published store and listed product; later levels reuse the existing own-store, live paid Stripe reading and refund calculation. Selecting or downloading cannot raise a level. Saved levels and their certificates remain after refunds; the artifact explicitly distinguishes a saved level from the current sales reading. The saved highest-level reading time is labeled as such, never as the first date each earlier level was reached. Legacy records without a valid saved reading time show no certificate.

There is no public certificate endpoint, verification URL, name, store address, buyer, free-text answer or personal goal in the artifact. Money defaults off independently from the share card, and is included only after explicit consent, with its own reading timestamp. Browser state resets on store or level-record changes. The download is a self-contained semantic US-English HTML document with a heading, labeled data and time, responsive readable text and print styling; a named read-only text field is the fallback. The artifact is a personal record, not a professional qualification or third-party signed credential.

Creation is a local browser action on the existing bounded server response: no additional database, Stripe, model, email, push or storage request; no new recurring cost or automatic certificate notification. Explicit opening/download works at any hour; existing mayNotify and dispatch buffers are unchanged. No new stored certificate needs deletion; existing Path deletion removes its server source, while a downloaded copy remains under the owner's control. Prices, visible limits, receiving-cost assumptions, fiscal gates and PLANS_ON_SALE remain unchanged, without any all-tax margin certification.

Verification contract: existing share-card render is a negative control for the new certificate action; reached-level bounds, retained levels/refunds, private default/explicit money/unknown readings, readable bounded HTML and no external resources; authenticated browser keyboard downloads for each reached level at390/1280, actual downloaded-file text and automated A/AA checks, no server writes, cross-owner refusal. Real NVDA, VoiceOver, TalkBack and comprehensive AAA remain pending. Publication is counted only after full exact-head CI and exact production domain/version confirmation.
