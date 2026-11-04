# Studio demo, no sign-up: design (queue item 256 [KJ1])

State (04/11/2026): **unit 1, design and pure rules, and unit 2, the session door, tested in PRs.** Nothing is reachable: no page links the door, the door (`app/api/studio-demo/route.ts`) answers 404 without reading anything while `STUDIO_DEMO_ON` is `false`, and `STUDIO_DEMO_ON` is `false`. It stays false until every unit below is built and reviewed and `DEMO_UNKNOWN_COSTS` is empty (`tests/studio-demo-rules.test.ts` fails otherwise).

## What it is for

A visitor who has not signed up opens a studio on a copy of the fictional demo store (Harbor Kitchen, `/@harborkitchen`, `lib/house-store.ts`) and makes, in a few minutes, a product, a sales page, an offer, a subscription and an email draft, the way a creator does. At the end, one button leads to sign-up. The problem it solves: a creator deciding between platforms sees the studio work before giving an email address. How it is checked: the flow tested end to end with the real code (synthetic data), then the aggregate counts below. How it brings profit: more sign-ups from the same visits, measured by the `signedUp` count against `opened`.

## The session

1. **The door** (`POST /api/studio-demo`, unit 2, `openStudioDemo` in `lib/studio-demo.ts`). The page that holds the "Try the studio" button protects that path with the existing bot check (`initBotId` in the button's component, `isAutomated()` in the route, `lib/bot-check.ts`), exactly as the sign-in form does. First of all, in one command, the day's count of refused demo requests and the request's own address's are read: past `DEMO_REFUSALS_PER_DAY` (5,000) the door answers "closed", past the address's `DEMO_REFUSALS_PER_ADDRESS_PER_DAY` (10) it answers "address", after that one command and writing nothing. Then a request the bot check calls a program is refused, with nothing counted or written. Then one script (`STUDIO_DEMO_DOOR_SCRIPT`) checks and counts at once the address's sessions today (`DEMO_SESSIONS_PER_ADDRESS_PER_DAY`, 3; an old-kind address as it is, a new-kind one by its network, the /48 of `shareAddress` in `lib/traffic-rules.ts`, so the many /64s one machine can be handed count once; kept as a keyed one-way fingerprint (the key only the deployment has, as `lib/traffic.ts` does), in `nl:sdemo:addr:<day>`, until the day ends) and the day's caps as `demoSessionAllowed()` checks them; it takes the place, reserves the session's whole worst and counts the address, or counts one refusal for the address and for the day, so two doors cannot both take the last place. Then one more script (`STUDIO_DEMO_SEED_SCRIPT`) writes the session's record and its first drafts, all or nothing, each with the same `EXPIREAT`. If that fails, the day's place stays taken: counted, never given back on a guess.
2. **What a session is.** A random id, `sd` + 32 hex digits from `crypto.getRandomValues` (`DEMO_SESSION_ID_PATTERN`), which can never be a store id (`STORE_ID_PATTERN` is 32 hex digits only). It is kept in its own cookie, `nl_studio_demo` (HttpOnly, Secure, SameSite=Lax, Max-Age = `DEMO_SESSION_SECONDS`), never in `nl_session` or `nl_store`. A demo visitor has no sign-in session, so `emailForSession()` answers null and every real studio route (`studioAccess`, `lib/studio-route.ts`) refuses it as signed out.
3. **Its sandbox store.** The session record and every draft live under `nl:sdemo:{<session>}:<family>[:<part>]`, made only by `sandboxKey()`, which refuses any family outside `DEMO_KEY_FAMILIES` (session, product, page, offer, subscription, email, steps) and any part that is not a short plain name. Every key gets the same absolute expiry (`EXPIREAT` at opening + 21 hours), never extended. The sandbox starts from a copy of the demo store's *published seed values* (`lib/demo-seed.ts`), read from the code, never from the house store's Redis record, so the real demo store is never read for writing and never written.

## Isolation: how it is guaranteed

The demo does **not** reuse the real studio routes with a fake session. It has its own routes (`/api/studio-demo/*`, unit 4) that:

- take the session only from `nl_studio_demo`, check it with `isDemoSessionId()` and its record's expiry, and never read `nl_session`, `nl_store`, `x-nimbus-store` or `?store=`;
- read and write only keys made by `sandboxKey()`; the module imports nothing that reaches `lib/store.ts`, `lib/catalog.ts`, `lib/mail.ts`, `lib/email.ts`, `lib/ai.ts`, `lib/ai-spend.ts`, `lib/stripe*.ts`, `lib/upload*.ts`, webhooks, API keys, team, export or import (unit 3 adds a test that reads the demo routes' import graph and fails on any of them);
- ask `demoForbids(capability)` before every handler; the closed list (email, ai, payments, uploads, webhooks, apiKeys, team, export, publish, domains, import) is refused, and so is any capability nobody classified (`DemoCapability` is a union: a new one does not compile until it has a line in `DEMO_CAPABILITIES`).

So a demo session can never resolve a real store, reach a payment, send an email, call an AI provider, upload to real storage, fire a webhook, make an API key, invite a team member, export or import.

## What each studio area shows

The screens (unit 5) reuse the studio's editors in a demo frame, pointed at the demo routes.

| Area | The visitor can | Turned off, with the reason said |
| --- | --- | --- |
| Product | Name, price, description, a cover from the demo's own pictures | Upload a file; publish |
| Sales page | Blocks, headline, preview on computer and phone | Publish; custom domain |
| Offer | An add-on offer at checkout for another demo product | Charging anything |
| Subscription | A monthly price, a trial length, what members get | Charging anything |
| Email | Subject, body, preview | Send, schedule, test send |

- **AI.** Wherever the studio has an AI button, the demo shows a fixed text from `DEMO_AI_EXAMPLES` under `DEMO_AI_LABEL`, "Example answer — the demo does not call the AI", drawn by the page. No model is called and no AI budget is touched.
- **Send and Publish** stay visible, so the visitor learns where they are, and pressing them shows `DEMO_OFF_WORDS` instead of acting.
- **Labelled as a demo.** Every screen carries a banner saying it is a demo on a fictional store and that everything is deleted 21 hours after it opened (VR item 2).
- **End.** After the five steps (or at any time from the banner) one primary button, "Start your own store", leads to `/signin?from=demo` (`DEMO_SIGN_UP`). Nothing made in the demo is carried into the account (that would need a copy path and its own review); the screen says so.

## Conversion, measured without personal data

One hash a day, `nl:sdemo:day:<YYYY-MM-DD>`, kept 400 days, holding only the fields in `DEMO_COUNTS`: opened, each of the five steps, finished, signUpClicked and signedUp. Counted through `lib/capped-count.ts` so the hash can never grow past them. `signedUp` is counted once when an account is made from a sign-in link that carried `from=demo`, as a number only. No address, cookie id, IP, user agent or session id is stored with a count; no pixel, no third-party analytics, no tracking of email opens. The day's `sessions`, `commands` (reserved) and `sent` fields in the same hash are the caps' counters. The day's refusals are counted in `nl:sdemo:addr:<day>` instead, beside each address's own (under its keyed fingerprint), and end with the day.

## Caps, all checked before anything is spent

| Cap | Value | Why |
| --- | --- | --- |
| Session life | 21 hours, absolute | Longer than twenty hours, so WCAG 2.2.1's twenty-hour exception covers it and nobody loses a draft to a clock; the actions and bytes caps bound the cost, not the time |
| Actions a session | 60 | Five steps at about ten requests each, with room |
| Bytes a session | 256 KB; 32 KB an action | Five drafts at their largest, with room |
| Commands an action | 12 at the most | Its own check and count (8, `DEMO_TAKE_COMMANDS`: the refusals read, the record, the day's commands sent, the counting script as billed (4), the day's count), then the draft read and written; an action costed dearer is refused |
| Sessions a day (site) | 500 | Enough to measure conversion; small next to fixed costs |
| Commands a day (site) | 250,000 | Each opening reserves its whole worst (739), so it binds before the sessions do: 338 sessions and 20,280 actions at most |
| Sessions an address (a new-kind one: its /48) a day | 3 | Counted in the door's script when a session opens |
| Refused requests a day (site) | 5,000, 10 commands each at most | Every request reads this count first; past it, one command and nothing written. Checked and counted in one script, so requests at the same moment never count past it |
| Refused requests an address (a new-kind one: its /48) a day | 10 | Counted for the address first and only then for the site, so one address counts at most 10 of the day's 5,000; past its 10, that address alone is answered after one command and nothing is written |

A session opens only while the day has room for its whole worst (`DEMO_SESSION_WORST_COMMANDS`, 739 commands), and that worst is reserved in the day's `commands` as it opens, so concurrent sessions cannot pass the day's cap. Every action is still checked against the commands the day has really sent (`sent`, which never passes the reservation) and counted in the session's record by one script (`STUDIO_DEMO_TAKE_SCRIPT`) before it writes, so two actions cannot both take a session's last place. The action's day is read from the session's record, never taken from the caller. Every refusal after the first read is counted, for its address and for the site, by one script that counts it only while both caps leave room (`STUDIO_DEMO_REFUSE_SCRIPT`, or the door's own script). Every unknown or impossible count refuses (`"unknown"`), never reads as zero.

## Cost: a free feature, a bounded company exposure

The demo earns nothing per session, so its cost is not any plan's: it is a company exposure under MR item 2, covered from the minimum base of paying customers, and needs its line in `docs/funded-exposure-review.md` before it is turned on. Rates come from `lib/spend-cost-table.ts` (read 2026-10-17) and `tests/traffic-cost.ts`; no free quota is counted.

| Resource | Worst, each | Source |
| --- | --- | --- |
| Action: function call, 1.5 s at 2 GB, 0.2 CPU-second | 16.54 µ$ | Vercel rates in `lib/spend-cost-table.ts` |
| Action: 12 database commands | 24.00 µ$ | Upstash $2.00 a million |
| Action: 66 KB through the database (a draft read and written, its check and count) | 2.03 µ$ | Upstash $0.03 a GB |
| Action: CDN request, 120 KB sent to the CDN | 9.20 µ$ | `tests/traffic-cost.ts` ($2 a million; $0.06 a GB) |
| **Action, in all** | **51.77 µ$** | |
| Opening: 4 s at 2 GB (bot check waited on), 19 commands, 4 KB through the database, CDN | 78.59 µ$ | same |
| A counted refusal: 4 s at 2 GB, 10 commands, 2 KB through the database, CDN | 60.53 µ$ | same |
| A session's 256 KB kept its 21 hours | 1.91 µ$ | Upstash $0.25 a GB-month |
| **A session at every cap** | **3,187 µ$ ($0.0032)** | |

Worst day of what is priced: 338 openings and 20,280 actions, with 5,000 counted refusals, **$1.38 a day**. A session lives past midnight, so thirty days can hold the actions of thirty-one days of openings: **$42.47 in thirty days**. `tests/studio-demo-rules.test.ts` checks both figures against the code and checks the day's ceiling against a brute-force search of every number of sessions and actions the caps allow. At the most two days of openings are alive at once: 676 sessions, 177 MB kept.

**Unknown, so the demo stays off** (`DEMO_UNKNOWN_COSTS`; never counted as zero):

1. The script and style files a demo studio page loads from the CDN: not measured for the studio (13 were measured on a store's page). Unit 5 measures them and adds them to the action's cost.
2. The bot check at its basic level: `lib/bot-check.ts` records no charge per check, but the repository has no dated official source for it.
3. Requests refused without being counted: a program the bot check refuses, and every request past the day's 5,000 counted refusals or past its own address's 10, each one database command at the most and nothing written; and requests that passed that first read at the same moment while one place was left and found it taken when counting, each up to 10 commands and nothing written. Each is still a function call, and nothing bounds how many arrive across addresses. The bot check is the brake for the door, and reads have none yet; the review decides whether the site's existing request protections cover the rest.

**Availability, honestly.** With 3 sessions an address (or network) a day, 113 addresses can take the day's 338 sessions; each of them goes through the bot check. Refused requests are counted for their address first, 10 at the most each, so one address alone can no longer close the demo: past its 10 only that address is refused for the rest of the UTC day. Closing the door, the actions and the reads for everyone until the UTC day ends takes 500 addresses or networks, each spending its 10 of the day's 5,000 counted refusals, and reading a session with a made-up cookie does not go through the bot check, so those 500 need no way past it. A network many people share (an office, a school, a phone carrier's) spends one set of 10 for all of them. The cost stays inside the ceiling above whatever happens.

## The next units

1. **Unit 1:** design and pure rules (`lib/studio-demo-rules.ts`, `tests/studio-demo-rules.test.ts`).
2. **Session door (built, off):** `lib/studio-demo.ts` (`openStudioDemo`, `readStudioDemo`, `takeDemoAction`), `app/api/studio-demo/route.ts`, the four scripts (the door, the refusal count, the seed and the action) and their stand-ins in `lib/redis-memory.ts`; `tests/studio-demo.test.ts` on the in-memory Redis and `tests/security/studio-demo-session.redis-run.ts` on a real one. The bot check's page side (`initBotId`) comes with the screens.
3. **Sandbox store module:** the drafts' reads and writes in `lib/studio-demo.ts`, through `sandboxKey()` only, each after `takeDemoAction`; test that nothing outside the namespace is touched. `cost.commands` is declared by the caller, so this unit adds a test that measures what each action really sends (its read, `takeDemoAction`'s 8 and the draft's write, the stand-in's `scriptCalls` included) and holds it at or under its declared cost and `DEMO_COMMANDS_PER_ACTION`.
4. **Studio guard:** the `/api/studio-demo/*` routes, `demoForbids()` before every handler, and the import-graph test that no demo route can reach email, AI, payments, storage, webhooks, keys, team, export or import.
5. **Screens:** the demo frame, the five steps, the labels, the off buttons, the end button, the counts; accessibility to AX274 (WCAG 2.2 AAA, keyboard, screen reader, 44 px targets); the measured CDN files. The 21-hour life meets WCAG 2.2.1 (level A) by its twenty-hour exception. It is still a time limit under 2.2.3 (AAA) and 2.2.6 (AAA): the screens say at the start when it ends and warn before the end, a new session opens in one click, and the case, the reason (the cost ceiling needs an end) and this alternative are recorded in `docs/accessibility-programme.md` by this unit, as AX274 item 1 requires, never presumed.
6. **Review:** costs complete, funded-exposure line, then the owner's decision to turn `STUDIO_DEMO_ON` on. Until all of that, nothing is on and nothing is shown publicly (VR item 2).
