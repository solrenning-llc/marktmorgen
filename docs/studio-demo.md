# Studio demo, no sign-up: design (queue item 256 [KJ1])

State (04/11/2026): **unit 1, design and pure rules, tested in a PR.** Nothing is reachable: no route, no page and no write uses `lib/studio-demo-rules.ts`, and `STUDIO_DEMO_ON` is `false`. It stays false until every unit below is built and reviewed and `DEMO_UNKNOWN_COSTS` is empty (`tests/studio-demo-rules.test.ts` fails otherwise).

## What it is for

A visitor who has not signed up opens a studio on a copy of the fictional demo store (Harbor Kitchen, `/@harborkitchen`, `lib/house-store.ts`) and makes, in a few minutes, a product, a sales page, an offer, a subscription and an email draft, the way a creator does. At the end, one button leads to sign-up. The problem it solves: a creator deciding between platforms sees the studio work before giving an email address. How it is checked: the flow tested end to end with the real code (synthetic data), then the aggregate counts below. How it brings profit: more sign-ups from the same visits, measured by the `signedUp` count against `opened`.

## The session

1. **The door** (`POST /api/demo-studio/start`, unit 2). The page that holds the "Try the studio" button protects that path with the existing bot check (`initBotId` in the button's component, `isAutomated()` in the route, `lib/bot-check.ts`), exactly as the sign-in form does. A request the check calls a program is refused before anything is written. Then, in this order, nothing written until all pass: the per-address limit (`withinLimit("demo-studio", address, DEMO_SESSIONS_PER_ADDRESS_PER_DAY, 86_400)`, `lib/request-guard.ts`), and `demoSessionAllowed()` on the day's counts, read and incremented in one script so two doors cannot both take the last place.
2. **What a session is.** A random id, `sd` + 32 hex digits from `crypto.getRandomValues` (`DEMO_SESSION_ID_PATTERN`), which can never be a store id (`STORE_ID_PATTERN` is 32 hex digits only). It is kept in its own cookie, `nl_studio_demo` (HttpOnly, Secure, SameSite=Lax, Max-Age = `DEMO_SESSION_SECONDS`), never in `nl_session` or `nl_store`. A demo visitor has no sign-in session, so `emailForSession()` answers null and every real studio route (`studioAccess`, `lib/studio-route.ts`) refuses it as signed out.
3. **Its sandbox store.** The session record and every draft live under `nl:sdemo:{<session>}:<family>[:<part>]`, made only by `sandboxKey()`, which refuses any family outside `DEMO_KEY_FAMILIES` (session, product, page, offer, subscription, email, steps) and any part that is not a short plain name. Every key gets the same absolute expiry (`EXPIREAT` at opening + 30 minutes), never extended. The sandbox starts from a copy of the demo store's *published seed values* (`lib/demo-seed.ts`), read from the code, never from the house store's Redis record, so the real demo store is never read for writing and never written.

## Isolation: how it is guaranteed

The demo does **not** reuse the real studio routes with a fake session. It has its own routes (`/api/demo-studio/*`, unit 4) that:

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
- **Labelled as a demo.** Every screen carries a banner saying it is a demo on a fictional store and that everything is deleted after 30 minutes (VR item 2).
- **End.** After the five steps (or at any time from the banner) one primary button, "Start your own store", leads to `/signin?from=demo` (`DEMO_SIGN_UP`). Nothing made in the demo is carried into the account (that would need a copy path and its own review); the screen says so.

## Conversion, measured without personal data

One hash a day, `nl:sdemo:day:<YYYY-MM-DD>`, kept 400 days, holding only the fields in `DEMO_COUNTS`: opened, each of the five steps, finished, signUpClicked and signedUp. Counted through `lib/capped-count.ts` so the hash can never grow past them. `signedUp` is counted once when an account is made from a sign-in link that carried `from=demo`, as a number only. No address, cookie id, IP, user agent or session id is stored with a count; no pixel, no third-party analytics, no tracking of email opens. The day's `sessions` and `commands` fields in the same hash are the caps' counters.

## Caps, all checked before anything is spent

| Cap | Value | Why |
| --- | --- | --- |
| Session life | 30 minutes, absolute | The five steps take a few minutes; nothing lingers |
| Actions a session | 60 | Five steps at about ten requests each, with room |
| Bytes a session | 256 KB; 32 KB an action | Five drafts at their largest, with room |
| Commands an action | 12 at the most | Session read, one counting script, the draft written; an action costed dearer is refused |
| Sessions a day (site) | 500 | Enough to measure conversion; small next to fixed costs |
| Commands a day (site) | 250,000 | Binds before the sessions do (20,500 actions at most) |
| Sessions an address a day | 5 | Through the existing per-address limit |

A session opens only while the day has room for its whole worst (`DEMO_SESSION_WORST_COMMANDS`, 728 commands), and every action is still checked against the day's commands, so concurrent sessions cannot pass it. Every unknown or impossible count refuses (`"unknown"`), never reads as zero.

## Cost: a free feature, a bounded company exposure

The demo earns nothing per session, so its cost is not any plan's: it is a company exposure under MR item 2, covered from the minimum base of paying customers, and needs its line in `docs/funded-exposure-review.md` before it is turned on. Rates come from `lib/spend-cost-table.ts` (read 2026-10-17) and `tests/traffic-cost.ts`; no free quota is counted.

| Resource | Worst, each | Source |
| --- | --- | --- |
| Action: function call, 1.5 s at 2 GB, 0.2 CPU-second | 16.54 µ$ | Vercel rates in `lib/spend-cost-table.ts` |
| Action: 12 database commands | 24.00 µ$ | Upstash $2.00 a million |
| Action: 64 KB through the database | 1.97 µ$ | Upstash $0.03 a GB |
| Action: CDN request, 120 KB sent to the CDN | 9.20 µ$ | `tests/traffic-cost.ts` ($2 a million; $0.06 a GB) |
| **Action, in all** | **51.71 µ$** | |
| Opening: 4 s at 2 GB (bot check waited on), 8 commands, CDN | 56.53 µ$ | same |
| A session's 256 KB kept 30 minutes | 0.05 µ$ | Upstash $0.25 a GB-month |
| **A session at every cap** | **3,159 µ$ ($0.0032)** | |

Worst day of what is priced: 500 openings and 20,500 actions, **$1.09 a day**, **$32.65 in thirty days** (`tests/studio-demo-rules.test.ts` checks both figures against the code).

**Unknown, so the demo stays off** (`DEMO_UNKNOWN_COSTS`; never counted as zero):

1. The script and style files a demo studio page loads from the CDN: not measured for the studio (13 were measured on a store's page). Unit 5 measures them and adds them to the action's cost.
2. The bot check at its basic level: `lib/bot-check.ts` records no charge per check, but the repository has no dated official source for it.
3. Requests refused after a cap: each is still a function call and a read. The per-address limit bounds each address; nothing in the demo bounds them across addresses. The review decides whether the site's existing request protections cover it or the door needs its own cap on refusals.

## The next units

1. **Unit 1 (this one):** design and pure rules (`lib/studio-demo-rules.ts`, `tests/studio-demo-rules.test.ts`).
2. **Session door:** the start route, the bot check on it, the per-address limit, the atomic day counting script and its Redis test.
3. **Sandbox store module:** `lib/studio-demo.ts`, the copy of the seed values, reads and writes through `sandboxKey()` only, with the action check in the same script as the write; test that nothing outside the namespace is touched.
4. **Studio guard:** the `/api/demo-studio/*` routes, `demoForbids()` before every handler, and the import-graph test that no demo route can reach email, AI, payments, storage, webhooks, keys, team, export or import.
5. **Screens:** the demo frame, the five steps, the labels, the off buttons, the end button, the counts; accessibility to AX274 (WCAG 2.2 AAA, keyboard, screen reader, 44 px targets); the measured CDN files. The 30-minute life is a time limit under WCAG 2.2.3 (AAA) and 2.2.6: the screens say it at the start and warn before the end, a new session opens in one click, and unless the review finds a way to bound the cost without it, the case, the reason (the cost ceiling needs an end) and this alternative are recorded in `docs/accessibility-programme.md` as AX274 item 1 requires, never presumed.
6. **Review:** costs complete, funded-exposure line, then the owner's decision to turn `STUDIO_DEMO_ON` on. Until all of that, nothing is on and nothing is shown publicly (VR item 2).
