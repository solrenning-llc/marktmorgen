import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, LegalSection } from "@/components/legal-page";
import { API_PAGE } from "@/lib/api-read";
import { API_RATE } from "@/lib/api-guard";
import { FIELD_NAME_MAX, MAX_FIELDS_ASKED } from "@/lib/api-fields";
import { DELIVERY_WRITE_MAX_BYTES, MESSAGE_TEXT_MAX } from "@/lib/webhook-limits";
import { MAX_KEYS } from "@/lib/api-key-rules";
import { ADDS_PER_DAY, GIVES_PER_DAY } from "@/lib/api-write";
import { API_SALES_UNITS, API_WRITE_UNITS, NON_PAYING_ALLOWANCES, STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { SALE_TEXT_LIMITS, SALES_PAGE, SALES_TITLE_IDS } from "@/lib/api-sales";
import { PLAN_TITLES } from "@/lib/plan";
import {
  BLOCKED_READ_MAX, BOOKINGS_READ, MEMBERSHIPS_COLD_WORK, MEMBERSHIP_NUMBERS_BYTES, NUMBERS_KEEP_WORK, NUMBERS_KEPT_BYTES, NUMBERS_SENT_BYTES, addWork, apiReadUnits, bookWork,
  bookingsWork, codeMakeWork, codeStopWork, codesWork, eventsWork, keptNumbersWork, listPageMost, membershipsWork, numbersWork, productsPageWork, scannedPageWork, studentsPageWork,
} from "@/lib/api-read-rules";
import { BOOK_STRIPE_PAGES } from "@/lib/affiliates";

/** What each reading that reads more than a page counts as, from the code that takes it (lib/api-read-rules.ts). */
const STUDENTS_PAGE_COUNTS = 1 + apiReadUnits(studentsPageWork(API_PAGE, 1));
const STUDENTS_PAGE_COUNTS_MOST = 1 + apiReadUnits(studentsPageWork(API_PAGE, BLOCKED_READ_MAX + 1));
const BOOKINGS_COUNT = 1 + apiReadUnits(bookingsWork(true));
const BOOK_EXAMPLE = { affiliates: 100, sales: 1_000 };
const AFFILIATES_COUNT_LEAST = 1 + apiReadUnits(bookWork({ kept: true, entries: 0, people: 0, leads: 0, paypalRefunds: 0, stripe: false, products: 0 }, BOOK_STRIPE_PAGES));
const AFFILIATES_COUNT_EXAMPLE =
  1 + apiReadUnits(bookWork({ kept: true, entries: 2 * BOOK_EXAMPLE.affiliates + BOOK_EXAMPLE.sales, people: BOOK_EXAMPLE.affiliates, leads: 0, paypalRefunds: 0, stripe: true, products: 10 }, BOOK_STRIPE_PAGES));
const PRODUCTS_PAGE_MOST = 1 + apiReadUnits(productsPageWork(API_PAGE, API_PAGE));
const ROWS_EXAMPLE = { rows: API_PAGE, kb: 2 };
const LIST_PAGE_EXAMPLE = 1 + apiReadUnits(scannedPageWork(1, ROWS_EXAMPLE.rows * ROWS_EXAMPLE.kb * 1_000, ROWS_EXAMPLE.rows * ROWS_EXAMPLE.kb * 1_000));
/** A page of any size: its scan and its take, settled at one more than the door's. */
const LIST_PAGE_LEAST = 1 + apiReadUnits(scannedPageWork(1, 1, 1));
const LIST_PAGE_HELD = 1 + apiReadUnits(listPageMost("leads", API_PAGE));
const MEMBERS_PAGE_HELD = 1 + apiReadUnits(listPageMost("members", API_PAGE));
const NUMBERS_COUNT = 1 + apiReadUnits(addWork(numbersWork({ kept: true, sales: true, stripe: true, paypalSales: 0, paypalRefunds: 0 }), NUMBERS_KEEP_WORK));
const NUMBERS_COUNT_NO_SALES = 1 + apiReadUnits(addWork(numbersWork({ kept: true, sales: false, stripe: false, paypalSales: 0, paypalRefunds: 0 }), NUMBERS_KEEP_WORK));
/** Numbers read from the copy kept an hour: as few as this, and at most this for the largest copy and answer. */
const NUMBERS_KEPT_LEAST = 1 + apiReadUnits(keptNumbersWork(1, 1));
const NUMBERS_KEPT_MOST = 1 + apiReadUnits(keptNumbersWork(NUMBERS_KEPT_BYTES, NUMBERS_SENT_BYTES));
const CODES_COUNT = 1 + apiReadUnits(codesWork());
const CODE_MAKE_COUNT = 1 + apiReadUnits(codeMakeWork());
const CODE_STOP_COUNT = 1 + apiReadUnits(codeStopWork());
/** The recent events, measured first: an empty log, and the most, LOG_SIZE deliveries at the most each is kept at. */
const EVENTS_LEAST = 1 + apiReadUnits(eventsWork({ deliveries: 0, bytes: 0, sent: 0 }));
const EVENTS_MOST_COUNT = 1 + apiReadUnits(eventsWork());
const MEMBERSHIPS_COUNT = 1 + apiReadUnits(membershipsWork(MEMBERSHIP_NUMBERS_BYTES));
const MEMBERSHIPS_COUNT_COLD = 1 + apiReadUnits(addWork(membershipsWork(0), MEMBERSHIPS_COLD_WORK));
const n = (count: number) => count.toLocaleString("en-US");

export const metadata: Metadata = {
  title: "Developers — Marktmorgen",
  description:
    "The Marktmorgen API: read your list, members, course students, affiliates, bookings and numbers from your own tools, and add people to your list, label them and give them products, with keys you make in your studio. On every plan.",
};

/**
 * Every address the API answers, and exactly what it returns.
 *
 * Nothing on this page is written ahead of the code. Each section is one
 * route under app/api/v1, and each example response is the shape
 * lib/api-read.ts builds, field for field — a field that is not here is not
 * sent. When an address is added, it is added here in the same change.
 */
function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-[12px] bg-[#15112e] p-4 text-[0.8125rem] leading-relaxed text-[#ece9ff]">
      <code>{children}</code>
    </pre>
  );
}

function Endpoint({ path, method = "GET", children }: { path: string; method?: "GET" | "POST" | "DELETE"; children: React.ReactNode }) {
  return (
    <p>
      <code className="rounded-md bg-lilac px-2 py-1 font-mono text-[0.875rem] font-semibold text-violet-ink">{`${method} ${path}`}</code>{" "}
      {children}
    </p>
  );
}

const BASE = "https://marktmorgen.com/api/v1";

export default function DevelopersPage() {
  return (
    <LegalPage title="Developers" eyebrow="For your own tools" effective={null} legalNav={false} lastUpdated="November 2, 2026">
      <p>
        Read your store from your own tools: your list, your community&apos;s members, a course&apos;s students, your
        affiliates and your bookings; and, with a key made to write, add people to your list, label them, and give or
        take back products. Every plan has it. To be told when something happens instead, use{" "}
        <Link href="/help#can-i-connect-zapier-make-or-my-own-server" className="text-black underline underline-offset-2 hover:no-underline">
          webhooks
        </Link>
        .
      </p>

      <LegalSection title="Keys">
        <p>
          {`Make a key in your studio, under API keys. It is shown once, when you make it, and never again: we keep only a fingerprint of it. A store can have ${MAX_KEYS} keys; each shows when it was last used, and revoking one refuses the very next request made with it. Deleting a store revokes all of its keys and removes its webhook endpoints with it.`}
        </p>
        <p>
          A key reads, and changes nothing, unless you check &quot;It can also write&quot; when you make it. That choice is
          the key&apos;s for good: a key made to read stays one that reads, and every key made before writing existed
          reads only. A key that reads only gets 403 <code className="font-mono">read_only</code> from the addresses that
          write. Only the store&apos;s owner and Admins can make a key that writes.
        </p>
        <p>Send it on every request:</p>
        <Code>{`curl ${BASE}/store \\
  -H "Authorization: Bearer nl_live_…"`}</Code>
        <p>
          A key belongs to one store and reads only that store. Keep it on a server, in Zapier or in Make — never in a web
          page, where anybody who opens the page could copy it. The API sends no CORS headers, so a browser refuses to
          use one.
        </p>
      </LegalSection>

      <LegalSection title="Answers, pages and limits">
        <p>
          Every answer is JSON. A list comes as <code className="font-mono">data</code>, and a long list comes a page at a
          time with <code className="font-mono">next</code>: send it back as <code className="font-mono">?cursor=</code> for
          the next page, until it is <code className="font-mono">null</code>.
          {` A page holds about ${API_PAGE} rows. Products never has more; your list, your members and a course's students can have a few more on a page, and a page can come back empty before the last one, so keep asking until next is null. Times are ISO 8601, in UTC. Amounts are in the currency's smallest unit — cents for dollars.`}
        </p>
        <p>
          To get only some fields of each row, add <code className="font-mono">?fields=</code> with their names,
          separated by commas, for example <code className="font-mono">/api/v1/leads?fields=email,agreed</code>. The paging
          fields beside <code className="font-mono">data</code> always stay. A field no row has is answered 400{" "}
          <code className="font-mono">unknown_field</code>, with its name, and a name that cannot be a field (a field name is
          lowercase letters, digits and underscores, starting with a letter, up to {FIELD_NAME_MAX} characters) or more than{" "}
          {MAX_FIELDS_ASKED} names is answered 400 <code className="font-mono">fields</code>. Both are
          answered before anything is read, so they count as one request. This works on every list above, on
          Store, on Bookings, on Discount codes and on Sales.
        </p>
        <p>
          {`Each key may make ${API_RATE} requests a minute. Past that, the answer is 429 with `}
          <code className="whitespace-nowrap font-mono">Retry-After: 60</code>.
        </p>
        <p>
          {`A store's keys together also have a figure for each billing month (the month that starts on the day the store's plan renews): ${STORE_ALLOWANCES.creator.api.toLocaleString("en-US")} requests on ${PLAN_TITLES.creator}, ${STORE_ALLOWANCES.pro.api.toLocaleString("en-US")} on ${PLAN_TITLES.pro} and ${STORE_ALLOWANCES.scale.api.toLocaleString("en-US")} on ${PLAN_TITLES.scale}. A free trial has ${NON_PAYING_ALLOWANCES.trial.api.toLocaleString("en-US")} for the whole trial, and a store without a paid plan has none. A contact added or a product given counts as ${API_WRITE_UNITS}, and a page of sales as ${API_SALES_UNITS}, and more when it names products that are read for their titles. Every read except Store counts as more than one when it reads more than one request's worth: a page of products, of your list or of your members, a course's students, your numbers, your discount codes, your affiliates, your bookings and the recent events (/api/v1/events, the examples a tool such as Zapier shows while you set up a step: from ${n(EVENTS_LEAST)} to ${n(EVENTS_MOST_COUNT)} each, by the size of the deliveries it reads, measured before they are read; a webhook message takes at most ${DELIVERY_WRITE_MAX_BYTES / 1024} KB to keep, each text in it at most ${MESSAGE_TEXT_MAX} characters, so ${n(EVENTS_MOST_COUNT)} is the most for messages made since November 4, 2026, and one kept from before counts at its size), as said with each below; what it will take is taken before it reads. A read whose size is known only once it is read (a page of your list or your members, your numbers from their copy) sets aside the most it may take first, and gives back at once what it did not need. Past the figure, or when a read needs more than are left, the answer is 429 `}
          <code className="font-mono">monthly_limit</code>
          {", and its message says when the figure opens again, if it does. A trial or a store without a paid plan also needs one of the month's places for such stores; without one, the answer is 429 "}
          <code className="font-mono">no_place</code>
          {". Nothing is billed for requests. A write that does not fit the store's data room (its words and records, by plan) is answered 409 "}
          <code className="font-mono">store_full</code>
          {", and nothing is written."}
        </p>
        <Code>{`401  {"error": "unauthorized", "message": "Send your API key as: Authorization: Bearer nl_live_…"}
429  {"error": "rate_limited", "message": "At most ${API_RATE} requests a minute per key. Try again in a minute."}
429  {"error": "monthly_limit", "message": "Your store's API requests for this month are used: 2,000 API requests. This opens again with your next billing month, on …"}
429  {"error": "monthly_limit", "message": "This read takes ${n(BOOKINGS_COUNT)} of your store's API requests, more than your store has left, so nothing was read."}
429  {"error": "monthly_limit", "message": "This read may take up to ${n(LIST_PAGE_HELD)} of your store's API requests, more than your store has left, so nothing was read."}
400  {"error": "unknown_field", "message": "No item in this answer has a field named “nothing_here”."}
400  {"error": "fields", "message": "“bad-name” cannot be a field name. Use letters, digits and underscores, at most 30 fields."}
429  {"error": "no_place", "message": "Stores without a paid plan are full for this month, so this can't run right now. …"}
409  {"error": "store_full", "message": "Your store's data room is full, so nothing was added. …"}
403  {"error": "key_paused", "message": "This key is paused: the store's team now logs in with a second step, and the key was made without one. …"}
409  {"error": "paused_unpaid", "message": "Nothing was read: your plan's renewal payment did not go through, …"}
409  {"error": "paused_unpaid", "message": "Nothing was changed: your plan's renewal payment did not go through, …"}
502  {"error": "unavailable", "message": "… could not be read just now. Try again in a moment."}`}</Code>
        <p>A missing, mistyped and revoked key all get the same 401.</p>
        <p>
          A key made by a team member who logged in without a second step is paused when the store&apos;s owner starts
          asking the team for one. Every request with it is answered 403 <code className="font-mono">key_paused</code>{" "}
          until whoever made it logs in with a passkey or an authenticator app&apos;s code and turns it back on under API
          keys in the studio. A key made by someone who then leaves the team is paused too, and can only be revoked;
          one made by someone whose role no longer allows it waits for the store&apos;s owner to turn it back on.
          A paused key is never deleted. The webhook endpoints a key added are sent nothing while it is paused, start
          again when it is turned back on, and stop for good when it is revoked.
        </p>
        <p>
          {"While the store's plan renewal is unpaid, reads answer 409 "}
          <code className="font-mono">paused_unpaid</code>
          {" (or "}
          <code className="font-mono">paused_disputed</code>
          {" while a payment for the plan is disputed, and for the period that payment covered if the dispute is decided for the store, while the plan runs), before the request counts toward the month. Adding a lead, adding labels, giving a product and adding a webhook endpoint get the same 409, also before they count; its message starts \"Nothing was changed\". Removing labels, taking back access and removing a webhook endpoint are not paused: they still work and count as API requests as usual."}
        </p>
      </LegalSection>

      <LegalSection title="Store">
        <Endpoint path="/api/v1/store">Which store the key reads. The first call to make, to check a key works.</Endpoint>
        <Code>{`{
  "data": { "handle": "harbor", "name": "Harbor Kitchen", "currency": "usd" }
}`}</Code>
      </LegalSection>

      <LegalSection title="Products">
        <Endpoint path="/api/v1/products">Every product, in the order your store shows them, drafts included.</Endpoint>
        <p>{`A full page counts as up to ${n(PRODUCTS_PAGE_MOST)} of your API requests, by how many of its products have to be read; a smaller page counts as fewer.`}</p>
        <Code>{`{
  "data": [
    {
      "id": "k3j9x2p1ab",
      "title": "The 7-Day Reset",
      "price": 700,
      "currency": "usd",
      "kind": "one_time",
      "interval": null,
      "hidden": false,
      "url": "https://marktmorgen.com/@harbor/p/k3j9x2p1ab"
    }
  ],
  "next": null
}`}</Code>
        <p>
          <code className="font-mono">kind</code> is one of <code className="font-mono">one_time</code>,{" "}
          <code className="font-mono">free</code>, <code className="font-mono">membership</code>,{" "}
          <code className="font-mono">course</code> or <code className="font-mono">call</code>.{" "}
          <code className="font-mono">interval</code> is set for a membership.
        </p>
      </LegalSection>

      <LegalSection title="Leads">
        <Endpoint path="/api/v1/leads">
          Your list: everybody who asked for something free, bought, or came in with an import — the same rows as the
          CSV export in your studio. Add <code className="font-mono">?agreed=true</code> for only those who agreed to hear
          from you and have not unsubscribed: the ones it is fair to email.
        </Endpoint>
        <p>{`A page counts as at least ${n(LIST_PAGE_LEAST)} of your API requests (one while your store has no list yet), and more when its rows are long, by the bytes it reads and sends: for example, ${n(LIST_PAGE_EXAMPLE)} for ${n(ROWS_EXAMPLE.rows)} rows of about ${ROWS_EXAMPLE.kb} KB each. A page needs ${n(LIST_PAGE_HELD)} requests free before it is read, what a full page of the longest rows could take; what it did not use is given back at once. With fewer free, the page is refused and nothing is read. Members count the same way: a page of members needs ${n(MEMBERS_PAGE_HELD)} free before it is read.`}</p>
        <Code>{`{
  "data": [
    {
      "email": "dana@example.com",
      "name": null,
      "agreed": true,
      "agreed_at": "2026-09-12T14:03:22.000Z",
      "unsubscribed": false,
      "unsubscribed_at": null,
      "first_at": "2026-09-12T14:03:22.000Z",
      "last_at": "2026-09-20T09:41:10.000Z",
      "products": ["Free Pantry Guide", "The 7-Day Reset"],
      "product_ids": ["p8w2m4q9zz", "k3j9x2p1ab"],
      "tags": [],
      "source": "free"
    }
  ],
  "next": "1840"
}`}</Code>
      </LegalSection>

      <LegalSection title="Members">
        <Endpoint path="/api/v1/members">
          Everybody who has come into your community, as your own member list shows them. 404 with{" "}
          <code className="font-mono">no_community</code> when the store has none.
        </Endpoint>
        <Code>{`{
  "data": [
    {
      "email": "dana@example.com",
      "name": "Dana Ortiz",
      "handle": "danaortiz",
      "listed": true,
      "announcements": true,
      "muted": false,
      "removed": false,
      "joined_at": "2026-09-14T18:22:05.000Z",
      "last_seen_at": "2026-09-29T21:10:44.000Z"
    }
  ],
  "next": null
}`}</Code>
      </LegalSection>

      <LegalSection title="Students">
        <Endpoint path="/api/v1/students?product=<id>">
          Everybody who has opened one course, with how far they got, a page at a time, in no set order.{" "}
          <code className="font-mono">product</code> is the course product&apos;s id, from Products, and{" "}
          <code className="font-mono">total</code> is how many students the course has in all.
        </Endpoint>
        <p>
          {`Changed on November 4, 2026: students now come a page at a time, about ${n(API_PAGE)} a page in no set order, and no longer as the 500 most recently active. If the course changes while you page through it, a student can show up twice, or a page can come back empty before the last one, so the rows you add up may not match total.`}
        </p>
        <p>
          {`Each page reads every student's progress, so a full page of ${n(API_PAGE)} counts as ${n(STUDENTS_PAGE_COUNTS)} of your API requests (${n(STUDENTS_PAGE_COUNTS_MOST)} when more than ${n(BLOCKED_READ_MAX)} students of the course are blocked). A smaller page counts as fewer.`}
        </p>
        <Code>{`{
  "total": 1,
  "data": [
    {
      "email": "dana@example.com",
      "lessons_done": 7,
      "lessons_total": 12,
      "started_at": "2026-09-15T10:00:00.000Z",
      "last_seen_at": "2026-09-29T08:15:31.000Z",
      "blocked": false
    }
  ],
  "next": null
}`}</Code>
      </LegalSection>

      <LegalSection title="Numbers">
        <Endpoint path="/api/v1/stats">
          Your numbers for the last 7, 30 and 90 days, the same ones your studio shows: visitors, checkouts, sales and
          revenue, each channel from visit to sale, and page views by country and by device.
        </Endpoint>
        <p>{`Read anew, it reads 180 days of counts and, with your Stripe account connected, every page of your sales, renewals, refunds and disputes it may need, so it counts as ${n(NUMBERS_COUNT)} of your API requests (${n(NUMBERS_COUNT_NO_SALES)} for a store with no sales to read), and more when you have PayPal sales or refunds. A copy of the numbers is then kept for an hour: within that hour, a read comes from the copy and counts only for reading it and its answer, as few as ${n(NUMBERS_KEPT_LEAST)} and at most ${n(NUMBERS_KEPT_MOST)}. `}<code className="font-mono">asOf</code>{" says when the numbers were read, in ISO 8601 (UTC), so a number up to an hour old is never taken for one of this minute."}</p>
        <Code>{`{
  "data": {
    "currency": "usd",
    "sales": "ok",
    "days": {
      "last_7_days": {
        "visitors": 412,
        "page_views": 655,
        "checkouts": 31,
        "sales": 9,
        "revenue": 26100,
        "channels": [
          { "channel": "instagram", "visits": 240, "checkouts": 19, "signups": 4, "sales": 6, "revenue": 17400 }
        ],
        "countries": [{ "country": "US", "views": 388 }],
        "devices": [{ "device": "mobile", "views": 521 }],
        "previous": { "available": true, "visitors": 335, "page_views": 540, "checkouts": 24, "sales": 7, "revenue": 20300 },
        "refunded": 2900,
        "refunds_complete": true,
        "payments": { "complete": true, "gross_receipts": 31100, "after_refunds": 28200 },
        "renewals": { "complete": true, "count": 2, "revenue": 5000 },
        "payment_channels": {
          "complete": true, "from": "2026-10-08", "to": "2026-10-14",
          "rows": [{ "channel": "instagram", "gross_receipts": 31100, "share": 1, "identified": true }]
        },
        "sales_by_country": [{ "country": "US", "sales": 5, "revenue": 14500 }],
        "ads": [{ "ad": "reel-b", "channel": "instagram", "campaign": "launch", "sales": 3, "revenue": 8700 }]
      },
      "last_30_days": { "...": "the same fields" },
      "last_90_days": { "...": "the same fields" }
    }
  },
  "asOf": "2026-10-14T16:05:12.000Z"
}`}</Code>
        <p>
          Money is in the smallest unit of your store&apos;s currency, before Stripe&apos;s fee. <code className="font-mono">sales</code>{" "}
          and <code className="font-mono">revenue</code> are <code className="font-mono">null</code> when Stripe could not be read
          (<code className="font-mono">&quot;sales&quot;: &quot;error&quot;</code>) or is not connected yet (<code className="font-mono">&quot;none&quot;</code>).
          A <code className="font-mono">channel</code> of <code className="font-mono">direct</code> is a visit or sale from nowhere
          the store could name. <code className="font-mono">previous</code> is the same number of days just before, to compare
          with; its <code className="font-mono">sales</code> and <code className="font-mono">revenue</code> are{" "}
          <code className="font-mono">null</code> when Stripe could not be read that far back in full.
        </p>
        <p>
          Each period also includes <code className="font-mono">payments</code> and <code className="font-mono">renewals</code>.
          Gross receipts include initial purchases and renewals. The amount after refunds subtracts refunds recorded
          in the same period, including refunds of older purchases, before fees and ad spend; it is not profit.
          Each group has its own completeness flag. Unavailable values are null, while confirmed empty readings are zero.
          Complete gross receipts remain available when only refunds are unavailable. Initial sales and revenue also
          remain null when the purchase reading is incomplete, even if the provider answered successfully.
        </p>
        <p>
          <code className="font-mono">payment_channels</code> lists every channel with positive gross receipts,
          including renewals, in the stated UTC dates. Each share is a fraction of all recorded receipts (0 to 1).
          Direct, unrecorded and imported origins have <code className="font-mono">identified: false</code> and remain
          in the denominator. The list is not capped. An empty list with complete true means no receipts; complete
          false means the reading is unavailable. Refund availability does not block confirmed receipt channels.
        </p>
        <p>
          <code className="font-mono">payment_comparison</code> compares gross receipts with the immediately preceding
          period of equal length for 7 and 30 days, including channels present in only one period. It provides the
          earlier UTC dates and total, changes in money, fractional growth and changes in channel share. Multiply
          share changes by 100 for percentage points. Growth is null when the earlier amount is zero. Comparison
          is unavailable for 90 days or when either period cannot be read completely; complete is false and rows
          are empty, while confirmed current receipts may remain available.
        </p>
        <p>
          <code className="font-mono">refund_activity</code> provides refund records and amounts by channel for
          the stated UTC dates. Its share compares refunded money with gross receipts in the same period,
          including renewals. It is not the fraction of buyers or purchases refunded: refunds can concern older
          purchases and the ratio can exceed 1. Share is null when receipts are zero. A complete empty list means
          no refund activity; incomplete readings have null totals and an empty list. Confirmed gross receipt
          reports remain available independently.
        </p>
        <p>
          <code className="font-mono">buyer_channels</code> groups buyers by the channel of their first observed
          purchase in each 7-, 30- or 90-day window, not their lifetime first purchase. It includes buyers, repeat
          buyers, orders and observed purchase revenue before refunds and fees, excluding subscription renewals.
          Thirty-day repeat rates are fractions based only on buyers with 30 full days observed; the rate is null
          when none are eligible. Unidentified orders are reported separately. Incomplete purchase history makes
          this group unavailable, with null unidentified-order counts and empty rows. A complete empty group is
          a confirmed empty reading. No buyer identities are exposed.
        </p>
        <p>
          At the response root, <code className="font-mono">weekly_buyer_cohorts</code> groups buyers by the UTC
          Monday of their first observed purchase week. It includes the observation date and 7-, 30-, 60- and
          90-day eligible-buyer counts, repeat counts and fractional rates. Each rate uses only buyers with the
          full observation window; no eligible buyers means null, not zero. History is limited to the purchases
          read by the platform. Missing or incomplete history makes this group unavailable, while a complete
          empty reading remains available. Unidentified orders are separate and no identities are included.
        </p>
        <p>
          Each period includes <code className="font-mono">daily_payments</code>, with UTC dates, gross receipts
          including renewals, refunds recorded that day and amounts after refunds, before fees and ad spend.
          Separate payment and refund coverage flags distinguish unavailable readings from real zero amounts.
          Missing refund coverage leaves confirmed daily receipts available but refunded and after_refunds null.
          Complete readings include days with zero activity. Refunds of older purchases can produce a negative
          daily result. Incomplete payment readings have no daily rows.
        </p>
        <p>
          <code className="font-mono">campaign_results</code> exposes every recorded campaign in each period:
          visits, paid purchase records, purchase revenue before refunds and fees, and the channels of those
          payments. Campaign tags aggregate across channels; they do not provide a traffic split by channel.
          Subscription renewals are excluded. Incomplete purchase readings preserve campaign visits while
          paid amounts and payment channels remain null. A null channel list means unavailable origin detail;
          an empty list means zero paid records. Available empty reports are distinct from missing reports.
        </p>
        <p>
          The <code className="font-mono">ads</code> and <code className="font-mono">sales_by_country</code> lists
          return at most 20 entries. Their total counts and truncated flags indicate whether more recorded
          entries exist. The existing completeness flags describe reading coverage, not whether the response
          contains every entry. Unknown readings have null counts and truncated flags; confirmed empty readings
          have zero counts and false flags. Do not sum a truncated list as the full period total.
        </p>
        <p>
          Use <code className="font-mono">/api/v1/stats?details=all</code> to retrieve every recorded ad variant
          and buyer country in each period. Default requests retain the 20-entry limit. The same authentication
          and reading-coverage rules apply: requesting all details does not expose incomplete paid readings.
          Complete full lists have false truncation flags. Ad variants keep their channel and campaign, so the
          same creative name in different campaigns or channels remains distinct.
        </p>
        <p>
          <code className="font-mono">attribution</code> compares purchase counts and revenue by the last visit,
          first visit and the origin buyers reported, using the same channel groups as the studio. These are
          alternative views of the same purchases; do not add the columns. Unidentified last and first visits
          remain separate, with survey answers for unidentified last visits. Missing first-visit history leaves
          its figures null and first_visit_complete false. Incomplete paid readings make the entire comparison
          unavailable. The configured attribution window is reported when known. Renewals are excluded, and
          no individual survey answers or buyer identities are exposed.
        </p>
        <p>
          Each window includes <code className="font-mono">period</code> with UTC start and end dates, the
          requested length and the number of returned days. Calendar completeness requires the full requested
          sequence of consecutive valid dates; gaps, duplicates and short histories make it false. Missing or
          invalid dates are not replaced with invented dates. This describes date coverage, independently of
          payment coverage. The last day can still be in progress; complete calendar coverage does not mean
          that today has finished or that financial readings are complete.
        </p>
        <p>
          <code className="font-mono">previous.available</code> indicates whether the preceding period was read.
          When it is false, previous visitors, page views, checkouts, sales and revenue are null, rather than
          invented zeros. Confirmed empty periods retain zero traffic. Availability of previous traffic does
          not confirm paid coverage: previous paid values still require a complete purchase reading. Current
          results remain independent of missing previous history. Availability is carried from the underlying
          traffic reading, so older snapshots without that history do not acquire an artificial zero baseline.
        </p>
      </LegalSection>

      <LegalSection title="Ask your AI assistant">
        <p>
          Marktmorgen is also an MCP server, so an assistant that speaks the Model Context Protocol — Claude, ChatGPT,
          Cursor and others — can answer questions like &quot;which channel made me money this month?&quot; from your own
          numbers. Add it as a remote server at <code className="font-mono">https://marktmorgen.com/api/mcp</code>, with
          the header <code className="font-mono">Authorization: Bearer nl_live_…</code> and one of your keys.
        </p>
        <p>
          It has twenty tools. One prepares a change: a new description for a product, kept as a proposal you read beside the
          current one and confirm under What the AI proposes in your studio, with undo; nothing changes until you confirm, and it
          needs a key you allowed to prepare changes. The other nineteen read only: your numbers (the same as <code className="font-mono">/api/v1/stats</code>),
          your products, revenue by channel read three ways, the funnel from visit to sale, each product&apos;s numbers and
          what buyers buy next, your buyers in numbers, what is worth knowing, your memberships (MRR, churn, why members
          left, month by month), your emails and sequences with what they sold, your affiliates by their codes, a product&apos;s description
          and its sales page block by block (testimonials counted, never quoted), a course&apos;s outline and each lesson&apos;s
          text, quiz and task (files named, never located), how a product&apos;s page test is going, how far down its
          sales page visitors read and its earlier versions, the sections you saved to reuse, and which store the key belongs to. Most of the ones about a stretch of time take <code className="font-mono">days</code>: 7, 30 or 90.
          It changes nothing, and it does not read anybody&apos;s name or address, buyers&apos;, members&apos;,
          subscribers&apos; or affiliates&apos;: what an assistant reads is kept by whoever runs the assistant,
          and the people on your list did not agree to that. The endpoints above are where your own tools read them.
        </p>
        <p>
          {`Each tool counts as many of your API requests as the address that reads the same: your numbers and the tools about a stretch of days as /api/v1/stats, read anew or from the copy kept an hour (the tools about a stretch of days keep their own copy, with the products they name, and count those products when read anew), each answer with its asOf; each product's numbers also count what buyers bought next, by its size; your products as /api/v1/products and your affiliates as /api/v1/affiliates. Your memberships count as about ${n(MEMBERSHIPS_COUNT)}, or ${n(MEMBERSHIPS_COUNT_COLD)} when they were not read in the last ten minutes, and more for the names of the products they name; your emails count by how many emails and sequences you have, and more when what they sold was not read in the last ten minutes. A product's description, its sales page, a course's outline or one lesson, a page test and how far a page is read each count as a few, by the most they could read; a page's earlier versions and your saved sections count more as more are kept. Preparing a description counts as a few, more as more proposals wait or are kept. Which store the key belongs to counts as one.`}
        </p>
      </LegalSection>

      <LegalSection title="Affiliates">
        <Endpoint path="/api/v1/affiliates">
          Every affiliate, with what they earned, were paid and are owed — the numbers on your affiliates page.
        </Endpoint>
        <Code>{`{
  "currency": "usd",
  "refunds_checked": true,
  "data": [
    {
      "id": "0123456789ab",
      "email": "sara@example.com",
      "code": "sara",
      "status": "approved",
      "applied_at": "2026-09-02T16:40:12.000Z",
      "clicks": 214,
      "sales": 9,
      "earned": 18900,
      "paid": 12000,
      "owed": 6900,
      "payable": 4200,
      "waiting": 2700
    }
  ]
}`}</Code>
        <p>
          {`It reads your whole program, so it counts as at least ${n(AFFILIATES_COUNT_LEAST)} of your API requests, and more as your program grows: for example, ${n(AFFILIATES_COUNT_EXAMPLE)} for ${n(BOOK_EXAMPLE.affiliates)} affiliates with ${n(BOOK_EXAMPLE.sales)} sales and your Stripe account connected. The count is made before anything is read.`}
        </p>
        <p>
          <code className="font-mono">payable</code> is what can be paid today; <code className="font-mono">waiting</code>{" "}
          is still inside the wait you set before a sale can be paid. When <code className="font-mono">refunds_checked</code>{" "}
          is <code className="font-mono">false</code>, Stripe could not be asked about refunds just now and the amounts may
          be high: read again before paying anyone from them.
        </p>
      </LegalSection>

      <LegalSection title="Bookings">
        <Endpoint path="/api/v1/bookings">
          Paid calls and seats in live sessions, each at the time it is booked for now — a booking its buyer moved is at
          its new time.
        </Endpoint>
        <p>
          {`With your Stripe account connected, it reads up to ${n(BOOKINGS_READ)} bookings from it, so it counts as ${n(BOOKINGS_COUNT)} of your API requests, however many you have. Without Stripe connected, it counts as one.`}
        </p>
        <Code>{`{
  "data": [
    {
      "id": "cs_live_a1B2c3…",
      "product_id": "c9v7n2k4ww",
      "title": "30-minute strategy call",
      "email": "dana@example.com",
      "name": "Dana Ortiz",
      "starts_at": "2026-10-03T15:00:00.000Z",
      "ends_at": "2026-10-03T15:30:00.000Z",
      "buyer_time_zone": "America/New_York",
      "moved": 0,
      "amount": 9900,
      "currency": "usd",
      "answers": [{ "label": "What should we cover?", "value": "Pricing my first course" }]
    }
  ]
}`}</Code>
      </LegalSection>

      <LegalSection title="Writing: your list">
        <Endpoint method="POST" path="/api/v1/leads">
          Puts somebody on your list, as someone who agreed to hear from you. Send{" "}
          <code className="font-mono">agreed: true</code>, your word that they did: nobody is added without it, and
          nobody who unsubscribed from your list is ever added back, whatever is sent. Somebody new starts the sequences
          that start when somebody joins your list; a label they come with starts the sequences that label starts.
        </Endpoint>
        <Code>{`curl -X POST ${BASE}/leads \\
  -H "Authorization: Bearer nl_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{"email": "dana@example.com", "name": "Dana Ortiz", "tags": ["webinar"], "agreed": true}'

200  {"data": {"email": "dana@example.com", "status": "added"}}
200  {"data": {"email": "dana@example.com", "status": "already"}}
400  {"error": "consent", "message": "Send agreed: true, …"}
409  {"error": "unsubscribed", "message": "This person unsubscribed from your list, so they are not added back."}`}</Code>
        <Endpoint method="POST" path="/api/v1/leads/labels">
          Adds and takes away labels of somebody already on your list. A label added starts the sequences it starts in
          your studio.
        </Endpoint>
        <Code>{`{"email": "dana@example.com", "add": ["vip"], "remove": ["webinar"]}

200  {"data": {"email": "dana@example.com", "labels": ["vip"]}}
404  {"error": "not_on_list", "message": "Nobody with this address is on your list."}`}</Code>
        <p>{`A store may add ${ADDS_PER_DAY.toLocaleString("en-US")} new people a day through the API; past that, 429 daily_limit until the next day.`}</p>
      </LegalSection>

      <LegalSection title="Discount codes">
        <Endpoint path="/api/v1/codes">
          Your discount codes, read from your own Stripe account as your studio lists them: what each takes off, how many
          times it was used, its limit, its smallest order and whether it is live.
        </Endpoint>
        <p>{`Reading them asks your Stripe account, so it counts as ${n(CODES_COUNT)} of your API requests; making a code counts as ${n(CODE_MAKE_COUNT)} and switching one off as ${n(CODE_STOP_COUNT)}, taken before Stripe is asked.`}</p>
        <Endpoint method="POST" path="/api/v1/codes">
          Makes a code on your own Stripe account, checked as in your studio. Send{" "}
          <code className="font-mono">{`{"code": "LAUNCH20", "percent": 20}`}</code>, or{" "}
          <code className="font-mono">{`{"code": "TENOFF", "kind": "amount", "amount": "10"}`}</code> in your store&apos;s
          currency; <code className="font-mono">uses</code> and <code className="font-mono">minimum</code> are optional. A
          code that cannot be made says why, as <code className="font-mono">error</code> and{" "}
          <code className="font-mono">message</code>; the same letters twice give 409 <code className="font-mono">taken</code>.
        </Endpoint>
        <Endpoint method="DELETE" path="/api/v1/codes?id=promo_…">
          Switches one of your store&apos;s codes off. Stripe never deletes a code that may be on a receipt, so it stays in
          the list, switched off. Making and switching off need a key that writes; all three answer 409{" "}
          <code className="font-mono">not_selling</code> while your store is not taking payments.
        </Endpoint>
      </LegalSection>

      <LegalSection title="Writing: giving a product">
        <Endpoint method="POST" path="/api/v1/access">
          Gives a product to an address with no payment, as an import of past buyers does: a file, a link, a course, a
          podcast or a bundle, by its id or its exact name. They open it from your store&apos;s list of purchases with
          that address, where it shows as given by your store, not as a sale; it is not counted in your numbers, sent to
          webhooks or credited to an affiliate. Send <code className="font-mono">notify: true</code> and they get one email
          from your store&apos;s name saying so, in your store&apos;s language, while your plan is running. Somebody
          deleted from your store is never given anything again or emailed.
        </Endpoint>
        <Code>{`{"email": "dana@example.com", "product": "k3j9x2p1ab", "notify": true}

200  {"data": {"email": "dana@example.com", "product": "k3j9x2p1ab", "status": "given", "emailed": true}}
200  {"data": {"email": "dana@example.com", "product": "k3j9x2p1ab", "status": "already", "emailed": false}}
409  {"error": "cannot_give", "message": "Memberships, calls and products with several prices cannot be given this way."}
409  {"error": "deleted", "message": "This person was deleted from your store, so nothing is given to them and they are not emailed."}`}</Code>
        <Endpoint method="DELETE" path="/api/v1/access">
          Takes back a product the API gave, with the same body. Only what the API gave: a sale, an import, a gift or a
          purchase paid with PayPal is not the API&apos;s to take, and gets 404{" "}
          <code className="font-mono">not_given_here</code>.
        </Endpoint>
        <Code>{`{"email": "dana@example.com", "product": "k3j9x2p1ab"}

200  {"data": {"email": "dana@example.com", "product": "k3j9x2p1ab", "status": "taken_back"}}`}</Code>
        <p>{`A store may give ${GIVES_PER_DAY.toLocaleString("en-US")} products a day through the API. A body is JSON of up to 4,000 bytes.`}</p>
      </LegalSection>

      <LegalSection title="Sales and refunds">
        <Endpoint path="/api/v1/sales">
          Your store&apos;s paid checkouts, newest first, read from your own Stripe account as your studio&apos;s list of
          sales reads them, in the same shape as the <code className="font-mono">sale.completed</code> webhook.
          {` Up to ${SALES_PAGE} checkouts are read per call, and each call counts as ${API_SALES_UNITS} API requests, because it waits on Stripe. `}
          A page can be empty and still have a <code className="font-mono">next</code>, when those checkouts were not this
          store&apos;s. A checkout that only saved a card is not a sale and is not listed. What a buyer typed at checkout is
          not included. 409 with <code className="font-mono">not_selling</code> while the store is not taking payments.
        </Endpoint>
        <Code>{`{
  "data": [
    {
      "checkout_session": "cs_live_a1B2c3",
      "kind": "one_time",
      "product": { "id": "k3j9x2p1ab", "title": "The 7-Day Reset" },
      "option": null,
      "bundle_items": [{ "id": "q8w2e4r6ty", "title": "Reset Workbook" }],
      "order_bump": { "id": "m5n7b9v1cx", "title": "Meal Planner", "bundle_items": null },
      "order_bumps": [{ "id": "m5n7b9v1cx", "title": "Meal Planner", "bundle_items": null }],
      "amount_cents": 5800,
      "discount_cents": 0,
      "currency": "usd",
      "buyer": { "email": "dana@example.com", "name": "Dana Ortiz" },
      "opened_at": "2026-09-20T09:38:52.000Z",
      "paid_at": "2026-09-20T09:41:10.000Z",
      "refunded_cents": 0,
      "disputed": false,
      "trial": false,
      "source": { "utm_source": "newsletter", "utm_medium": "email", "utm_campaign": null, "utm_content": null, "site": null }
    }
  ],
  "next": "cs_live_a1B2c3"
}`}</Code>
        <p>
          <code className="font-mono">amount_cents</code> is what the buyer paid at checkout, products checked at checkout
          included, in the currency&apos;s smallest unit, as Stripe counts it: cents for dollars, but whole yen for{" "}
          <code className="font-mono">jpy</code> and whole units for the other currencies Stripe has without decimals,
          such as <code className="font-mono">krw</code>. So 4900 is $49.00 in <code className="font-mono">usd</code> and
          ¥4,900 in <code className="font-mono">jpy</code>. <code className="font-mono">discount_cents</code> is in the same
          unit, and is <code className="font-mono">null</code> if Stripe gave no discount details.
        </p>
        <p>
          <code className="font-mono">paid_at</code> is when the buyer paid: the charge, or for a membership or
          payment plan, when its first invoice was paid (with a free trial, that invoice is for $0, so this is when the
          trial began). It is not when the checkout page was opened. It is{" "}
          <code className="font-mono">null</code> when nothing was charged at checkout, such as a free order.{" "}
          <code className="font-mono">currency</code> is always the three-letter code Stripe gave: if Stripe did not
          give one for a sale, the answer is 502 <code className="font-mono">unavailable</code>, never a guessed{" "}
          <code className="font-mono">usd</code>.
        </p>
        <p>
          Products checked at checkout are in <code className="font-mono">order_bumps</code>, in the order of their boxes,
          and the first is also in <code className="font-mono">order_bump</code>; a bundle&apos;s products are in{" "}
          <code className="font-mono">bundle_items</code>, which is <code className="font-mono">null</code> when there is
          no bundle. A product&apos;s <code className="font-mono">title</code> is{" "}
          <code className="font-mono">null</code> when the product is no longer in your store
          {`, or, on a page naming more than ${SALES_TITLE_IDS} different products, for those past the ${SALES_TITLE_IDS}th. `}
          A one-click extra taken after the checkout (an upsell) is its own payment, not a checkout, so it is not on this
          list: the <code className="font-mono">sale.completed</code> webhook with{" "}
          <code className="font-mono">&quot;kind&quot;: &quot;upsell&quot;</code> tells you of each one.
        </p>
        <p>
          <code className="font-mono">refunded_cents</code> and <code className="font-mono">disputed</code> are not in the
          webhook, which is sent when the sale is made. For a one-time payment they are read from its charge when you
          call: how much of it was refunded so far, in the same unit as <code className="font-mono">amount_cents</code>, and
          whether the buyer disputed it. For a membership or payment plan, and when nothing was charged, both are{" "}
          <code className="font-mono">null</code>: not read here, which is not the same as none. Add the{" "}
          <code className="font-mono">refund.issued</code> and <code className="font-mono">dispute.opened</code> webhooks in
          your studio to be told of each one, or read them in Stripe&apos;s own API with your own Stripe key.
        </p>
        <p>
          The list is in the order Stripe keeps checkouts: newest first by{" "}
          <code className="font-mono">opened_at</code>, when the checkout page was opened, not by{" "}
          <code className="font-mono">paid_at</code>. A buyer can open a checkout and pay later, and some payment methods,
          such as bank debits, settle days after that, so a sale can appear below sales you already read. To keep a copy
          in step, read again from the top each time and go on until a sale&apos;s{" "}
          <code className="font-mono">opened_at</code> is earlier than your last read, less a margin: at least 24 hours,
          and a week or more if your store takes payment methods that settle later. Use{" "}
          <code className="font-mono">checkout_session</code> to skip a sale you already have.
        </p>
        <p>
          {`Texts are cut to a fixed length, so a page stays small: a product's title from the checkout to ${SALE_TEXT_LIMITS.title} characters, the buyer's name to ${SALE_TEXT_LIMITS.name}, each utm tag to ${SALE_TEXT_LIMITS.utm} and the site to ${SALE_TEXT_LIMITS.site}, with control characters left out. Lengths are counted in UTF-16 code units, as JavaScript counts them, so an emoji counts as 2. An email address longer than ${SALE_TEXT_LIMITS.email} characters is not a real one, so it is null rather than cut, and so is one holding a control character.`}{" "}
          <code className="font-mono">product.id</code> and <code className="font-mono">option</code> are{" "}
          <code className="font-mono">null</code> when the id stored on the checkout is not shaped like an id (letters,
          digits, hyphens and underscores, up to 64).
        </p>
        <p>
          A <code className="font-mono">cursor</code> this list did not give, or sent twice, is answered 400{" "}
          <code className="font-mono">invalid_cursor</code>: start again without one. If Stripe is busy with your account,
          the answer is 503 with <code className="font-mono">Retry-After</code>. If Stripe&apos;s answer cannot be read
          whole, the answer is 502 <code className="font-mono">unavailable</code>, never a page with guessed amounts.
        </p>
      </LegalSection>

      <LegalSection title="Checkout on your own website">
        <p>
          To sell from your own site, no key is needed or allowed in a web page: the{" "}
          <Link href="/developers/checkout-script" className="text-black underline underline-offset-2 hover:no-underline">
            checkout script
          </Link>{" "}
          opens a product&apos;s card or your sign-up form over your page, by a link that names only your store and the
          product, and tells your page and your webhooks what happened.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
