/**
 * The job that takes group places back (lib/group-buy.ts, revokeRefundedGroups) looks only at payments that paid for
 * a group purchase, and takes the places back on a dispute lost as on a full refund that succeeded (the owner's
 * decision 18 of 9 November 2026: access goes only when the refund succeeded or the dispute was lost).
 *
 * Before this, the check for a refund still on its way and the read of a charge's refunds (GET /refunds?charge=) ran
 * before the job knew whether the payment was a group purchase at all (pre-review of claude5/group-buy-cursor-account,
 * MEDIUM): a pending refund of an ordinary sale held the group anchor (one requiring action held it for weeks), was
 * said in the log as "a refund for a group purchase", and the parts of ordinary sales spent the run's charge lookups
 * (CHARGE_REFUND_LOOKUPS) before a group's own parts. And no lost dispute took anything back: the siblings (gifts,
 * pre-orders, license keys, call meetings, review proof) read lostDisputesOrRetry, this job did not. Checked against
 * a stand-in for the creator's Stripe account, through the real group journey (startGroup, settleGroup, askPlace,
 * takePlace):
 *
 *   - a pending refund of an ordinary sale never holds the anchor, and nothing is said about it as a group purchase;
 *   - a part refund of an ordinary sale asks Stripe nothing about its charge, and many of them never use up the
 *     lookups a group's own parts need in the same run;
 *   - a charge's refunds are read pinned to STRIPE_LIST_VERSION, as the store's refund pages are;
 *   - a group refund pending more than a week is said in the log at most once a payment a day;
 *   - a dispute closed as lost takes every place back and is marked handled; one won takes nothing; one still open
 *     takes nothing and holds nothing; a lost dispute on an ordinary sale is marked read and takes nothing;
 *   - a read of the closing events that fails takes nothing back and keeps the anchor where it was; the next run that
 *     reads them takes the places back.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Listing, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { askPlace, openGroup, revokeRefundedGroups, settleGroup, startGroup, takePlace } from "@/lib/group-buy";
import { importedFor } from "@/lib/imported-purchases";
import { STRIPE_LIST_VERSION } from "@/lib/stripe-list";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const NOW = Math.floor(Date.now() / 1000);
const BASE = "https://marktmorgen.com/@groupdisp";
const FROM = '"Group Disputes" <hello@marktmorgen.com>';

type Sent = { to: string[]; text: string };
const emails: Sent[] = [];
/** The store's refunds, newest first, as Stripe lists them. */
let refunds: Record<string, unknown>[] = [];
/** Closing events of disputes, newest first, as Stripe lists them. */
let closings: Record<string, unknown>[] = [];
let eventsFail = false;
/** Each charge whose refunds were asked for (GET /refunds?charge=), with the API version it was asked on. */
const chargesAsked: { charge: string; version: string | null }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/refunds" && (init?.method ?? "GET") === "GET" && url.searchParams.has("charge")) {
    const charge = url.searchParams.get("charge") ?? "";
    chargesAsked.push({ charge, version: new Headers(init?.headers).get("Stripe-Version") });
    const own = refunds.filter((r) => (r.charge as { id?: unknown } | null)?.id === charge);
    return answer({ object: "list", data: own.map((r) => ({ id: r.id, object: "refund", created: r.created, status: r.status, amount: r.amount, charge })), has_more: false });
  }
  if (path === "/refunds" && (init?.method ?? "GET") === "GET") {
    const limit = Number(url.searchParams.get("limit") ?? "10");
    const after = url.searchParams.get("starting_after");
    const since = Number(url.searchParams.get("created[gte]") ?? "0");
    const listed = refunds.filter((r) => typeof r.created === "number" && r.created >= since).sort((a, b) => (b.created as number) - (a.created as number));
    const from = after ? listed.findIndex((r) => r.id === after) + 1 : 0;
    return answer({ object: "list", data: listed.slice(from, from + limit), has_more: from + limit < listed.length });
  }
  if (path === "/events" && (init?.method ?? "GET") === "GET") {
    if (eventsFail) return answer({ error: { message: "rate limited" } }, 429);
    const after = url.searchParams.get("starting_after");
    const from = after ? closings.findIndex((e) => e.id === after) + 1 : 0;
    return answer({ object: "list", data: closings.slice(from, from + 100), has_more: from + 100 < closings.length });
  }
  return answer({ error: { message: `no stand-in for ${init?.method ?? "GET"} ${path}` } }, 404);
}) as typeof fetch;

/** One refund row, as /refunds lists it with its charge expanded (`back`: what the charge reads refunded). */
function row(id: string, created: number, status: string, pi: string, refunded: boolean, back = refunded ? 9800 : 0, amount = refunded ? 9800 : back): Record<string, unknown> {
  return { id, object: "refund", created, status, amount, payment_intent: pi, charge: { id: `ch_${pi.slice(3)}`, object: "charge", refunded, amount: 9800, amount_refunded: back } };
}

/** A dispute Stripe closed, as its charge.dispute.closed event. */
function closing(n: number, status: "lost" | "won", pi: string): Record<string, unknown> {
  return {
    id: `evt_grpclosed${String(n).padStart(8, "0")}`,
    object: "event",
    type: "charge.dispute.closed",
    created: NOW - 600 + n,
    data: { object: { object: "dispute", id: `dp_grp${String(n).padStart(10, "0")}`, status, amount: 9800, charge: `ch_${pi.slice(3)}`, payment_intent: pi } },
  };
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_group_disputes_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_groups_only";
  const OWNER = "groupdisp@example.com";
  await claimHandle(OWNER, "groupdisp", "Group Disputes", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1GroupDisp01", true);
  await setSubscription(OWNER, { customerId: "cus_GroupDisp001", subscriptionId: "sub_GroupDisp001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Sourdough Course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/course");
  const owner = async (): Promise<Store> => (await storeForEmail(OWNER))!;
  const product: Listing = (await readListing(await owner(), made.product.id))!;
  const sid = (await owner()).statsId!;
  const anchorNow = async () => (await redis.pipeline([["GET", `nl:grp:${sid}:refunds`]]))[0];
  const seen = async (id: string) => (await redis.pipeline([["SISMEMBER", `nl:grp:${sid}:seen`, id]]))[0];
  const run = async () => revokeRefundedGroups(await owner(), Date.now() + 30_000, async () => {});

  /** A group of two bought and both places taken; returns its id, its payment and how many places still hold it. */
  const make = async (k: number): Promise<{ id: string; pi: string; held: () => Promise<number> }> => {
    const store = await owner();
    const started = await startGroup(store, product, "2");
    if (!started.ok) throw new Error("no group");
    const id = started.group.id;
    const pi = `pi_GroupDisp0000${String(k).padStart(2, "0")}`;
    const session = { id: `cs_test_${String(k).padStart(24, "d")}`, created: NOW - 86_400, amount_total: 9800, currency: "usd", payment_intent: pi, metadata: { store: "groupdisp", product: product.id, group: id, people: "2" }, customer_details: { email: `buyer${k}@example.com` } };
    await settleGroup({ store, session, product, base: BASE, from: FROM });
    const people = [`ana${k}@example.com`, `ben${k}@example.com`];
    for (const email of people) {
      await askPlace({ store, id, email, product, base: BASE, from: FROM, ordersLink: async () => null });
      const token = emails.filter((e) => e.to[0] === email).at(-1)?.text.match(/\?take=([0-9a-f]{64})/)?.[1] ?? "";
      await takePlace({ store: await owner(), token, recordStart: async () => {} });
    }
    const held = async () => {
      let count = 0;
      for (const email of people) count += (await importedFor(await owner(), email)).length;
      return count;
    };
    if ((await held()) !== 2) throw new Error(`group ${k}: both places not taken`);
    return { id, pi, held };
  };

  const realError = console.error;
  const realNow = Date.now;
  const logged: string[] = [];
  const listen = () => {
    logged.length = 0;
    console.error = (...args: unknown[]) => void logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  const quiet = () => {
    console.error = realError;
  };

  // First, while the pass starts a week back: the refund is seen pending, then the clock moves on.
  part("a group refund pending more than a week is said in the log at most once a payment a day");
  const stuck = await make(3);
  const stuckAt = NOW - 6 * 86_400;
  refunds = [row("re_GdStuck00000001", stuckAt, "pending", stuck.pi, true)];
  is("stuck: nothing taken back while pending", await run(), 0);
  const said = () => logged.filter((l) => l.includes("pending for more than") && l.includes("re_GdStuck00000001")).length;
  listen();
  try {
    Date.now = () => realNow() + 2 * 86_400_000;
    for (let i = 0; i < 3; i += 1) await run();
    is("stuck: three runs in one day say it once", said(), 1);
    Date.now = () => realNow() + 3 * 86_400_000 + 60_000;
    await run();
    await run();
    is("stuck: a day later it is said once more", said(), 2);
    is("stuck: both places still hold it", await stuck.held(), 2);
  } finally {
    Date.now = realNow;
    quiet();
  }
  refunds = [row("re_GdStuck00000001", stuckAt, "succeeded", stuck.pi, true)];
  is("stuck: once it succeeded, both places are taken back", await run(), 2);

  part("a pending refund of an ordinary sale never holds the group anchor, and is never said to be a group purchase's");
  // Inside the read left by the part before (its anchor is the stuck refund's time), six days old, then eight.
  refunds = [row("re_GdNewest0000001", NOW - 10, "succeeded", "pi_GdOrdinary00009", true), row("re_GdOrdinary00001", NOW - 6 * 86_400 + 1000, "pending", "pi_GdOrdinary00001", true)];
  listen();
  try {
    await run();
    Date.now = () => realNow() + 2 * 86_400_000;
    await run();
  } finally {
    Date.now = realNow;
    quiet();
  }
  is("the anchor moves to the newest refund: an ordinary sale's pending refund holds nothing", await anchorNow(), String(NOW - 10));
  is("nothing is said as a group purchase's for a payment that is not one", logged.some((l) => l.includes("group purchase") && l.includes("re_GdOrdinary00001")), false);

  part("a part refund of an ordinary sale asks Stripe nothing about its charge");
  chargesAsked.length = 0;
  refunds = [row("re_GdPartOrd00001", NOW - 5, "succeeded", "pi_GdPartOrdinary1", true, 9800, 4900), row("re_GdPartOrd00002", NOW - 6, "pending", "pi_GdPartOrdinary1", true, 9800, 4900)];
  await run();
  is("no GET /refunds?charge= for a charge that paid for no group purchase", chargesAsked.map((c) => c.charge), []);

  part("many part refunds of ordinary sales never use up the lookups a group's own parts need");
  const parted = await make(2);
  chargesAsked.length = 0;
  const ordinary = Array.from({ length: 12 }, (_, i) => row(`re_GdManyOrd${String(i).padStart(6, "0")}`, NOW - 20 + i, "succeeded", `pi_GdManyOrd${String(i).padStart(6, "0")}`, true, 9800, 4900));
  refunds = [...ordinary, row("re_GdGroupPartB01", NOW - 40, "succeeded", parted.pi, true, 9800, 4900), row("re_GdGroupPartA01", NOW - 41, "succeeded", parted.pi, true, 9800, 4900)];
  is("both places of the group are taken back in the same run", await run(), 2);
  is("no place holds it any more", await parted.held(), 0);
  is("only the group's charge was asked about", [...new Set(chargesAsked.map((c) => c.charge))], [`ch_${parted.pi.slice(3)}`]);
  is("a charge's refunds are read pinned to the list version (STRIPE_LIST_VERSION)", chargesAsked.every((c) => c.version === STRIPE_LIST_VERSION), true);

  part("a dispute closed as lost takes every place back; one won or still open takes nothing");
  const lost = await make(4);
  const won = await make(5);
  const open = await make(6);
  refunds = [];
  closings = [closing(3, "lost", "pi_GdOrdinaryLost1"), closing(2, "won", won.pi), closing(1, "lost", lost.pi)];
  is("lost: both places of the lost dispute are taken back", await run(), 2);
  is("lost: no place holds it any more", await lost.held(), 0);
  is("lost: the purchase is closed", await openGroup(await owner(), lost.id), null);
  is("lost: the closing is marked handled", await seen("evt_grpclosed00000001"), 1);
  is("lost on an ordinary sale: marked read, nothing taken", await seen("evt_grpclosed00000003"), 1);
  is("won: both places still hold it", await won.held(), 2);
  is("open (no closing yet): both places still hold it", await open.held(), 2);
  is("read again, nothing is taken back twice", await run(), 0);

  part("a read of the closing events that fails takes nothing back and keeps the anchor; the next run does");
  const later = await make(7);
  const anchorBefore = await anchorNow();
  closings = [closing(9, "lost", later.pi), ...closings];
  refunds = [row("re_GdAfterFail0001", NOW - 2, "succeeded", "pi_GdOrdinaryFail1", true)];
  eventsFail = true;
  listen();
  try {
    is("events fail: nothing taken back", await run(), 0);
  } finally {
    quiet();
  }
  eventsFail = false;
  is("events fail: both places still hold it", await later.held(), 2);
  is("events fail: the anchor does not move past the closings not read", await anchorNow(), anchorBefore);
  is("the next run reads them and takes both places back", await run(), 2);
  is("and the anchor then moves to the newest refund", await anchorNow(), String(NOW - 2));

  // The first money review of #3410 (Claude 2, MEDIUM; Claude 6, M1): a sweep of the closing events that went on from a
  // kept place set the anchor to its newest closing, with nothing capping it at the newest refund the pass read, so a
  // group refund made during a pass of several runs, seen only on the newest page (whose holds never move the anchor),
  // fell out of the window while still pending. lib/gifts.ts and lib/preorders.ts cap it at the pass's newest.
  part("a pass of several runs whose disputes read went on from a kept place never moves the anchor past a group refund still pending");
  const late = await make(8);
  // More refunds than one run reads (10 pages of 100), and more lost closings than one run reads (3 pages of 100).
  const many = Array.from({ length: 1100 }, (_, i) => row(`re_GdMultiRun${String(i).padStart(6, "0")}`, NOW + 1 + i, "succeeded", `pi_GdMultiOrd${String(i).padStart(6, "0")}`, true));
  refunds = many;
  closings = Array.from({ length: 350 }, (_, i) => closing(1900 + 349 - i, "lost", `pi_GdMultiLost${String(i).padStart(5, "0")}`));
  is("multi-run: the first run reads 1,000 refunds and 300 closings, and ends nothing", await run(), 0);
  // Made during the pass, newest of all, and still on its way: only the newest page re-read shows it.
  const lateAt = NOW + 1200;
  refunds = [row("re_GdMultiLate0001", lateAt, "pending", late.pi, true), ...many];
  is("multi-run: the second run ends the pass and takes nothing back while it is pending", await run(), 0);
  is("multi-run: the anchor stays at or before the pending group refund (anchor - 300 <= its time)", Number(await anchorNow()) - 300 <= lateAt, true);
  refunds = [row("re_GdMultiLate0001", lateAt, "succeeded", late.pi, true), ...many];
  closings = [];
  let back = 0;
  for (let i = 0; i < 3; i += 1) back += await run();
  is("multi-run: once it succeeded, both places are taken back", [back, await late.held()], [2, 0]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
