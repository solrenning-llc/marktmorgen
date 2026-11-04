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
| MM-SA-14 | Medium | A locked session (two-step reset, or the recovery address) could erase buyers for good and remove the owner's passkeys | In progress: `claude4/sg1-locked-session` (reproduced) |
| MM-SA-15 | Medium | "Require two-step for the team" checks that a member has a second factor, not that this session used it: a member with only a passkey signs in by the email link alone | With Claude 3, 612 [WP11] owns `lib/team.ts` (reproduced) |
| MM-SA-16 | Medium | The public erasure-request form sends access emails without the MM-SA-05 ceiling: strangers can spend the month's access emails and buyers get no link | In progress: `claude4/sg1-locked-session` (reproduced) |
| MM-SA-17 | Medium | The certificate PDF is built on every GET with no public-request window, no pacing and no shared cache (about 81 ms of CPU and 107 KB each) | With Claude 3, who holds the route (measured) |
| MM-SA-18 | Medium | A lost chargeback does not close the buyer's access: courses, community, downloads, private feeds and license keys stay open | Decision with Claude 1 (refunds); proposed: close on `dispute.status = lost` (reproduced) |
| MM-SA-19 | Low | The reset path's notices go only to the sign-in inbox the path assumes someone else holds; the confirmed recovery address hears nothing | In progress: `claude4/sg1-locked-session` (reproduced) |
| MM-SA-20 | Low | Accepting a team invite opens a full fresh session without the code for an account with an authenticator and no store or team | In progress: `claude4/sg1-locked-session` (read) |
| MM-SA-21 | Low | `/signin/lost` answers later when the address has a recovery address: the timing tells which addresses have accounts | With Codex, who holds the route (read) |
| MM-SA-22 | Low | API keys, webhook endpoints and calendar feeds an Admin created survive the Admin's removal from the team | With Claude 3 (`lib/team.ts`) (read) |
| MM-SA-23 | Low | The stock lock (15 s) is shorter than the Stripe calls it guards and is released without checking its owner: two buyers can get a checkout for the last unit | With Claude 2, 513 [PF1] (reproduced) |
| MM-SA-24 | Low | Each request of a funded store would send a ~7.9 KB `EVAL` without `EVALSHA`, not counted in the cost registry; dormant while no store is funded | With Codex (costs) (read) |
| MM-SA-25 | Low | The Stripe session id and the PayPal order id are sent to the creator's ad pixels as event and order ids, and in the full page address; whoever reads the ad account's events can use the order for 3 days | With Claude 2 (thanks page) and Claude 3 (pixels) (read) |
| MM-SA-26 | Info | The file download route had no words for three refusals (`used`, `locked`, `two_step`), so they became server errors | Fixed in this PR (test fails before) |
| MM-SA-27 | Info | The video watch-depth listener accepts any origin that looks like YouTube or Vimeo (`evilvimeo.com`); it adds nothing the public beacon does not already allow | Listed |
| MM-SA-28 | Info | `safeFetch` forwards the caller's headers when a GET is redirected to another host; no caller sends a secret on a redirecting GET today | Listed: rule below |
| MM-SA-29 | Info | A sold file over 20 MB kept in Vercel Blob is not forced to download (`saveAs` ignored), on another origin without our cookies; the door is closed in production | Listed |
| MM-SA-30 | Info | A draft product's title and price are visible to whoever knows its 40-bit id (sample certificate, cart GET, preview lessons) | Listed |

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
