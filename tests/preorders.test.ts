/**
 * Pre-orders (lib/preorder-rules.ts, lib/preorders.ts; added 10 October
 * 2026). Checked:
 *
 *   - the expected day is a real day, from tomorrow to a year ahead, and
 *     pre-orders stop by themselves after it;
 *   - only one price, paid once, for a file, a link or a course can be
 *     pre-ordered, and a product with nothing in it cannot go on sale while
 *     pre-orders wait;
 *   - a pre-order's checkout hands over nothing by itself;
 *   - paid while the product is coming soon: written down and receipted with
 *     the day; put on sale: each one still paid is handed over under its
 *     buyer's address and emailed, and one refunded is never handed over;
 *   - a refund after it was handed over takes it back, and only it;
 *   - paid after the product went on sale: handed over at once.
 */
import {
  MAX_PREORDER_DAYS,
  addDays,
  hasContent,
  parsePreorder,
  preorderCounts,
  preorderOpen,
  preorderProblem,
  readExpectedDay,
  todayOf,
} from "@/lib/preorder-rules";
import { confirmPreorder, queueRelease, readPreorder, revokeRefundedPreorders, runPreorderReleases, setExpectedDay, soonOne, soonState, waitingCount } from "@/lib/preorders";
import { deliveredIds } from "@/lib/bundle-rules";
import { importedKey } from "@/lib/imported-purchases";
import type { Listing, Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "e".repeat(32);
const NOW = Date.parse("2026-10-10T12:00:00Z");

const emails: { to: string; subject: string; text: string }[] = [];
const refunded = new Set<string>();
let refunds: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: "e" }));
  }
  if (url.hostname === "api.stripe.com") {
    const intent = url.pathname.match(/\/v1\/payment_intents\/(pi_\w+)/)?.[1];
    if (intent) return new Response(JSON.stringify({ id: intent, object: "payment_intent", latest_charge: { object: "charge", refunded: refunded.has(intent), amount: 2500, amount_refunded: refunded.has(intent) ? 2500 : 0 } }));
    if (url.pathname === "/v1/refunds") return new Response(JSON.stringify({ data: refunds }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

function shop(): Store {
  return {
    sid: "sidpre00001",
    handle: "bakery",
    name: "Oven Notes",
    email: "owner@example.com",
    previousHandles: [],
    releasedHandles: [],
    statsId: STATS,
    currency: "usd",
    language: "en",
    stripeAccountId: "acct_test_preorders1",
    pastBuyers: false,
  } as unknown as Store;
}

const product = { id: "breadbook1", title: "The Bread Book", course: null, priceCents: 2500 } as unknown as Listing;

function session(n: number, email: string) {
  return {
    id: `cs_test_preorder${String(n).padStart(6, "0")}`,
    created: Math.floor(NOW / 1000) - 60,
    status: "complete",
    payment_status: "paid",
    amount_total: 2500,
    currency: "usd",
    payment_intent: `pi_preorder${String(n).padStart(6, "0")}`,
    metadata: { store: "bakery", product: product.id, preorder: "yes" },
    customer_details: { email },
  };
}

const started: string[] = [];
const dropped: string[] = [];
const deps = {
  base: "https://marktmorgen.com/@bakery",
  from: "Oven Notes <hello@example.com>",
  ordersLink: async (email: string) => `https://marktmorgen.com/@bakery/orders?for=${encodeURIComponent(email)}`,
  recordStart: async (email: string, id: string) => {
    started.push(`${email}|${id}`);
  },
};

async function main(): Promise<void> {
  process.env.RESEND_API_KEY = "re_test_only";
  process.env.STRIPE_SECRET_KEY = "sk_test_only";
  redis.clear();
  const store = shop();

  part("The expected day");
  const today = todayOf(NOW);
  is("today is a day", today, "2026-10-10");
  is("tomorrow is the first day that can be chosen", [readExpectedDay(addDays(today, 1), NOW), readExpectedDay(today, NOW)], ["2026-10-11", null]);
  is(`up to ${MAX_PREORDER_DAYS} days ahead, and no further`, [readExpectedDay(addDays(today, MAX_PREORDER_DAYS), NOW) !== null, readExpectedDay(addDays(today, MAX_PREORDER_DAYS + 1), NOW)], [true, null]);
  is("never a day that does not exist, or anything else", [readExpectedDay("2027-02-30", NOW), readExpectedDay("soon", NOW), readExpectedDay(20261111, NOW)], [null, null, null]);
  is("taken until the day itself, and not after", [preorderOpen("2026-10-10", NOW), preorderOpen("2026-10-09", NOW), preorderOpen(null, NOW)], [true, false, false]);

  part("What can be pre-ordered");
  const base = { priceCents: 2500, recurring: null, call: null, bundle: null, podcast: null, callPackage: null, options: [], stock: null, keys: null, pwyw: null };
  is("a file, a link or a course at one price", preorderProblem(base), null);
  is("never something free, a membership, a call, a bundle or a podcast", [
    preorderProblem({ ...base, priceCents: 0 }),
    preorderProblem({ ...base, recurring: { interval: "month" } }),
    preorderProblem({ ...base, call: {} }),
    preorderProblem({ ...base, bundle: ["a", "b"] }),
    preorderProblem({ ...base, podcast: {} }),
  ], ["free", "membership", "call", "bundle", "podcast"]);
  is("nor several prices, a limited number, license keys or a price the buyer chooses", [
    preorderProblem({ ...base, options: [{}] }),
    preorderProblem({ ...base, stock: 10 }),
    preorderProblem({ ...base, keys: {} }),
    preorderProblem({ ...base, pwyw: {} }),
  ], ["options", "stock", "keys", "pwyw"]);
  is("something in it to hand over: a file, a link, or a course with a lesson", [
    hasContent({ file: { name: "a.pdf" }, link: null, course: null }),
    hasContent({ file: null, link: "https://example.com", course: null }),
    hasContent({ file: null, link: null, course: { lessons: 1 } }),
    hasContent({ file: null, link: null, course: { lessons: 0 } }),
    hasContent({ file: null, link: null, course: null }),
  ], [true, true, true, false, false]);
  is("a pre-order's checkout hands over nothing by itself", deliveredIds({ store: "bakery", product: product.id, preorder: "yes" }), []);
  is("a kept pre-order reads back, and nonsense does not", [parsePreorder(JSON.stringify({ to: "a@example.com", at: 5, pi: "pi_1", given: 9 }))?.given, parsePreorder("{"), parsePreorder(JSON.stringify({ at: 1 }))], [9, null, null]);
  is("counted as waiting, handed over or refunded", preorderCounts([{ to: "a", at: 1, pi: "" }, { to: "b", at: 1, pi: "", given: 2 }, { to: "c", at: 1, pi: "", given: 2, revoked: 3 }]), { waiting: 1, given: 1, refunded: 1 });

  part("Paid while it is coming soon");
  await redis.pipeline([["SADD", `nl:wl:${STATS}:soon`, product.id]]);
  await setExpectedDay(store, product.id, "2026-11-20");
  is("the page reads coming soon and the day, in one request", await soonOne(store, product.id), { soon: true, day: "2026-11-20" });
  const state = await soonState(store);
  is("and the store page reads every product's", [state.soon.has(product.id), state.days.get(product.id)], [true, "2026-11-20"]);
  is("a receipt", await confirmPreorder(store, session(1, "ana@example.com"), product, deps), "sent");
  const receipt = emails.at(-1);
  is("with what, how much, and the day it is expected", [receipt?.subject, /Paid: \$25(\.00)?\n/.test(receipt?.text ?? ""), /expected on November 20, 2026/.test(receipt?.text ?? ""), /refunds you in full/.test(receipt?.text ?? "")], ["Your pre-order: The Bread Book", true, true, true]);
  is("written down, waiting", (await readPreorder(store, product.id, session(1, "").id))?.given, undefined);
  await confirmPreorder(store, session(2, "ben@example.com"), product, deps);
  await confirmPreorder(store, session(1, "ana@example.com"), product, deps);
  is("two waiting, the first kept once", await waitingCount(store, product.id), 2);

  part("Put on sale");
  await redis.pipeline([["SREM", `nl:wl:${STATS}:soon`, product.id]]);
  await queueRelease(store, product.id);
  is("its day is let go", (await soonOne(store, product.id)).day, null);
  refunded.add(session(2, "").payment_intent);
  const before = emails.length;
  const given = await runPreorderReleases(async () => store, async () => product, () => deps, Date.now() + 10_000);
  is("the one still paid is handed over; the refunded one is not", given, 1);
  const out = emails.slice(before);
  is("and its buyer is emailed the way in, once", out.map((e) => [([] as string[]).concat(e.to)[0], e.subject]), [["ana@example.com", "It is out: The Bread Book"]]);
  is("with the link to their purchases", out[0]?.text.includes("https://marktmorgen.com/@bakery/orders?for=ana%40example.com"), true);
  const [kept] = await redis.pipeline([["HGET", importedKey(STATS, "ana@example.com"), product.id]]);
  // The job says it does not ship, so the grant, which outlives the entry, keeps that (Claude 1's H on #2827).
  is("written down under their address, as not shipped", JSON.parse(String(kept)).job, `pre:${session(1, "").id}:d`);
  is("marked given, and the refunded one marked refunded", [Boolean((await readPreorder(store, product.id, session(1, "").id))?.given), Boolean((await readPreorder(store, product.id, session(2, "").id))?.revoked)], [true, true]);
  is("nothing left to hand over, and run again it sends nothing", [await waitingCount(store, product.id), await runPreorderReleases(async () => store, async () => product, () => deps, Date.now() + 10_000)], [0, 0]);

  part("Paid after it went on sale");
  is("handed over at once", await confirmPreorder(store, session(3, "cy@example.com"), product, deps), "given");
  is("and emailed the way in", emails.at(-1)?.subject, "It is out: The Bread Book");

  part("Refunded after it was handed over");
  refunds = [{ id: "re_preorder1", created: Math.floor(NOW / 1000), status: "succeeded", payment_intent: session(1, "").payment_intent, charge: { refunded: true } }];
  // The course first, then the purchase (Codex G on #2781; rule 30): a course removal that fails keeps the purchase,
  // so the next run takes both away again.
  await revokeRefundedPreorders(store, Date.now() + 10_000, async () => { throw new Error("the ledger did not answer"); }).catch(() => 0);
  is("a course removal that fails keeps the purchase for the next run", typeof (await redis.pipeline([["HGET", importedKey(STATS, "ana@example.com"), product.id]]))[0], "string");
  is("one taken back", await revokeRefundedPreorders(store, Date.now() + 10_000, async (email, id) => void dropped.push(`${email}|${id}`)), 1);
  const [gone, stays] = await redis.pipeline([["HGET", importedKey(STATS, "ana@example.com"), product.id], ["HGET", importedKey(STATS, "cy@example.com"), product.id]]);
  is("from its buyer only", [gone, typeof stays === "string"], [null, true]);
  is("its course start dropped too", dropped, ["ana@example.com|breadbook1"]);
  is("and the same refund is read once", await revokeRefundedPreorders(store, Date.now() + 10_000, async () => {}), 0);

  done();
}

void main();
