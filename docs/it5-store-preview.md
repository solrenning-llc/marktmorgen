# 488 [IT5]: a store preview before an account (unit 0, the design)

Design written by Claude 4 (cloud U) on 15 November 2026, from the code on main at the time of writing. Nothing is built by this document and nothing changes for anyone: no route, page, switch, price, limit, commission or gate. It records what the preview reuses from 219 [OP5], what it costs at worst, how that cost is bounded and paid for, and the units that build it, tests first.

## What the item asks

On the home page a visitor pastes the link of their own page (Stan, Linktree, Beacons, their own site) or writes what they sell, and sees in a few seconds a draft preview of their store. To keep it they create the account, and the preview becomes the studio's draft with nothing typed again. Nothing is published. Each preview uses 219 [OP5]'s rules for reading a page and for AI, under an automatic monthly ceiling of anonymous previews inside the places of stores that pay nothing (lib/free-pool-rules.ts), behind the robot protection that already exists, with a reservation before every call. Past the ceiling the page shows the demo of 256 [KJ1].

## What already exists (reuse, do not rebuild)

- **The draft itself:** `writeStoreSetup` (lib/ai.ts) writes three lines for under the store's name, up to three products, four to six questions and answers, and at most three questions back. It already:
  - never keeps a price the creator did not write (`statedPrice`);
  - never asks about money;
  - quotes a page only as facts;
  - passes every text through `honesty`.
  The preview uses the same prompt and the same checks, never a second copy of them.
- **Reading the visitor's page:** lib/source-page.ts (`readSourcePage`, through lib/safe-fetch.ts) reads at most `SOURCE_PAGE_BYTES` (1,000,000), for at most `SOURCE_PAGE_MS` (8 s), and keeps at most `SOURCE_TEXT_CHARS` (3,000). It is off (`SOURCE_PAGE_READING_ON` false). Until it is on, the preview takes only the typed words, as the studio does.
- **The studio's draft screen:** components/store-setup-ai.tsx, where a kept preview lands.
- **The places of stores that pay nothing:** lib/free-pool-rules.ts. `freePoolSize(paying)` = `FREE_POOL_BASE_STORES` (10) + floor(paying / `PAID_STORES_PER_FREE_STORE` (40)). The worst window of one such store is `nonPayingWorst()` in tests/plan-cost-registry.ts, US$5.33 today, carried by each paying store as the line `free-share`.
- **Robots:** `isBot` (lib/source-rules.ts), the per-address limits of lib/request-guard.ts (`withinLimit`) and the daily door counts of the studio demo (lib/studio-demo-rules.ts, 256 [KJ1]: a site-wide day count and a per-address day count, checked before anything is spent).
- **The demo shown past the ceiling:** 256 [KJ1], off (`STUDIO_DEMO_ON` false). While it is off, the page past the ceiling shows the plain sign-up, with words that say previews are full for now.

## What one preview costs at worst

Every figure comes from the repository's own tables; none is typed in the code that will hold it.

| Part | Worst | Source |
| --- | --- | --- |
| First draft: one writing job | 62,699 µUSD | `WRITING_JOB_MICRO_USD` (lib/spend-cost-table.ts: Sonnet 5.5, 12 KiB in, 3,000 tokens out) |
| The answers round: at most one more job, after the visitor answers the questions | 62,699 µUSD | the same reference; a preview never makes a third job |
| The function time of those two jobs (the route's own duration, 2 GB) | **not priced yet** | priced in unit 1 from the AI route's existing function line, never assumed |
| The page read (inside the first job, as in the studio) | inside the job's own reservation | lib/source-page.ts; OP5's open complement (3) must first give the writing reference room for the page text |
| The database: the counts, the reservation, the preview kept 24 hours and read back | at most 40 commands, about 80 µUSD | `UPSTASH_MICRO_USD_PER_MILLION_COMMANDS`; held by a count in unit 2's tests |

**Known so far:** 125,478 µUSD (about US$0.13) a preview, before the function time. Until that line is priced, the preview's worst is **unknown**, and the switch stays off (rule: unknown fails, never zero).

## Who pays for it: the owner chooses

A preview has no store behind it, so it cannot sit in any store's own AI budget (`AUTOMATIC_AI_STORE_MICRO_USD`). It is a funded exposure, like a free trial, and must be bounded and carried by the stores that pay.

- **(A) Recommended: a monthly count of its own, grown by the paying stores.** Previews in a calendar month (UTC) ≤ `PREVIEW_BASE` + floor(paying stores × `PREVIEWS_PER_PAYING_STORE`).
  - Each paying store, on every plan, carries `PREVIEWS_PER_PAYING_STORE` × the preview's worst, as a new line `preview-share` in tests/plan-cost-registry.ts.
  - `PREVIEW_BASE` × the preview's worst is a fixed cost in the minimum paid base, as `FREE_POOL_BASE_STORES` is.
  - It is apart from the free places, so a burst of previews never keeps a trial from starting.
- **(B) Inside the free places, as the item's words say.** Each preview takes a fraction of one of the month's free places: floor(`nonPayingWorst()` / the preview's worst) previews make one place, about 40 at today's figures. It needs no new cost line, but previews and trials then share the same places. A busy month of previews leaves fewer trials, and a trial is the step that pays.

### What (A) adds to each plan's worst month (to be computed in code by unit 1)

With `PREVIEWS_PER_PAYING_STORE` = 1 and the known part only (US$0.1255; the function time comes on top):

| Plan | Monthly: added to the worst month | Yearly: added over the year |
| --- | --- | --- |
| Store $69 | US$0.13 | US$1.51 |
| Studio $449 | US$0.13 | US$1.51 |
| Scale $999 | US$0.13 | US$1.51 |

`PREVIEW_BASE` = 100 would add about US$12.55 a month to the fixed costs (FX275, 100% Marktmorgen's), plus the function time. These are proposals for the owner; nothing is in force. Each plan's unit must stay positive with the line added, under the current receiving costs and the TX policy, and unit 1's test holds that.

## How it stays bounded (every check before anything is spent)

1. **The switch:** `STORE_PREVIEW_ON` is false, the same pattern as `ZOOM_APPROVED`. The home page shows no field while it is off, and a test fails if any page offers it.
2. **A robot** (`isBot`) is answered with the plain sign-up and reaches no count.
3. **Per address:** at most 2 previews a day (UTC), counted before the site-wide count, as the demo's door does. The address is hashed, never kept as typed.
4. **Site-wide:** the month's count under (A) or (B), and a day count of a thirtieth of it times two, so one day cannot spend the month.
5. **The reservation:** the preview's worst is reserved from the month's preview budget before the first call. Settling and releasing follow the AI ledger's rules: settled at the billed tokens, released only on a provider error status, kept whole on a timeout.
6. **One answers round at most;** a third job is never made.
7. **Past any count,** nothing is called; the page says previews are full for now and offers the sign-up (or the demo once 256 [KJ1] is on).

## Keeping the preview, and privacy

- **Where it is kept:** the visitor's words and the draft are kept 24 hours under a random token, in their own family of keys, never indexed, never linked to a person. A page read is kept only as the draft made from it.
- **Signing up:** creating the account within those 24 hours copies the draft into the studio's setup draft (components/store-setup-ai.tsx), with no second AI call, and deletes the token at once. Nothing is published, and every product still has no price unless the visitor's own words gave it.
- **Deleting it:** the visitor can delete the preview at once from the page.
- **The policy:** the privacy policy says all of this in the same pull request that turns any of it on (lib/person-data.ts, app/privacy).

## Honesty and accessibility

- **Honesty:** the same honesty and price rules as the studio's draft. The page never says "in minutes", "instantly" or any time it has not measured (219 [OP5] scope 7). It never says the preview is published, and it says clearly that nothing goes live without the creator.
- **Accessibility:** WCAG 2.2 AAA, as every other screen.
  - One field and one button, labeled in plain US English, with an example inside the field.
  - The progress is announced in a live region; there is no fake bar.
  - The draft is read in order with headings; every control is usable by keyboard alone and has a 44 px target.
  - There is no time limit on the preview's page (2.2.3); the 24 hours concern only how long the draft is kept, and the page says so.

## Units, tests first

0. **This design** (no code).
1. **Rules and cost** (built on 15 November 2026, in this branch, tests/store-preview-rules.test.ts): lib/store-preview-rules.ts (pure), with the switch, the per-address and site-wide caps and the preview's worst computed from `WRITING_JOB_MICRO_USD`, the function time and the database commands.
   - The function time is priced from the duration the preview's own route must declare (`PREVIEW_ROUTE`, `export const maxDuration = 60`): every second at full CPU and 2 GB, plus the call, once per job. With those rates the worst is 130,454 µUSD (about US$0.13) a preview: 125,398 for the two jobs, 4,976 of function time and 80 of database. Until that route exists with that declaration, `previewWorstMicroUsd` answers null, and the test requires the switch off.
   - The month's ceiling (`previewMonthCeiling`) takes the source of its places, (A) or (B), and chooses neither; anything malformed makes none.
   - The `preview-share` line in tests/plan-cost-registry.ts, with a test that every plan stays positive with it, monthly and yearly, waits for the owner's choice: under (B) there is no new line.
2. **The anonymous job** (built on 15 November 2026, in this branch, off):
   - **The split** (tests/store-setup-split.test.ts): `writeStoreSetup` in lib/ai.ts is split into three pure parts, `storeSetupWords` (the words, trimmed and capped), `storeSetupRequest` (the system and user prompts) and `parseStoreSetup` (the answer read and held to its shapes). The studio's job keeps its store-counted wrapper and does exactly what it did: the test holds a digest of the exact request it sent and the draft it returned, taken before the split, and checks that the parts rebuild both.
   - **The job** (lib/store-preview.ts, tests/store-preview.test.ts): `previewDraft` answers "off" while `STORE_PREVIEW_ON` is false; nothing calls it yet, and the test fails if anything but its own gate calls the switch-free core. It asks exactly what the studio's draft asks, of the same writing model, with the same 2,500 output tokens (`PREVIEW_OUTPUT_TOKENS`), and reads no link (a link waits for 219 [OP5]).
   - **The money, as the Store assistant's pool:** the same `ASSISTANT_POOL` script on a key of its own, `nl:storepv:pool:<month>`. The request's worst is reserved before the call and may never pass one priced writing job. It is settled at the billed tokens (`previewSettledMicroUsd`, the assistant's reading for the writing model), released only on a provider error status and kept whole when it may have billed. A cap that is unknown or spent asks nothing, and the first cap of a month is kept, so a later, larger one does not raise it.
   - **The pool's cap** (`previewPoolCapMicroUsd`): the month's previews times `PREVIEW_JOBS` times `WRITING_JOB_MICRO_USD`, from the places the owner chooses, (A) or (B), passed in. It is null while the route is not priced. Only the model is drawn from it; the function time and the database are bounded by the route's counts.
   - **The counts:** every job is counted per preview before anything is spent and stays counted; a third is answered "used". The address's and the site's day counts are the route's, in unit 3.
3. **The door and the home page form,** behind the switch.
   - **3a, the door** (built on 15 November 2026, in this branch, off; lib/store-preview-door.ts, app/api/store-preview/route.ts, tests/store-preview-door.test.ts):
     - Off, it answers 404 as a path that does not exist, before reading the body or the database. The route declares `export const maxDuration = 60`, so the preview's worst is priced (routePricedIn holds the route's source), and passes no option.
     - Refused before any count: another site, the hidden field, a body over 8 KiB or not JSON, a robot (lib/bot-check.ts), and a form with nothing to draft from.
     - **The owner's choice decides whether there are any previews at all:** `PREVIEW_PLACES` is null, and the count of paying stores is not read yet. With either unknown, previews are "full" and nothing is asked.
     - A new preview counts its address's day first (its network block, keyed, never the address as typed; `nl:storepv:addr:`), so a refused address takes nothing from the site. Then the site's day (`previewDayCeiling`) and month.
     - The answers round needs an id this door opened: 16 random characters signed with the day (`deriveKey`), good that day and the next. Checking it sends nothing to the database; with no key, the door opens nothing.
     - One preview with its answers round sends at most 38 database commands, scripts counted command by command, within `PREVIEW_DB_COMMANDS` (40). That leaves 2 for unit 4 (keeping the draft and reading it back), which must recount them and raise the priced figure if they do not fit, never leave one out.
   - **3b, the form** (built on 15 November 2026, in this branch, off; components/store-preview-form.tsx, components/store-preview-draft.tsx, lib/store-preview-words.ts, tests/store-preview-form.test.ts):
     - The home page shows its section only inside `{STORE_PREVIEW_ON ? ... : null}`, and no other page names the form.
     - One field, labeled, with an example inside it, and one button. The progress is said in a live region, with no bar and no promised time; when the draft arrives, the focus moves to its heading.
     - The draft is read in order under headings: lines for under the name, products and questions buyers ask. A price is shown only where the visitor's words gave one (otherwise "No price yet: you set it"), and the draft says plainly that nothing is published.
     - Its questions are groups of answers to press; one more draft is written with them, never a third.
     - Every refusal is said in plain words with a way on; "full" and "address" offer the sign-up.
     - Targets of at least 44 px, a visible focus and lines no wider than 80 characters (app/home.css).
     - **Not yet checked:** a screen reader, a keyboard-only pass in a browser and the reading level by a tool. Those wait for the pull request that turns it on.
4. **Keeping it:** the 24-hour token, the copy into the studio on sign-up with no second call, and deletion by the visitor and on expiry.
5. **The privacy words** and the public help line, in the same pull request that would turn it on; turning it on is the owner's.

## Depends on

- **Prices:** the owner's choice of (A) or (B), and the figures of `PREVIEW_BASE` and `PREVIEWS_PER_PAYING_STORE`.
- **219 [OP5]:**
  - complement (3): a writing reference that covers the page text, before a link is read anywhere;
  - unit 2's wiring (the link field and the route passing `link`), before a preview reads a link.
- **256 [KJ1]:** for the demo shown past the ceiling. Until it is on, the plain sign-up is shown.

No account, term, contract, payment or contact with anyone is needed for any unit up to 4.
