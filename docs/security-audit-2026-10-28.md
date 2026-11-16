# Security audit, second pass (queue item 506 [SG1])

The item asks for this file under the name `security-audit-2026-10-28.md`; the
pass itself was run on 4 November 2026 by Claude 4, over `origin/main` at
`bdbf26de` (areas A–D) and `7cc419c8` (area E). It repeats the audit of
18 October 2026 ([security-audit-2026-10-18.md](security-audit-2026-10-18.md))
in the same format, with new numbers from MM-SA-13. Its "Rules that must
survive any change" were read first and each was looked for again; MM-SA-01 to
MM-SA-12 are not repeated unless they regressed (none did).

Five independent read-only passes, one per area: (A) sign-in, sessions,
passkeys, two-step, CSRF, redirects and secrets; (B) isolation between stores
and accounts, team roles, the v1 API, MCP and webhooks; (C) creator content
(XSS), uploads and outbound fetches (SSRF); (D) request windows and cost
ceilings strangers can spend, and races; (E) buyer links and tokens, operator
and cron routes, and public exposure. Every finding marked "reproduced" was
shown by bundling the real modules with esbuild against the in-memory Redis
of the test suite (`tests/redis-stub.ts`), with Stripe and email answered by
stand-ins; nothing real was reached, no message was sent and production was
not touched. Findings marked "read" come from reading the code.

This report says what was tested, what was found and what is being changed.
It does not say that Marktmorgen is secure.

## Summary

| Id | Severity | Finding | State |
| --- | --- | --- | --- |
| MM-SA-13 | Medium | Removing a numbers link deleted the public index of any id sent: any account with settings on any store could end another store's `/numbers/<id>` | Fixed in this PR (reproduced; test fails before) |
| MM-SA-14 | Medium | A locked session (two-step reset, or the recovery address) could erase buyers for good and remove the owner's passkeys | With Claude 2's #2078 (inbox C2-76), which locks every irreversible action for a locked session; Claude 4's overlapping branch is not opened (reproduced) |
| MM-SA-15 | Medium | "Require two-step for the team" checks that a member has a second factor, not that this session used it: a member with only a passkey signs in by the email link alone | With Claude 3, 612 [WP11] owns `lib/team.ts` (reproduced) |
| MM-SA-16 | Medium | The public erasure-request form sends access emails without the MM-SA-05 ceiling: strangers can spend the month's access emails and buyers get no link | In progress: `claude4/sg1-erasure-invite` (reproduced) |
| MM-SA-17 | Medium | The certificate PDF is built on every GET with no public-request window, no pacing and no shared cache (about 81 ms of CPU and 107 KB each) | With Claude 3, who holds the route (measured) |
| MM-SA-18 | Medium | A lost chargeback does not close the buyer's access: courses, community, downloads, private feeds and license keys stay open | Decision with Claude 1 (refunds); proposed: close on `dispute.status = lost` (reproduced) |
| MM-SA-19 | Low | The reset path's notices go only to the sign-in inbox the path assumes someone else holds; the confirmed recovery address hears nothing | Waits for #2078 (same file, `lib/two-step.ts`), then Claude 4 (reproduced) |
| MM-SA-20 | Low | Accepting a team invite opens a full fresh session without the code for an account with an authenticator and no store or team | In progress: `claude4/sg1-erasure-invite` (read) |
| MM-SA-21 | Low | `/signin/lost` answers later when the address has a recovery address: the timing tells which addresses have accounts | With Codex, who holds the route (read) |
| MM-SA-22 | Low | API keys, webhook endpoints and calendar feeds an Admin created survive the Admin's removal from the team | With Claude 3 (`lib/team.ts`) (read) |
| MM-SA-23 | Low | The stock lock (15 s) is shorter than the Stripe calls it guards and is released without checking its owner: two buyers can get a checkout for the last unit | With Claude 2, 513 [PF1] (reproduced) |
| MM-SA-24 | Low | Each request of a funded store would send a ~7.9 KB `EVAL` without `EVALSHA`, not counted in the cost registry; dormant while no store is funded | With Codex (costs) (read) |
| MM-SA-25 | Low | The Stripe session id and the PayPal order id are sent to the creator's ad pixels as event and order ids, and in the full page address; whoever reads the ad account's events can use the order for 3 days | With Claude 2 (thanks page) and Claude 3 (pixels) (read) |
| MM-SA-26 | Info | The file download route had no words for three refusals (`used`, `locked`, `two_step`), so they became server errors | Fixed in this PR (test fails before) |
| MM-SA-27 | Info | The video watch-depth listener accepts any origin that looks like YouTube or Vimeo (`evilvimeo.com`); it adds nothing the public beacon does not already allow | Listed |
| MM-SA-28 | Info | `safeFetch` forwards the caller's headers when a GET is redirected to another host; no caller sends a secret on a redirecting GET today | Listed: rule below |
| MM-SA-29 | Info | A sold file over 20 MB kept in Vercel Blob is not forced to download (`saveAs` ignored), on another origin without our cookies; the door is closed in production | Listed |
| MM-SA-30 | Info | A draft product's title and price are visible to whoever knows its 40-bit id (sample certificate, cart GET, preview lessons) | The sample certificate (page, tab title and PDF), the course's front door, its lessons and their downloads, a call's booking page, the reviews page, a podcast's page and the free page's notice: in `claude4/sg1-mm-sa-30`, each answering a draft as an id that does not exist (test fails before). A published sample PDF stays at the CDN up to five minutes after going back to draft. The cart's GET: with Claude 2, 513 [PF1] holds the route (reproduced) |

Also noted, no path found: a 60 s lock in `lib/review-ai-summary.ts` released
without checking its owner (studio only, bounded by the month's AI jobs); the
two-step wrong-code counter is read-change-write (the atomic hourly limit
holds); `/transparency` reads Redis twice per visit with no pacing (the class
of MM-SA-11); the store assistant's checkout reminder can send up to 50 emails
a day from addresses strangers type (dormant while the assistant is not on
sale); the community chat pass stays valid up to 20 minutes after a member
leaves (documented in `lib/chat-pass.ts`).

## New rules that must survive any change

1. A removal by id lets go of a public index only when the id is in the
   remover's own record or the index names the remover (MM-SA-13; the short
   links and the funnel share already did this).
2. Every refusal a route can receive has its own answer; a refusal map is
   typed by the refusal type so a new one cannot become a server error
   (MM-SA-26).
3. A GET that sends a secret header never follows a redirect (`maxRedirects:
   0`), or the secret is dropped when the host changes (MM-SA-28).
4. A public address that shows a product by its id checks `hidden` first: a
   draft is shown only to its buyers and to the store's owner and team,
   signed in (`lib/draft-view.ts`), and no shared cache keeps what they see
   (MM-SA-30).

## What was checked and held

- **Sign-in and sessions:** one-use links of 256 bits stored only as hashes and
  spent with GETDEL by a POST, never by a page load; a new 256-bit session id
  at each sign-in, the browser's old session ended; HttpOnly, SameSite=Lax,
  Secure, 30 days; sign out everywhere; address change needs a fresh unlocked
  session and ends the old address's sessions.
- **CSRF and redirects:** `guardApi` in `proxy.ts` refuses every cross-site
  write to `/api/` by Origin or Sec-Fetch-Site (unsubscribe excepted); GETs
  with effects are provider returns bound to a one-use state and the same
  person; every redirect is built from the site origin plus a fixed path.
- **Passkeys and two-step:** fixed RP id and origin, user verification
  required, challenge bound and spent once, counter checked, credential id
  reserved with SET NX; codes limited per hour and per pending sign-in, a used
  code refused again, recovery codes hashed, the secret sealed to the address.
- **Isolation and roles:** every studio route resolves the store through
  `studioAccess` and refuses a store the person cannot open; the role is read
  per request; owner-only actions (billing, payments, team, delete, store copy,
  path) stay with the owner; exports need `export`; ids read or written by id
  (webhook resend, short links, funnels, imports, letters, file attach,
  calendar feeds) are checked for their owner.
- **API, MCP and webhooks:** API keys are SHA-256 of 160 random bits, bound to
  the store, revoked at once and on store deletion; the MCP has read tools
  only; there is no inbound Stripe webhook; SNS checks the topic, the
  certificate host, the signature, a one-hour window and the MessageId; Resend
  checks Svix HMAC within 5 minutes in constant time with replay refusal;
  OAuth states are one-use and bound to the session; outbound webhooks are
  signed and sent through `safe-fetch` without following redirects.
- **Content, uploads and fetches:** the four `dangerouslySetInnerHTML` uses with
  variable data escape their input; emails, feeds and generated HTML escape
  what they interpolate; store looks accept only hex colours and fixed lists;
  pixel ids are checked by format; uploads are presigned for one path, one
  method, set types and sizes, 10 minutes, no overwrite, inside the store's
  folder; sold files go out as attachments with `nosniff` and a sandbox CSP;
  every creator- or buyer-influenced fetch goes through `safe-fetch`, which
  resolved and refused loopback, private, link-local, NAT64, metadata and
  rebinding names in a probe of the real code.
- **Request windows and costs:** every body is read through `limited()`;
  routes added since 18 October need the studio, an API key or the cron
  secret; model calls reserve their ceiling before calling; the sign-up,
  waitlist and affiliate emails keep `asked`; MM-SA-04's canonical pictures
  and pacing hold.
- **Buyer links and operator:** buyer tokens are 128–256 bits, hashed, expiring
  and bound to the store; order, course, community, download, feed, package,
  waitlist and erasure links checked against the buyer's own purchases;
  refunds and ended subscriptions close access; link forms always answer
  "sent"; the 19 cron routes accept only `Authorization: Bearer` compared in
  constant time and close without the secret in production; the operator
  route answers 404 to anyone else.

## Not verified

Real browsers, real Redis under load, the production configuration of Vercel,
R2 and Blob, and the routes as served by a running Next.js (areas D and E were
shown on the library functions and route handlers, not through the server).

## Third pass: every route, 12 November 2026 (MM-SA-31 onward)

Run by a Claude 1 cloud session over `origin/main` at `7dfaa097`, after
MM-SA-30's cart GET (#3884) showed that a draft's title and price reached
anyone with its id. All 347 route files (`app/**/route.ts`: 336 under
`app/api`, 11 elsewhere) were read by seven independent reviewers, one per
slice, for: who may call the route; authentication; the store and the object
behind every id (IDOR); drafts, hidden, suspended and closed content;
webhook signatures and replay; the cron and operator secrets; windows and
cost ceilings on anything that emails or calls a paid service; input sizes,
paths and redirects; personal data in answers and logs; and writes from
another site. There are no server actions (`"use server"` appears nowhere).
"Reproduced" means a synthetic test that calls the real route or library
function on the in-memory Redis, with Stripe and email answered by
stand-ins, failed before the fix; "read" means code reading only. Nothing
real was reached and no message was sent. Findings already open elsewhere
are named with their PR and not fixed again.

| Id | Severity | Finding | State |
| --- | --- | --- | --- |
| MM-SA-31 | Medium | The studio inbox's `saved` and `chat` actions wrote through `store.email`, the key of the owner's FIRST store: a Support member of a second store overwrote the first store's saved replies, and a member with `settings` switched the first store's public chat | Fixed in `claude/gracious-meitner-kqpnck` (reproduced; `tests/inbox-store-ref.test.ts` fails before) |
| MM-SA-32 | High | A call package paid for any other call of the store: `/api/store/book` checked that the package belonged to the store, never to the call booked, so the cheapest package opened a 100%-off checkout for the dearest call, once per session left | Fixed in `claude/sa-32-call-package`, in the route (`lib/call-packages.ts` is Codex W's) (reproduced; `tests/call-package-other-call.test.ts`) |
| MM-SA-33 | Medium | A draft could be a checkout box (order bump): the public product page drew the draft's title and price and the checkout charged it as a line; the same rule fed the offer after paying and a call's add-ons | Fixed in `claude/sa-33-draft-bump`: a draft is its own pause, `targetDraft` (reproduced; `tests/draft-bump.test.ts`) |
| MM-SA-34 | Medium | "Get my link" signed any holder of an order id, of any age, in to the payer's EXISTING affiliate account (address, earnings, where commissions are paid); the id travels in emails, the thanks page's address and the ad pixels (MM-SA-25) | Fixed in `claude/sa-34-affiliate-join`: an order makes a new affiliate only; a known one gets the emailed sign-in link (reproduced; `tests/affiliate-join-known.test.ts`). Left: an order id leaked before its buyer joins still makes that buyer's affiliate record (no earnings yet); the buyer is the one emailed |
| MM-SA-35 | Medium | The recovery-address code was limited per sending account only, a company-metered email: free accounts could send a stranger's inbox our email without bound | Fixed in `claude/sa-35-recovery-recipient`: also 5 an hour per recipient, hashed (reproduced; `tests/recovery-address-recipient.test.ts`). The two-step backup address has the same shape: MM-SA-49 |
| MM-SA-36 | Medium | `/api/report` counted its 5 notices an hour per exact address; one machine holds a whole IPv6 /64, so notices, support emails, 400-day records and the transparency count had no limit | Fixed in `claude/sa-36-report-network`: counted per network (IPv6 /48, IPv4 itself), in the route (`lib/takedown.ts` counters are Codex N's) (reproduced; `tests/report-network-limit.test.ts`) |
| MM-SA-37 | Medium | An Editor (no `send`) could launch a waitlist: an email in its own words, in the store's name, to every confirmed address | Already fixed in open PR #3801 (reproduced again here) |
| MM-SA-38 | Medium | `/api/store/package` opened a Stripe checkout and held an order slot for 25 hours with no window per connection: one stranger filled the month's orders and paused every checkout of the store | Already fixed in open PR #3802 (reproduced again here) |
| MM-SA-39 | Low | `/api/store/free/download` serves a free copy's file after the product went back to draft, was hidden by a takedown, or the store was suspended (links live 7 days) | Listed: refuse on `product.hidden \|\| store.suspended` with the existing 410 (read) |
| MM-SA-40 | Low | `/api/store/form` starts a form's sequences for any address typed that is already on the list, with the outcome the sender picks | Listed: enroll only after the address is proven (read) |
| MM-SA-41 | Low | `/api/store/community/open` and `/api/store/course/open` spend the emailed token on a GET and set the pass, which outranks a non-owner session: a link of the sender's own, opened by someone else, makes their browser act as the sender | Listed: confirm with a same-site POST, as sign-in does (read) |
| MM-SA-42 | Low | A community member's key is an unsalted hash of their email, the same in every store, and is shown to other members: an address can be tested offline and linked across stores | Listed: a keyed hash per community (needs a migration) (read) |
| MM-SA-43 | Low | `/api/store/read` counts reading depth with no window per connection (its sibling `/api/store/hit` has one): numbers can be skewed and Redis commands spent | Listed (read) |
| MM-SA-44 | Low | `/api/store/upsell` reads the Stripe checkout before checking the offer's secret, outside the store's public window | Listed: stop when the secret is missing; use `withinStore` (read) |
| MM-SA-45 | Low | The weekly email's stop token and its "off" mark are kept by handle: after a handle is released and taken, the old owner's link still stops the new store's email | Listed: key them by store id (read) |
| MM-SA-46 | Low | `/api/store/address` answers `taken` before the fresh-session check and the hourly window: any signed-in creator can test which addresses have a store | Listed: move the answer after both (read) |
| MM-SA-47 | Low | The buyer library link (`lib/buyer-library.ts`) and the affiliate hub email (`lib/affiliate-hub.ts`) take a store's access emails without `asked`, so a buyer or affiliate asking for their own link can spend the month's figure (the MM-SA-05 class) | Listed; dormant while nothing is on sale (read) |
| MM-SA-48 | Low | `stopCounting` in `lib/mail-clicks.ts` writes back a whole contact read earlier, without a lock: racing an unsubscribe or a bounce, it can write `unsub: false` back | Listed: write only the clicks field (read) |
| MM-SA-49 | Low | The two-step backup address (`lib/two-step.ts`) has MM-SA-35's shape: codes limited per account only | With Claude 4, who holds the file (read) |
| MM-SA-50 | Low | `/api/creators` keeps every survey answer (up to ~20 KB, 24 months) with a per-connection window only and no length cap or robot check | Listed (read) |
| MM-SA-51 | Low | `/api/auth/move` logs both addresses in a `console.error` | Listed: log neither (read) |
| MM-SA-52 | Info | A draft's existence (no title or price) shows in where three forms redirect: `paypal/checkout`, `package`, `podcast/link` | Listed: answer a draft as an unknown id (read) |
| MM-SA-53 | Info | Waitlist launch accepts a draft; `letters/open` issues a pass for a suspended store; manifest, store robots and the blog feed answer for a suspended or resting store; `/go/[funnel]`, feeds and manifests read Redis outside the store's public window (MM-SA-01/11 class) | Listed (read) |
| MM-SA-54 | Info | Six studio routes call `ensureStatsId(store.email)`, MM-SA-31's mistake; dormant because every store is made with a statsId | Listed: use `guarded.ref` (read) |
| MM-SA-55 | Info | Discord's buyer `join` return is not bound to the browser (OAuth CSRF that only adds the victim's Discord to the sender's server); `meta/deauthorize` has no replay mark; `mail/inbound` keeps no replay mark when Redis throws; `/invite/[code]/accept` sets its cookie on a GET (dormant) | Listed (read) |

Also checked and held in this pass: every studio route resolves its store
through `studioAccess`/`guardStoreWrite` with its permission and reads each
id inside that store; the v1 API and MCP read only the key's store; all 19
cron routes put `cronAllowed` first; SNS, Svix, Bunny, Zoom and Meta
signatures are checked in constant time; `guardApi` lets no other site write
to `/api/` except the unsubscribe; every model call reserves its ceiling
first; every public route that shows a product by id checks `hidden`, except
the cart GET (#3884) and the box of MM-SA-33.

### Rules added by this pass

5. A studio route writes through the reference it was settled on
   (`guarded.ref`), never `store.email`, which names the owner's first store
   (MM-SA-31).
6. A credit, package or grant bought for one product is checked against the
   product it is spent on, in the same request that spends it (MM-SA-32).
7. A public form that sends email is limited per recipient as well as per
   sender, and a per-connection window counts IPv6 by network, never by
   exact address (MM-SA-35, MM-SA-36).
8. A bearer id that travels in emails or addresses (a checkout id) proves a
   purchase; it never signs anyone in to an account that already existed
   (MM-SA-34).
