# Security audit, 18 Oct 2026

An independent pass over Marktmorgen, run from `origin/main` at `c827af40`
and carried forward as main moved; the fixes landed on top of `3b9fb09f` (#563). Hazelsong's second audit of the
same day (its `docs/security-audit-2026-10-18-second.md`) was read first for
the classes of fault found there, and each class was looked for here.

Every finding below was reproduced with a check that runs the real route
handlers and library code against a real `redis-server`, through the real
Upstash client (`lib/redis.ts`), served by `scripts/test_security_redis.py`
the same way the repository's other real-Redis checks are. Every probe used
synthetic stores, addresses and tokens. Stripe, Resend and the file store were
answered by stand-ins inside the check; no message was sent, no paid API was
called and production was not touched.

This report says what was tested, what was found and what was changed. It
does not say that Marktmorgen is secure. A reading of 316 route handlers
(the store's, the v1 API, the MCP server and the platform's own) cannot show
that no fault remains.

## Summary

| Id | Severity | Finding | State |
| --- | --- | --- | --- |
| MM-SA-01 | High | One connection could spend a store's whole window of public requests (made-up download links were enough), and the store then rested for every buyer until its month turned | Fixed: #562 |
| MM-SA-02 | Medium | A paid payment request could be written back as open by a reminder, a checkout being opened or a cancel that had read it before the payment: more reminders to the payer, and a second checkout | Fixed: #564 |
| MM-SA-03 | Medium | Sending an agreement's link or signed copy again could erase a signature, or a new version, written while the email was going; the agreement's lock was released by whoever finished | Fixed: #565 |
| MM-SA-04 | Medium | Product pictures, store photos and home-screen icons were read again by a function for every query string or made-up name, counted by nothing | Fixed: #566 |
| MM-SA-05 | Medium | Strangers typing addresses into a store's sign-up box, waitlists or affiliate form could spend the month's access emails, and buyers were then sent no link to what they had bought | Fixed: #567 |
| MM-SA-06 | Low | The sign-in link's per-address throttle counts strangers' requests | Listed, not fixed |
| MM-SA-07 | Low | Buyers' links (downloads, orders, a private feed) travel in query strings | Listed, not fixed |
| MM-SA-08 | Low | Pictures (products, links, pages, emails, reviews) are kept outside the storage figure and never swept when unattached: what a store keeps of them grows month over month, and no line of the cost registry prices it | Owner's decision needed |
| MM-SA-09 | Low | An affiliate's leads were decided by read, change and write without a lock: an approval racing a person's deletion wrote their address back, a deletion racing an approval wrote the lead back open, and an approval racing a reversal paid a lead marked fake | Fixed: #569 |
| MM-SA-10 | Low | A body with no declared length was read whole before its ceiling was checked: the v1 API, the MCP server, the community's chat, push and messages doors (anybody can post to them), the weekly email's switch and the operator's Search Console form | Fixed: #570 |
| MM-SA-11 | Info | Pacing by connection is per machine: many machines at once are the host firewall's to stop | Owner's step |
| MM-SA-12 | Info | An agreement's signer types the address it was sent to, which the agreement's own text prints: it proves holding the emailed link, not more | Left as it is |

The checks for the seven fixed findings are `tests/security/*.redis-run.ts`,
run by `scripts/security-redis.mjs` through `scripts/test_security_redis.py`
in the `form-opportunity-redis` job of `.github/workflows/product-checks.yml`
("Actual Redis security checks"). Each fails on the code before its fix and
passes after it.

## Rules that must survive any change

1. **A public request is counted for its connection before its store.**
   `countRequest` asks the connection's share first; a new public route goes
   through `withinStore` or `takePublicRequest`, never straight to the store's
   counter. Only a request no person is behind (a podcast app's feed) is
   counted with `{ shared: true }`.
2. **A record two hands can write is changed under its lock, from what is
   stored now.** A payment request through `changeRequest`, an agreement
   through `changeAgreement`, a program's leads under their lock in
   `decideLeads` and `forgetLeadPerson`; a slow step (an email, a provider's
   answer) never sits between a read and the write it decides. A lock is
   released only by its holder.
3. **A picture, photo or icon is read only at the address the CDN keeps**,
   and every answer a function gives is paced (`lib/picture-pace.ts`). A new
   route that serves a cached file does the same.
4. **An email to an address a visitor typed is `asked`.** A new form that
   confirms an address uses `meter: { ..., kind: "transactional", asked: true }`,
   so strangers can never spend the links buyers are sent.
5. **A finding's check stays in CI.** Each journey in `tests/security/` fails
   on the code before its fix; removing one, or a stand-in's recording, needs
   the same review as removing the fix.

## MM-SA-01 (High): one connection could rest a store

**Where.** `lib/traffic.ts` (`countRequest`, `isResting`, `takePublicRequest`)
and every public route counted with `withinStore` (`lib/metered-limits.ts`).

Every page a store draws and every public request it answers is one of the
requests its plan covers in its window (`requestLimitFor`: three for each
visit of the plan's figure and a plan's extra). Past 95% of them the store's
public pages rest; past all of them, what buyers have (downloads, courses,
the community, a private feed) is refused, until the window turns. Nothing
told one connection apart from another. On a creator store the window is
10,700 requests, and the download route counted a request for every link
asked for, made up or not (its own per-link limit keys each link apart, so
every invented link was a fresh bucket that still took a store request). One
machine could spend a store's month in minutes, and its buyers were shut out
for the rest of it.

**Proof.** `tests/security/store-window-share.redis-run.ts`: a paying creator
store with its window four hundred requests from where public pages rest is
sent six hundred made-up download links from one address through the real
`GET /api/store/download`. On the old code nothing was refused, the counter
passed the public limit, `isResting` turned true and a buyer on another
address was refused (3 of 7 checks failed).

**Fix (#562).** Each connection's requests are counted for the day as well
(`nl:traffic:c:<folder>:<window>`, a hash field per day and connection), and
past its share (`clientDayShare`: the larger of 300 and a fiftieth of the
window, so 300 a day on a creator store, 640 on Pro, 2,500 on Scale) that
connection alone is refused, before the store is charged. A connection is an
IPv4 address, or an IPv6 /48 (`shareAddress`), so one machine with a network
of its own is one connection. The store's own figure, and everything that
rests at it, is unchanged. The share is added ten requests at a time
(`SHARE_BATCH`, one HINCRBY and its EXPIRE), so it costs 0.2 commands a
request at the most (`SHARE_COMMANDS_PER_REQUEST`, priced in
`tests/plan-cost-registry.ts` as `REQUEST_COMMANDS = 1.2`); every plan still
keeps 60% at the sizing reading (Store monthly 60.31%, Studio yearly 60.06%,
Scale yearly 60.07%, `docs/value-presentation-2026-10-18.md`) and Scale still
keeps more than Pro. A private podcast feed, which an app asks for without a
person behind it, keeps counting against the store only (`{ shared: true }`).

**What it does not do.** It does not stop many machines at once (MM-SA-11),
and a connection can pass its share by fewer than ten requests on each server
instance before it is refused.

## MM-SA-02 (Medium): a paid payment request written back as open

**Where.** `lib/payment-request-store.ts`, `lib/payment-requests.ts`.

A request's record was read, changed and written back whole by the reminder
that emails it (`sendRequestEmail`), the press that opens its checkout
(`openRequestCheckout`), the creator's cancel (`cancelRequest`), the daily
reindex (`sendDueReminders`), refunds (`refreshRefunds`) and the buyer's
return from paying (`markPaid`), with nothing between the read and the write.
One that had read the record before the payment and wrote after it — a
reminder still sending its email, a checkout still being opened at Stripe —
put the request back to open: the payer was sent more reminders and offered a
second checkout, and a second payment could be taken. Two answers of the same
payment at once were each "fresh".

**Proof.** `tests/security/payment-request-state.redis-run.ts` holds each
writer at its slow step (the email, Stripe's answer, the record's read) while
the payment is written: on the old code the request went back to open, a
reminder was left waiting, a second checkout opened, a cancel won over the
payment and the same payment was fresh twice (7 checks failed).

**Fix (#564).** Every change goes through `changeRequest`, which re-reads the
record under `nl:payreq:w:<id>` (`withLock`, ten seconds) and writes only what
still applies; a checkout opened for a request that was paid or canceled
meanwhile is expired at Stripe and not handed to the buyer. Four commands more
a change, at most a dozen changes a request, inside the order's
`ORDER_COMPUTE` (`tests/plan-cost-registry.ts`, line orders).

## MM-SA-03 (Medium): an agreement's signature erased by its own email

**Where.** `lib/agreements.ts` (`sendAgain`, `sendAgreementEmail`,
`resendSignedCopy`, `sendSignedCopies`), `lib/agreement-store.ts`.

A signature and a new version were written under the agreement's lock; the
emails about it were not. Each read the agreement, waited for the email and
wrote back what it had read: a person who signed while the creator pressed
"send again" had their signature taken off, and a version written while the
signed copy was being sent again was lost from the record. The lock itself was
deleted by whoever finished, so a second writer could take it while the first
still worked.

**Proof.** `tests/security/agreement-signature.redis-run.ts` signs, and
writes a version, while each email is held: on the old code 3 of 4 checks
failed (the signature gone, the agreement waiting again, the version lost).

**Fix (#565).** Each email's result is written by `changeAgreement`, under the
agreement's lock, onto the record as it is; the lock is taken with
`takeLock` and released only by its holder (`releaseLock`, compare and
delete).

## MM-SA-04 (Medium): pictures read again for every query string

**Where.** `app/api/image/[folder]/[file]`, `app/api/photo/[id]`,
`app/[handle]/app-icon/[size]`.

These are costed as requests the CDN answers (`tests/traffic-cost.ts`): what
is behind each address never changes, so it is kept for a year. The CDN keeps
an answer per address, query string included, so the same picture asked with
`?1`, `?2`, `?3` was read again from the file store (up to a megabyte) or the
database (up to 200 KB) each time, a made-up name was a function and a read
each time, and the icon was drawn again (a photo read and an image scaled) for
every query. No store figure counted any of it.

**Proof.** `tests/security/picture-pace.redis-run.ts`: three hundred requests
from one address for one photo, one product picture and one icon with query
strings, and three hundred made-up names: on the old code 300 photo reads, 300
file-store reads and 300 drawings (5 of 7 checks failed).

**Fix (#566).** An address with a query string is redirected to the plain one
before anything is read (kept for a year); the icon is drawn only at its own
fingerprint (`?v=`) and any other query is redirected there; and every answer
a function gives is paced in memory (`lib/local-limit.ts`,
`lib/picture-pace.ts`): 120 a minute by connection, 30 reads a minute of one
file, per server instance. No store command is added.

## MM-SA-05 (Medium): strangers spending buyers' access emails

**Where.** `lib/store-join.ts`, `lib/waitlist.ts`, `lib/affiliates.ts`
(`requestAffiliateLink`), `lib/email.ts`, `lib/store-allowance.ts`.

A store's access emails (`transactional`: 150 a month on Store, 40 in a trial)
are the links buyers are sent to what they bought: a course, their orders, a
private podcast, the community. The sign-up box, waitlists and the affiliate
form send a confirmation to whatever address a visitor types, from the same
figure, limited only by the hour per connection and per address. From a few
hundred connections (or one machine with many IPv6 addresses) a script spent
the month's figure on made-up addresses, and every buyer who asked for their
link afterward was sent nothing until the month turned.

**Proof.** `tests/security/access-email-reserve.redis-run.ts`: two hundred
sign-ups from two hundred connections on a Store plan, then a buyer's course
link. On the old code the confirmations took all 150 and the buyer's link was
not sent (2 of 3 checks failed).

**Fix (#567).** Those confirmations now stop at `ASKED_SHARE_BPS` (half) of
the figure (`askedCeiling`); the rest is kept for buyers. They are counted in
the same figure by the same two commands, so the figure and its cost are
unchanged. A known affiliate's sign-in link is not capped this way; a new
applicant's is.

## Low findings

### MM-SA-06: the sign-in link's address throttle counts strangers

`lib/auth.ts` limits sign-in links to eight an hour per address, and counts a
stranger's request for somebody's address as one of the eight, as Hazelsong's
SA2-05. BotID runs before it. **Decision: left as it is.** A person kept out
for an hour by somebody else is the lesser harm; the alternative, not limiting
by address, lets the form be used to flood an inbox.

### MM-SA-07: buyers' links in query strings

The download, orders and course links and a private podcast feed carry their
token in the query string, so a token can land in a host's request log, in
the browser's history and on a shared screen. Each is single-purpose, long,
limited in opens and in time, and the site's `Referrer-Policy`
(`strict-origin-when-cross-origin`, `next.config.ts`) sends another site the
origin only, never the path or the query. **Decision: left as it is.** A
podcast app and a mail client can only follow an address; moving the token
after `#` would break both.

### MM-SA-08: pictures outside the storage figure

**Where.** Every picture the studio or a buyer adds is written under the
account's picture folder, `images/<folder>/` (`lib/product-image.ts`,
`imagePath`): a product's (`app/api/store/image/upload`), a link's, a page's
blocks (`app/api/store/page`, `app/api/store/site-page`), a picture made by
the AI writer (`app/api/store/ai`), an email's (`lib/mail-pictures.ts`) and a
review's photo (`lib/review-photo.ts`). The storage figure
(`lib/storage-quota.ts`, `storageUsed`) reads `stores/<folder>/` and the vault
only, so none of these counts in it; one replaced or taken off is deleted, but
one uploaded and never attached, or left in a page that was edited, is never
swept. They go only when the store closes.

**What it can cost.** Each picture door is a studio request (2,000 a month on
Store, 5,000 on Pro, 15,000 on Scale) of at most a megabyte, so a store can add
about 2 GB a month on Store and 15 GB on Scale, and keep all of it month after
month: after a year about $0.55 a month of storage on Store and $4.14 on
Scale, growing for as long as the store pays. A review photo (400 KB) is a
buyer action, an email picture (300 KB) a studio request. **No line of
`tests/plan-cost-registry.ts` prices this**, and under the owner's rule a cost
no figure bounds counts as failing.

**Decision needed from the owner** (it changes what a plan holds, so it is not
made here): (a) count the picture folder inside the plan's storage figure, so
the storage line already priced covers it and a picture door is refused past
the figure, exactly as a file is; or (b) give pictures a figure of their own,
a place taken before each door is given and given back when one is deleted or
a door goes unused for a day, as the community's pictures have
(`lib/community-picture-rules.ts`), with its own line in the registry. The
audit recommends (a): one figure, already priced, and no visible limit
lowered. Until one is chosen, MM-SA-08 stays open in this document.

### MM-SA-09: affiliate lead approvals without a lock (fixed, #569)

**Where.** `decideLeads` and `forgetLeadPerson` in `lib/affiliate-leads.ts`.

A decision read the store's leads, judged them and wrote the chosen ones
back whole; a person's deletion read their lead and wrote it back without the
address. Nothing held either hand off the other, so an approval that had read
a lead before the person's deletion wrote their address back (undoing the
deletion), a deletion that had read a lead before its approval wrote it back
open (the affiliate's approved commission lost), and an approval that had
read a lead before a team member reversed it as fake paid a lead marked not
genuine. The caps and the budget themselves were not passed by a race: they
are judged over every lead in the order confirmed, whatever its state, so two
approvals at once read the same answer.

**Proof.** `tests/security/affiliate-leads-lock.redis-run.ts` holds each slow
hand at its read against a real Redis while the other writes: on the old code
3 of 5 checks failed (the address back, the approval lost, the fake lead
approved).

**Fix (#569).** Both run under `nl:aff:leads:lock:<statsId>` (`withLock`, ten
seconds, waited for up to five) and read again under it. A busy lock answers
the studio `busy` (409, "reload and try again") and makes the erasure report
that part as not done, to be tried again. The lock is its own key family,
expiring by itself and never counted in the data room; its two commands ride
inside the studio request or the erasure that decides, so no cost-table
figure moves.

### MM-SA-10: bodies with no declared length (fixed, #570)

**Where.** `readApiBody` (`lib/api-guard.ts`), `app/api/mcp`,
`app/api/store/community/chat`, `.../community/push`,
`.../community/messages`, `app/api/store/weekly` and
`app/api/operator/search-console`.

`proxy.ts` refuses a body over its ceiling by its declared length, and one
sent chunked with none. A body sent over HTTP/2 needs neither, and these
readers took it whole (`request.text()`, `.json()`, `.formData()`) before
looking at its size: each request then held up to the host's own ceiling,
4.5 MB, in a function's memory and parsed it. The v1 API needs a key, the
weekly switch its link and the Search Console form the operator; the MCP
server and the three community doors are read before anything else is asked,
so anybody could send them.

**Proof.** `tests/security/bounded-bodies.redis-run.ts` sends each of the real
handlers a two-megabyte body with no length and counts what it pulled: on the
old code every one read all of it (5 of 6 checks failed).

**Fix (#570).** Each reads through `limited` (`lib/request-guard.ts`), which
stops at its ceiling whether or not a length was declared: 4,000 bytes for
the v1 API (now counted in bytes, not characters), 16,000 for an MCP message,
8,000 for the chat and push, 32,000 for a private message (its 2,000
characters written out as a form), 2,000 for the weekly switch and 4,000 for
the Search Console form. No store command is added.

## Info

### MM-SA-11: many machines at once

Every per-connection pace here (MM-SA-01's share, MM-SA-04's minute) stops
one machine. Many machines at once still reach a store's own figure, which
bounds what they can cost but not whether a store's buyers are kept waiting.
**Owner's step:** add a rate rule in Vercel → the project → Firewall for
`/api/store/*` and `/api/image/*`, per address, and turn on Attack Challenge
Mode during an attack.

### MM-SA-12: what an agreement's signature shows

To sign, the person types their name and the address the agreement was sent
to (`lib/agreement-store.ts`, `signAgreement`). The agreement's own text
prints that address ("To: name <address>", `agreementText`), so typing it
proves only that the signer holds the link, which is what the emailed link
already proves: the id is 128 random bits, sent only to that address, on a
page that is never indexed and whose views are paced and counted. **Decision:
left as it is.** The link is the proof, as with the e-signature services that
email one; the page and the record say what was recorded and claim nothing
past it (`docs/agreements-esign.md`).

## Second pass, after the first fixes

What changed on `main` after the first pass was read again on 18 Oct 2026:
the agreements and e-signatures of #552 and #558, the three starter funnels
of #555, the published emails of #554, the store copy of #561 and the
prepaid-credits analysis of #563. Besides MM-SA-12, nothing was found:

- **Agreements.** The id is 128 random bits; a page view and a signature are
  paced per connection and counted in the store's window; a browser signed in
  to the store's studio cannot sign; a signature lands only on the latest,
  unsigned version whose fingerprint the page showed, under the agreement's
  lock; every email is one of the store's own for the month, its headers
  cleaned, its subject cut; the signed copy's HTML is escaped and loads
  nothing. Creating, revising and sending need the role that may email for
  the store, and each send is bounded (eight an agreement, a day apart).
- **Published emails.** Only an email this store sent can be published, by a
  role that may email for it; the page draws it with `bodyHtml`, every word
  escaped and only https links, and each view is one of the store's counted
  requests.
- **The store copy.** Only the account's owner copies, from one of its stores
  into another of the same address (`ownTarget`); every step is charged to the
  other store's studio requests before it reads or writes, takes its room in
  that store's data room first, runs under that store's lock, and writes only
  ids worked out from the copy's own, so a retry adds nothing. Products come
  across hidden, without files, pictures, keys, calls, courses or podcasts;
  nothing of customers, orders, payments or the team comes across.
- **Funnels and credits.** #555 adds static starter text, #563 an analysis:
  neither adds a route or a write.

## What was checked and held

- **Lua and empty lists.** No script in `lib/` or `app/` calls
  `cjson.encode`; every script that keeps JSON decodes it only (Hazelsong's
  HZ-03 class does not occur).
- **Platform billing.** The checkout session is made on the server for the
  signed-in owner, with `metadata[store]`, and read back from Stripe on return
  (`lib/billing.ts`, `readStartedSubscription`); nothing a browser sends binds
  a payment.
- **Buyers' downloads.** The Stripe session is read on the creator's own
  account, and only products that session sold are handed out
  (`saleHandles`). PayPal: the captured order must be the one opened for the
  store (`lib/paypal-sales.ts`, `matches`).
- **Webhooks.** Stripe, Svix (Resend), SNS (its host checked), Bunny, Zoom and
  Meta are verified before anything is read; cron routes compare their secret
  in constant time (`cronAllowed`).
- **Outbound requests.** `lib/safe-fetch.ts` resolves the name, pins the
  address and refuses private, loopback, link-local, mapped, NAT64, 6to4,
  Teredo and `::7f00:1` addresses; Slack and Discord addresses must match their
  services' shapes.
- **Custom domains.** A domain is taken only with a TXT record proving
  control (`lib/domain-proof.ts`).
- **Email.** Header values are cleaned of line breaks (`headerText`,
  `oneAddress`); a creator's HTML is escaped, links are https only and pictures
  only our own `/api/image`.
- **Pages a creator writes.** The only `dangerouslySetInnerHTML` are the
  letters page (escaped HTML), the mail designer's preview and JSON-LD; the
  content policy uses a nonce with `strict-dynamic`.
- **CSRF.** Every changing `/api/` request from another site is refused in
  `proxy.ts`, except the one-click unsubscribe.
- **Open redirects.** The click tracker is a POST that redirects nowhere.
- **API keys.** Stored as hashes, limited per minute and counted in the API
  figure; the MCP server uses the same door (`lib/api-guard.ts`).
- **Uploads.** Every upload door names its content types and size;
  a paid file's door reserves storage before it is issued
  (`lib/upload-budget.ts`, `lib/storage-reservations.ts`).
- **The store assistant.** Its pool is reserved before each model call; its
  prompt-injection checks are covered by `tests/store-assistant.test.ts`.
- **Dependencies.** `npm audit --omit=dev`: 0 vulnerabilities on 18 Oct 2026.
  With dev dependencies, `braces` and `micromatch` through
  `eslint-config-next`, which run only when lint reads the repository's own
  source.

## Owner's steps

1. Add the Firewall rate rule in MM-SA-11.
2. Decide MM-SA-08: count the picture folder in the plan's storage figure (the
   audit's recommendation), or give pictures a figure and a registry line of
   their own.
