import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, LegalSection } from "@/components/legal-page";
import { API_PAGE } from "@/lib/api-read";
import { API_RATE } from "@/lib/api-guard";
import { MAX_KEYS } from "@/lib/api-key-rules";
import { ADDS_PER_DAY, GIVES_PER_DAY } from "@/lib/api-write";
import { API_WRITE_UNITS, NON_PAYING_ALLOWANCES, STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { PLAN_TITLES } from "@/lib/plan";

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
    <LegalPage title="Developers" eyebrow="For your own tools" effective={null} legalNav={false} lastUpdated="October 31, 2026">
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
          {` A page holds up to ${API_PAGE} rows. Times are ISO 8601, in UTC. Amounts are in the currency's smallest unit — cents for dollars.`}
        </p>
        <p>
          {`Each key may make ${API_RATE} requests a minute. Past that, the answer is 429 with `}
          <code className="whitespace-nowrap font-mono">Retry-After: 60</code>.
        </p>
        <p>
          {`A store's keys together also have a figure for each billing month (the month that starts on the day the store's plan renews): ${STORE_ALLOWANCES.creator.api.toLocaleString("en-US")} requests on ${PLAN_TITLES.creator}, ${STORE_ALLOWANCES.pro.api.toLocaleString("en-US")} on ${PLAN_TITLES.pro} and ${STORE_ALLOWANCES.scale.api.toLocaleString("en-US")} on ${PLAN_TITLES.scale}. A free trial has ${NON_PAYING_ALLOWANCES.trial.api.toLocaleString("en-US")} for the whole trial, and a store without a paid plan has none. A contact added or a product given counts as ${API_WRITE_UNITS}. Past it, the answer is 429 `}
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
429  {"error": "no_place", "message": "Stores without a paid plan are full for this month, so this can't run right now. …"}
409  {"error": "store_full", "message": "Your store's data room is full, so nothing was added. …"}
409  {"error": "paused_unpaid", "message": "Nothing was read: your plan's renewal payment did not go through, …"}
409  {"error": "paused_unpaid", "message": "Nothing was changed: your plan's renewal payment did not go through, …"}
502  {"error": "unavailable", "message": "… could not be read just now. Try again in a moment."}`}</Code>
        <p>A missing, mistyped and revoked key all get the same 401.</p>
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
          Everybody who has opened one course, with how far they got, the most recently active first, up to 500.{" "}
          <code className="font-mono">product</code> is the course product&apos;s id, from Products.
        </Endpoint>
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
  ]
}`}</Code>
      </LegalSection>

      <LegalSection title="Numbers">
        <Endpoint path="/api/v1/stats">
          Your numbers for the last 7, 30 and 90 days, the same ones your studio shows: visitors, checkouts, sales and
          revenue, each channel from visit to sale, and page views by country and by device.
        </Endpoint>
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
  }
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
          It has eleven tools, all reading only: your numbers (the same as <code className="font-mono">/api/v1/stats</code>),
          your products, revenue by channel read three ways, the funnel from visit to sale, each product&apos;s numbers and
          what buyers buy next, your buyers in numbers, what is worth knowing, your memberships (MRR, churn, why members
          left, month by month), your emails and sequences with what they sold, your affiliates by their codes, and which
          store the key belongs to. The ones about a stretch of time take <code className="font-mono">days</code>: 7, 30 or
          90. It changes nothing, and it does not read anybody&apos;s name or address, buyers&apos;, members&apos;,
          subscribers&apos; or affiliates&apos;: what an assistant reads is kept by whoever runs the assistant,
          and the people on your list did not agree to that. The endpoints above are where your own tools read them.
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

      <LegalSection title="Writing: giving a product">
        <Endpoint method="POST" path="/api/v1/access">
          Gives a product to an address with no payment, as an import of past buyers does: a file, a link, a course, a
          podcast or a bundle, by its id or its exact name. They open it from your store&apos;s list of purchases with
          that address, where it shows as given by your store, not as a sale; it is not counted in your numbers, sent to
          webhooks or credited to an affiliate. Send <code className="font-mono">notify: true</code> and they get one email
          from your store&apos;s name saying so, in your store&apos;s language, while your plan is running.
        </Endpoint>
        <Code>{`{"email": "dana@example.com", "product": "k3j9x2p1ab", "notify": true}

200  {"data": {"email": "dana@example.com", "product": "k3j9x2p1ab", "status": "given", "emailed": true}}
200  {"data": {"email": "dana@example.com", "product": "k3j9x2p1ab", "status": "already", "emailed": false}}
409  {"error": "cannot_give", "message": "Memberships, calls and products with several prices cannot be given this way."}`}</Code>
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
        <p>
          Sales, subscriptions and refunds are charged on your own Stripe account, so Stripe&apos;s own API is where to
          read them, with your own Stripe key. To be told about each one as it happens, add a webhook in your studio.
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
