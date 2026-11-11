# Marktmorgen for Zapier

A Zapier integration so a creator can join their Marktmorgen store to the
thousands of apps Zapier reaches, without a line of code. It is built, tested
and ready; it is **not submitted to Zapier and not published**, and it must not
be until sales are open (see "Before it is published").

## What it does

Everything rests on the public API (`/developers`, `app/api/v1`), with the
creator's own API key. Nothing here can read or send anything that key could
not already.

- **Triggers** (each an instant one: a webhook endpoint subscribed through
  `POST /api/v1/hooks` when the Zap is turned on, removed through
  `DELETE /api/v1/hooks` when it is turned off). The examples Zapier shows
  while a Zap is set up come from `GET /api/v1/events`, which returns only
  messages the store's webhooks already sent.
  - New Sale (`sale.completed`)
  - New Refund (`refund.issued`)
  - New Lead (`lead.captured`)
  - New Subscriber (`list.joined`)
  - New Membership (`membership.started`)
  - Membership Canceled (`membership.canceled`)
  - New Booking (`call.booked`)
  - Booking Moved (`call.moved`)
- **Actions** (the API's own writes; each needs a key that may write):
  - Add Subscriber to List (`POST /api/v1/leads`) — requires the creator to
    confirm the person agreed; the API refuses anyone without it and never
    adds back someone who unsubscribed.
  - Add or Remove Labels (`POST /api/v1/leads/labels`)
  - Give Product Access (`POST /api/v1/access`), its product field filled from
    `GET /api/v1/products`.

The five endpoints a store may have (`MAX_ENDPOINTS`) count those a Zap adds,
so a creator cannot run past the store's own limit from Zapier. Every endpoint
a Zap adds is reported to the creator's inbox, exactly as one added in the
studio is.

### What reaches a Zap

A trigger passes a message on only when it is one the store's webhooks sent
for this Zap. The signing secret `POST /api/v1/hooks` returns is kept as the
Zap's subscribeData (a subscription answered without one is not kept), and
every message is checked against it as `lib/webhooks.ts` signs it: one `v1`
of `Marktmorgen-Signature` must be the HMAC-SHA256 of `"<t>.<raw body>"`,
compared in constant time (Web Crypto, so the file still needs no `require`),
and `t` must be within 5 minutes of now (`SIGNATURE_TOLERANCE_SECONDS`; the
server sets no number of its own and signs at each try, so a retry is fresh).
For the day a replaced secret still signs, a Zap holding either one passes.
Anything else (no header, another secret, a changed body or time, an old
message, no raw body to check) halts the run with `HaltedError`: it shows in
the Zap's history and never turns the Zap off, so a forger cannot switch it
off by posting to its URL. A creator who makes a new secret for an endpoint a
Zap added must turn that Zap off and on again within the day, or its messages
stop passing. Tested by `tests/zapier-hook-signature.test.ts`.

Repeats are **not** ignored. The same event can arrive twice (its id never
changes), and Zapier does not drop repeats of an instant trigger. Ignoring
them needs the ids already passed on remembered between runs, which is
storage this app does not have (nothing is kept between runs of `perform`);
it is left out until that storage is decided.

## The code

- `zapier/index.js` — the whole app, one CommonJS file with no imports, so the
  site's own checks read and test it without Zapier's packages installed.
- `zapier/package.json` — pins `zapier-platform-core`; its version is kept
  equal to `platformVersion` in `index.js` by `tests/zapier-app.test.ts`.
- `tests/zapier-app.test.ts` — runs the triggers and actions as Zapier would,
  against the real API routes and the in-memory store.
- API added for it: `app/api/v1/hooks` (subscribe/unsubscribe a webhook) and
  `app/api/v1/events` (recent messages of one event), plus `recentMessages` in
  `lib/webhooks.ts`.

Nothing in `zapier/` is part of the Next build: it is imported only by the
test. To work on the app with Zapier's own tooling:

```
cd zapier
npm install
npx zapier validate
npx zapier test
```

## Cost and the 60% floor

No new cost line. Every call a Zap makes counts as the store's own API
requests of its plan (`API_RATE`, `takeAllowance`), which
`tests/spend-floor.test.ts` already holds to the floor: one for a call that
reads only the store, and more for a read that reads more than one request's
worth (`lib/api-read-rules.ts`). The samples of events shown while a Zap is
set up (`GET /api/v1/events`) read the newest deliveries. The measuring is
set aside before it is done (`EVENTS_PROBE_MOST`); each delivery is then
measured, set aside at its size with the room its tries may still write on it
(`deliveryReadBound`), read only up to that, and the whole settled at what was
read and sent,
so each counts as 2 to 14 (`1 + apiReadUnits(eventsWork())` at the most, for
messages made since 4 November 2026, bounded by `DELIVERY_MAX_BYTES`; while one kept from before is larger than that, the
sample is not read and says it could not be read just now). The webhook endpoints a Zap adds use the store's own webhook deliveries, already counted and bounded.

## Before it is published (do not skip)

Zapier publishes a public integration only when the product is fully launched,
not in beta or invite-only
(https://docs.zapier.com/platform/publish/integration-publishing-requirements).
Marktmorgen's paid plans are not on sale (`PLANS_ON_SALE` is false), so the app
stays **private and unsubmitted** until they are. When sales open, to submit:

1. A test account that does not expire, with every paid feature on, under the
   email `integration-testing@zapier.com`. Marktmorgen signs in by a link to an
   email address (no password), which Zapier's rules allow; give the reviewer
   the address and say so.
2. A test Zap for **every** trigger and action, each turned on with at least
   one successful run in its Zap history; do not delete them.
3. All endpoints on HTTPS and production (they are: `marktmorgen.com`).
4. Current API documentation linked (`/developers`).
5. At least one admin of the integration with an address on the product's
   domain — add `support@marktmorgen.com` to the integration's team.
6. All user-facing text in American English (it is).

The integration goes on the same Zapier account that already holds the
Hazelsong integration. Do not create a second account, and do not submit for
review without the owner's word.
