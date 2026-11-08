/**
 * A buyer's page in the studio says which of its parts could not be read
 * (rule 24, inventory item 8): purchases handed over without a Stripe payment
 * (imported, given, bought for others, paid with PayPal), the amount of a
 * PayPal sale, the calls coming up and the sequences they were started on.
 * Before, each of those reads ended in `.catch(() => [])`, so a failed read
 * looked exactly like "none", and the page looked complete.
 *
 * Checked: a healthy read names no part; a confirmed absence (nothing
 * imported, no sequences, no calls) names no part either; each failed read
 * names its own part and only it, and the rest of the page is still there;
 * the studio page shows the sentence that names them, as a status.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as profiles from "@/lib/buyer-profile";
import { buyerProfile } from "@/lib/buyer-profile";
import { importedKey } from "@/lib/imported-purchases";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = Math.floor(Date.parse("2026-11-08T12:00:00Z") / 1000);
const STATS = "b".repeat(32);
const LIST = "list0002";
const IMPORT_JOB = "0123456789abcdef01234567";
const PAYPAL_ORDER = "PAYPAL0RDER0001";
const FLOW = "flow00000001";
const EMAIL = "buyer@example.com";
const addressHash = (email: string) => createHash("sha256").update(`nimbus-flow:${email}`).digest("hex").slice(0, 32);

let callsDown = false;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") return new Response("{}", { status: 404 });
  if (url.pathname === "/v1/checkout/sessions") {
    // The calls' own reading of the store's checkouts (lib/calls.ts) asks by time; the buyer's payments by address.
    if (url.searchParams.has("created[gte]")) {
      if (callsDown) return new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 });
      return new Response(JSON.stringify({ data: [], has_more: false }));
    }
    return new Response(JSON.stringify({ data: [], has_more: false }));
  }
  if (url.pathname === "/v1/charges") return new Response(JSON.stringify({ data: [], has_more: false }));
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const products = [
  { id: "course1", title: "Bread School", course: null, options: [] },
  { id: "kit1", title: "Starter Kit", course: null, options: [] },
  { id: "call1", title: "A call with Ada", course: null, options: [] },
];

function shop(): Store {
  return {
    sid: "sidbake00002",
    handle: "bakery",
    name: "Oven Notes",
    email: "owner@example.com",
    previousHandles: [],
    releasedHandles: [],
    statsId: STATS,
    listId: LIST,
    callsId: null,
    currency: "usd",
    language: "en",
    stripeAccountId: "acct_test_profile2",
    pastBuyers: true,
    catalog: {
      id: null,
      head: [],
      items: [
        { id: "course1", kind: 1, options: [] },
        { id: "kit1", kind: 1, options: [] },
        { id: "call1", kind: 1 | 4, options: [] },
      ],
      inline: products,
    },
  } as unknown as Store;
}

/** Makes every pipeline holding one of these commands on a key starting so fail, as a Redis that could not be reached. */
async function failing<T>(fails: [string, string][], run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => fails.some(([cmd, prefix]) => c[0] === cmd && String(c[1]).startsWith(prefix)))) throw new Error("Redis could not be reached");
    return original.call(redis, commands);
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

const unreadOf = (profile: unknown) => (profile as { unread?: unknown }).unread;

async function seed(): Promise<void> {
  redis.clear();
  await redis.pipeline([
    [
      "HSET",
      importedKey(STATS, EMAIL),
      "course1",
      JSON.stringify({ at: NOW - 100, job: IMPORT_JOB }),
      "kit1",
      JSON.stringify({ at: NOW - 50, job: `paypal:${PAYPAL_ORDER}` }),
    ],
    ["SET", `nl:ppsell:paid:${PAYPAL_ORDER}`, JSON.stringify({ store: STATS, order: PAYPAL_ORDER, capture: "CAP1", email: EMAIL, product: "kit1", cents: 1200, currency: "usd", at: NOW - 50, meta: {} })],
    ["SET", `nl:mail:flows:${LIST}`, JSON.stringify([{ id: FLOW, name: "Welcome", active: true, trigger: "joined", steps: [] }])],
    ["SET", `nl:mail:enr:${FLOW}:${addressHash(EMAIL)}`, "1"],
  ]);
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_profile_only_a_stand_in";
  const store = shop();

  await seed();

  part("Every part read");
  const whole = await buyerProfile(store, EMAIL);
  is("no part is named", unreadOf(whole), []);
  is(
    "the imported purchase and the PayPal sale are on it",
    whole.orders.map((o) => [o.kind, o.title, o.cents, o.note]),
    [
      ["sale", "Starter Kit", 1200, "paypal"],
      ["brought", "Bread School", 0, "imported"],
    ],
  );
  is("the PayPal sale is counted in what they paid", whole.paid, 1200);
  is("the sequence they were started on", whole.sequences, ["Welcome"]);
  is("no call coming up, read in full", whole.calls, []);

  part("Nothing there, confirmed");
  redis.clear();
  const empty = await buyerProfile(store, EMAIL);
  is("nothing imported, no sequences, no calls: no part is named", [unreadOf(empty), empty.orders.length, empty.sequences, empty.calls], [[], 0, [], []]);

  part("Purchases handed over could not be read");
  await seed();
  const noImports = await failing([["HGETALL", "nl:imp:buy:"]], () => buyerProfile(store, EMAIL));
  is("the imported part is named, and only it", unreadOf(noImports), ["imported"]);
  is("the rest is still there", noImports.sequences, ["Welcome"]);

  part("A PayPal sale's amount could not be read");
  const noPaypal = await failing([["GET", "nl:ppsell:paid:"]], () => buyerProfile(store, EMAIL));
  is("the PayPal part is named, and only it", unreadOf(noPaypal), ["paypal"]);
  is(
    "the purchase is still listed, without an amount it cannot stand behind",
    noPaypal.orders.map((o) => [o.kind, o.title, o.cents, o.note]),
    [
      ["brought", "Starter Kit", 0, "paypal"],
      ["brought", "Bread School", 0, "imported"],
    ],
  );

  part("The sequences could not be read");
  const noFlows = await failing([["GET", "nl:mail:flows:"]], () => buyerProfile(store, EMAIL));
  is("the sequences are named when the list of sequences fails", [unreadOf(noFlows), noFlows.sequences], [["sequences"], []]);
  const noStarts = await failing([["EXISTS", "nl:mail:enr:"]], () => buyerProfile(store, EMAIL));
  is("and when who was started on them fails", [unreadOf(noStarts), noStarts.sequences], [["sequences"], []]);
  is("the purchases are still there", noStarts.orders.length, 2);

  part("The calls could not be read");
  callsDown = true;
  const noCalls = await buyerProfile(store, EMAIL);
  callsDown = false;
  is("the calls are named", unreadOf(noCalls), ["calls"]);

  part("Several at once, in the page's order");
  callsDown = true;
  const many = await failing([["HGETALL", "nl:imp:buy:"], ["GET", "nl:mail:flows:"]], () => buyerProfile(store, EMAIL));
  callsDown = false;
  is("each named once", unreadOf(many), ["imported", "calls", "sequences"]);

  part("What the page says");
  const words = (profiles as unknown as { profileUnreadWords?: (parts: string[]) => string }).profileUnreadWords;
  is("a sentence exists for the parts", typeof words, "function");
  if (typeof words === "function") {
    is("nothing missing, nothing said", words([]), "");
    is(
      "one part",
      words(["calls"]),
      "Some parts of this page could not be loaded just now, so they are missing below: their calls coming up. Nothing was changed. Open this page again in a moment.",
    );
    is(
      "several, and the totals warned about when money may be missing",
      words(["imported", "paypal", "sequences"]),
      "Some parts of this page could not be loaded just now, so they are missing below: purchases brought from another platform, given, bought for others or paid with PayPal; the amounts of their PayPal sales; and the sequences they were started on. What they paid may be more than the totals show. Nothing was changed. Open this page again in a moment.",
    );
  }
  const page = readFileSync("app/studio/people/page.tsx", "utf8");
  is("the studio page shows the sentence as a status", /profile\.unread\.length[\s\S]{0,200}role="status"[\s\S]{0,200}profileUnreadWords\(profile\.unread\)/.test(page), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
