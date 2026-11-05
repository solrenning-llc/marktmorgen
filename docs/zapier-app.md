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
set up (`GET /api/v1/events`) read the newest deliveries at their most, so each
counts as 5 (`1 + apiReadUnits(eventsWork())`), taken before it reads. The webhook endpoints a
Zap adds use the store's own webhook deliveries, already counted and bounded.

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
