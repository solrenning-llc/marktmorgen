/**
 * Each course written down for an address keeps where it came from (Claude 5, 9 November 2026, pre-review of #3376).
 *
 * #3376 made courseLedger (lib/learn.ts) say "unknown" for every course Stripe alone decides while Stripe cannot be
 * read, never "bought nothing" and never "not refunded". But the ledger (`nl:learn:enr:`) did not keep where a course
 * came from, so a course handed over by a PayPal sale, a gift, a pre-order or a group place, each confirmed by its own
 * source and taken back by its own path (dropEnrollment, from the PayPal watch and the gift, pre-order and group
 * sweeps), was shut as "unknown" too, though on main it opened.
 *
 * Now recordEnrollment writes the origin beside the start, one letter after a colon ("1760000000:p"): while Stripe
 * cannot be read, a one-off course of a non-Stripe origin stays open; one written down from a Stripe checkout (the
 * thanks page, "Start the course"), one written before origins were kept (no letter), and any membership course stay
 * "unknown". A value in any other shape is unknown and throws, never "not written down". A PayPal sale refunded is
 * taken off the ledger and shuts.
 *
 * Synthetic only: an in-memory Redis and a stand-in for the creator's Stripe account.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setStripeAccount, storeForEmail } from "@/lib/store";
import { courseAccess, dropEnrollment, emailKey, forgetPaid, mintPass, paidCourses, passCookieName, recordEnrollment, storeKey } from "@/lib/learn";
import { readListing } from "@/lib/catalog";
import { readFileSync } from "node:fs";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_learn_ledger_origin";

const OWNER = "teacher@example.com";
const HANDLE = "inkhouse";
const ACCOUNT = "acct_1TestLedgOrig";
const NOW = Math.floor(Date.now() / 1000);
const START = NOW - 86_400;

/** When true, Stripe's list of checkouts cannot be read. */
let down = false;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") return new Response(JSON.stringify({ error: "no sending in this test" }), { status: 500 });
  if (down) return new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 });
  const path = url.pathname.replace(/^\/v1/, "");
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false, url: `/v1${path}` }), { status: 200 });
}) as typeof fetch;

type Origin = Parameters<typeof recordEnrollment>[4];

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Inkhouse", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  const single = await addProduct(OWNER, "Ink Basics", "", "49", null);
  const club = await addProduct(OWNER, "Ink Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!single.ok || !club.ok) throw new Error("no product");
  await setProductCourse(OWNER, single.product.id, { id: "c".repeat(32), lessons: 3 });
  await setProductCourse(OWNER, club.product.id, { id: "d".repeat(32), lessons: 3 });
  const store = (await storeForEmail(OWNER))!;
  const one = (await readListing(store, single.product.id))!;
  const member = (await readListing(store, club.product.id))!;

  const pass = async (email: string) => {
    const token = await mintPass(store, email, "all");
    return { get: (name: string) => (name === passCookieName(store) ? { value: token } : undefined) };
  };
  const stateOf = async (email: string, product: typeof one) => {
    await forgetPaid(store, email);
    return (await courseAccess(store, product, await pass(email))).state;
  };
  const ledgerKey = (email: string) => `nl:learn:enr:${storeKey(store)}:${emailKey(email)}`;
  const written = async (email: string, product: string) => (await redis.pipeline([["HGET", ledgerKey(email), product]]))[0];

  const OTHER_SOURCES: [Origin, string][] = [
    ["paypal", "a PayPal sale"],
    ["gift", "a gift"],
    ["preorder", "a pre-order handed over"],
    ["group", "a group place taken"],
  ];

  part("A course from a source of its own stays open while Stripe cannot be read");
  for (const [origin, label] of OTHER_SOURCES) {
    const email = `${origin}@example.com`;
    await recordEnrollment(store, email, one.id, START, origin);
    down = false;
    is(`${label}: open while Stripe reads (control)`, await stateOf(email, one), "open");
    down = true;
    is(`${label}: still open while Stripe cannot be read`, await stateOf(email, one), "open");
    is(`${label}: paidCourses opens it with its start`, (await paidCourses(store, email)).get(one.id), START);
  }

  part("What Stripe alone decides stays unknown");
  down = true;
  await recordEnrollment(store, "stripe@example.com", one.id, START, "stripe");
  is("a Stripe checkout written down on the thanks page: unknown (its refund is Stripe's)", await stateOf("stripe@example.com", one), "unknown");
  await redis.pipeline([["HSETNX", ledgerKey("old@example.com"), one.id, String(START)]]);
  is("an entry written before origins were kept: unknown, as before", await stateOf("old@example.com", one), "unknown");
  await recordEnrollment(store, "giftclub@example.com", member.id, START, "gift");
  is("a membership course, whatever its origin: unknown (only Stripe says it is live)", await stateOf("giftclub@example.com", member), "unknown");
  down = false;
  is("Stripe read again: the Stripe one-off opens", await stateOf("stripe@example.com", one), "open");
  is("Stripe read again: the old entry opens", await stateOf("old@example.com", one), "open");

  part("A PayPal sale refunded shuts by its own path");
  await recordEnrollment(store, "back@example.com", one.id, START, "paypal");
  await dropEnrollment(store, "back@example.com", one.id);
  down = false;
  is("refunded, Stripe readable: shut", await stateOf("back@example.com", one), "closed");
  down = true;
  is("refunded, Stripe not readable: not open (unknown, since Stripe may still hold a purchase)", await stateOf("back@example.com", one), "unknown");
  down = false;

  part("The value is written exactly, and read exactly");
  const LETTER: Record<NonNullable<Origin>, string> = { stripe: "s", paypal: "p", gift: "g", preorder: "r", group: "l" };
  for (const [origin, letter] of Object.entries(LETTER) as [NonNullable<Origin>, string][]) {
    const email = `bytes-${origin}@example.com`;
    await recordEnrollment(store, email, one.id, START, origin);
    is(`${origin}: the start and one letter, two bytes more than before`, await written(email, one.id), `${START}:${letter}`);
  }
  for (const [label, value] of [
    ["an origin no one writes", `${START}:x`],
    ["two letters", `${START}:pp`],
    ["a colon and nothing", `${START}:`],
    ["the letter before the start", `p:${START}`],
  ] as const) {
    const email = `odd-${label.replace(/\W+/g, "-")}@example.com`;
    await redis.pipeline([["HSET", ledgerKey(email), one.id, value]]);
    down = true;
    const read = await paidCourses(store, email).then(
      (paid) => (paid.has(one.id) ? "open" : "shut"),
      () => "unknown",
    );
    is(`${label}: unknown, never open nor "not written down"`, read, "unknown");
    down = false;
  }

  part("Every writer of the ledger says where its course came from");
  const callers: [string, RegExp, number][] = [
    ["app/[handle]/thanks/page.tsx", /recordEnrollment\(store, order\.email, course\.id, order\.created, "stripe"\)/g, 1],
    ["app/api/store/course/start/route.ts", /recordEnrollment\(store, order\.email, product\.id, order\.created, "stripe"\)/g, 1],
    ["lib/paypal-delivery.ts", /recordEnrollment\(store, email, productId, start, "paypal"\)/g, 2],
    ["lib/purchase-email.ts", /recordEnrollment\(store, email, productId, start, "gift"\)/g, 1],
    ["lib/purchase-email.ts", /recordEnrollment\(store, email, productId, start, "preorder"\)/g, 1],
    ["app/[handle]/group/[group]/page.tsx", /recordEnrollment\(store, email, productId, start, "group"\)/g, 1],
  ];
  for (const [file, call, count] of callers) {
    is(`${file}: ${call.source.split(",").pop()?.replace(/\\/g, "")}`, readFileSync(file, "utf8").match(call)?.length ?? 0, count);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
