/**
 * A refund that is not final yet never lets the group purchase pass it by (audit of refunds, A1: HIGH; the sibling
 * of 0cbcc276b1 on #3188, #3301 and #3302 for gifts and pre-orders).
 *
 * revokeRefundedGroups (lib/group-buy.ts) took a refund row back only when it read `succeeded` with its charge
 * marked refunded, answered "handled" for any other row without marking it read, and moved the anchor past every
 * row read. A full refund Stripe still listed as `pending` (the creator's balance short, or a slow payment method)
 * was skipped, and once any later refund of the store moved the anchor more than 300 s past it, it was never listed
 * again: the buyer had the money back and every place of the group kept its access. Checked against a stand-in for
 * the creator's Stripe account that honours created[gte], limit and starting_after, through the real group journey
 * (startGroup, settleGroup, askPlace, takePlace):
 *
 *   - a full refund listed as pending takes nothing back yet: it holds the anchor at its time, and the places go
 *     only once it succeeded (the owner's decision 18 of 9 November 2026: access is taken away only when the
 *     refund succeeded or the dispute was lost; failed or canceled, the access stays);
 *   - a full refund pending that then failed, or requiring action that was then canceled, takes nothing back and
 *     lets the anchor go on to the newest refund;
 *   - a refund still pending or requiring action whose charge is not yet refunded in full holds the anchor at its
 *     time, so a later refund never moves the read past it, and the places go once it went through;
 *   - a refund in parts (the sibling of #2868): a succeeded part on a charge read refunded in full takes nothing
 *     back while another refund of that charge is still on its way, nothing either when that one failed, and the
 *     places go once the succeeded parts add up to the whole charge; a charge whose refunds cannot be read takes
 *     nothing back and holds the anchor;
 *   - a refund pending for more than a week is said in the log, and still takes nothing back;
 *   - the same on a pass of two pages, with the refund not final yet on the second;
 *   - controls: a refund that failed or was canceled holds nothing, and a partial refund that went through takes
 *     nothing back.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Listing, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { askPlace, revokeRefundedGroups, settleGroup, startGroup, takePlace } from "@/lib/group-buy";
import { importedFor } from "@/lib/imported-purchases";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const NOW = Math.floor(Date.now() / 1000);
const BASE = "https://marktmorgen.com/@grouppend";
const FROM = '"Group Pending" <hello@marktmorgen.com>';

type Sent = { to: string[]; text: string };
const emails: Sent[] = [];
/** The store's refunds, newest first, as Stripe lists them. */
let refunds: Record<string, unknown>[] = [];
/** Each created[gte] the pass asked Stripe for. */
const asked: number[] = [];
/** Each charge whose refunds were asked for (GET /refunds?charge=). */
const chargesAsked: string[] = [];
/** Charges whose refunds the stand-in answers in a shape that does not read. */
const unreadableCharges = new Set<string>();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/refunds" && (init?.method ?? "GET") === "GET" && url.searchParams.has("charge")) {
    // One charge's refunds, as Stripe lists them without expanding: the charge as its id.
    const charge = url.searchParams.get("charge") ?? "";
    chargesAsked.push(charge);
    if (unreadableCharges.has(charge)) return answer({ object: "list", data: [{ id: "re_odd" }], has_more: false });
    const own = refunds.filter((r) => (r.charge as { id?: unknown } | null)?.id === charge);
    return answer({ object: "list", data: own.map((r) => ({ id: r.id, object: "refund", created: r.created, status: r.status, amount: r.amount, charge })), has_more: false });
  }
  if (path === "/refunds" && (init?.method ?? "GET") === "GET") {
    const limit = Number(url.searchParams.get("limit") ?? "10");
    const after = url.searchParams.get("starting_after");
    const since = Number(url.searchParams.get("created[gte]") ?? "0");
    asked.push(since);
    const listed = refunds.filter((row) => typeof row.created === "number" && row.created >= since).sort((a, b) => (b.created as number) - (a.created as number));
    const from = after ? listed.findIndex((row) => row.id === after) + 1 : 0;
    return answer({ object: "list", data: listed.slice(from, from + limit), has_more: from + limit < listed.length });
  }
  // The store's disputes closed (charge.dispute.closed, lib/refunds.ts lostDisputesSince): none, read to the end.
  if (path === "/events" && (init?.method ?? "GET") === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${init?.method ?? "GET"} ${path}` } }, 404);
}) as typeof fetch;

/**
 * One refund row, as /refunds lists it with its charge expanded: `amount` is the refund's own, `back` what the charge
 * reads refunded (Stripe counts a refund still pending in it).
 */
function row(id: string, created: number, status: string, pi: string, refunded: boolean, back = refunded ? 9800 : 0, amount = refunded ? 9800 : back): Record<string, unknown> {
  return { id, object: "refund", created, status, amount, payment_intent: pi, charge: { id: `ch_${pi.slice(3)}`, object: "charge", refunded, amount: 9800, amount_refunded: back } };
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_group_pending_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_groups_only";
  const OWNER = "grouppend@example.com";
  await claimHandle(OWNER, "grouppend", "Group Pending", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1GroupPend001", true);
  await setSubscription(OWNER, { customerId: "cus_GroupPend001", subscriptionId: "sub_GroupPend001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Sourdough Course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/course");
  const owner = async (): Promise<Store> => (await storeForEmail(OWNER))!;
  const product: Listing = (await readListing(await owner(), made.product.id))!;
  const sid = (await owner()).statsId!;
  const anchorNow = async () => (await redis.pipeline([["GET", `nl:grp:${sid}:refunds`]]))[0];
  const dropped: string[] = [];
  const run = async () => revokeRefundedGroups(await owner(), Date.now() + 30_000, async (email, productId) => void dropped.push(`${email}|${productId}`));

  /** A group of two bought and both places taken; returns its payment and how many of its places still hold it. */
  const make = async (k: number): Promise<{ pi: string; held: () => Promise<number> }> => {
    const store = await owner();
    const started = await startGroup(store, product, "2");
    if (!started.ok) throw new Error("no group");
    const id = started.group.id;
    const pi = `pi_GroupPend00000${k}`;
    const session = { id: `cs_test_${String(k).padStart(24, "p")}`, created: NOW - 86_400, amount_total: 9800, currency: "usd", payment_intent: pi, metadata: { store: "grouppend", product: product.id, group: id, people: "2" }, customer_details: { email: `buyer${k}@example.com` } };
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
    return { pi, held };
  };

  const base = NOW - 50_000;

  part("a full refund pending for more than a week is said in the log, and still takes nothing back");
  // Run first, while the pass starts a week back: the refund is seen pending, then the clock moves on.
  const stuck = await make(9);
  const stuckAt = NOW - 6 * 86_400;
  refunds = [row("re_GrpStuck000001", stuckAt, "pending", stuck.pi, true)];
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  const realNow = Date.now;
  try {
    is("stuck: nothing taken back while pending", await run(), 0);
    is("stuck: no week yet, nothing said", logged.some((l) => l.includes("re_GrpStuck000001")), false);
    Date.now = () => realNow() + 2 * 86_400_000;
    is("stuck: eight days pending, still nothing taken back", await run(), 0);
    is("stuck: both places still hold it", await stuck.held(), 2);
    is("stuck: the refund pending more than a week is said in the log", logged.some((l) => l.includes("pending for more than") && l.includes("re_GrpStuck000001")), true);
    is("stuck: the anchor keeps it inside the next read", Number(await anchorNow()) - 300 <= stuckAt, true);
  } finally {
    Date.now = realNow;
    console.error = realError;
  }
  refunds = [row("re_GrpStuck000001", stuckAt, "succeeded", stuck.pi, true)];
  is("stuck: once it succeeded, both places are taken back", await run(), 2);

  // Rule 23: until 26ae3996c3 a full refund listed as pending took the places back at once (rowGivesBack). The owner's
  // decision 18 (9 November 2026) reverses it: nothing goes until the refund succeeded, so these assertions now say
  // the places stay while it is pending, and go only once it succeeded.
  part("a full refund listed as pending takes nothing back until it succeeded");
  const pending = await make(1);
  refunds = [row("re_GrpPend0000001", base, "pending", pending.pi, true)];
  is("the pending full refund takes nothing back yet", await run(), 0);
  is("both places still hold it", await pending.held(), 2);
  is("the pending full refund holds the anchor at its time", Number(await anchorNow()) - 300 <= base, true);
  refunds = [row("re_GrpPend0000001", base, "succeeded", pending.pi, true)];
  is("once it succeeded, both places are taken back", await run(), 2);
  is("no place holds it any more", await pending.held(), 0);

  for (const [k, from, to] of [[10, "pending", "failed"], [11, "requires_action", "canceled"]] as const) {
    part(`a full refund ${from} that is then ${to} takes nothing back and lets the anchor go on`);
    const item = await make(k);
    const at = base + 100 * k;
    refunds = [row(`re_GrpNext0000${k}`, at + 50, "succeeded", `pi_GrpNextOther0${k}`, true), row(`re_GrpFull0000${k}`, at, from, item.pi, true)];
    is(`${from}: nothing taken back while it is on its way`, await run(), 0);
    is(`${from}: the anchor keeps it inside the next read`, Number(await anchorNow()) - 300 <= at, true);
    // Stripe gives the money back to the creator's balance: the charge no longer reads refunded.
    refunds = [refunds[0], row(`re_GrpFull0000${k}`, at, to, item.pi, false, 0, 9800)];
    is(`${to}: nothing taken back`, await run(), 0);
    is(`${to}: both places still hold it`, await item.held(), 2);
    is(`${to}: with nothing on its way, the anchor moves to the newest refund`, await anchorNow(), String(at + 50));
  }

  for (const [k, status] of [[2, "pending"], [3, "requires_action"]] as const) {
    part(`a refund ${status} whose charge is not refunded yet holds the anchor until it goes through`);
    const item = await make(k);
    const at = base + 1000 * k;
    refunds = [row(`re_GrpLate000000${k}`, at + 900, "succeeded", `pi_GrpOther00000${k}`, true), row(`re_GrpWait000000${k}`, at, status, item.pi, false)];
    is(`${status}: nothing taken back while it has not gone through`, await run(), 0);
    is(`${status}: both places still hold it`, await item.held(), 2);
    const anchor = Number(await anchorNow());
    is(`${status}: the anchor keeps the refund inside the next read (anchor - 300 <= its time)`, anchor - 300 <= at, true);
    is(`${status}: a second run, still not final, keeps it inside the read too`, [await run(), Number(await anchorNow()) - 300 <= at], [0, true]);
    // Stripe finishes it: same id and time, now succeeded with its charge refunded in full.
    refunds = [refunds[0], row(`re_GrpWait000000${k}`, at, "succeeded", item.pi, true)];
    is(`${status}: once it went through, both places are taken back`, await run(), 2);
    is(`${status}: no place holds it any more`, await item.held(), 0);
    is(`${status}: with nothing left waiting, the anchor moves to the newest refund`, await anchorNow(), String(at + 900));
  }

  part("a refund in parts: a succeeded part takes nothing back while the rest of the charge is on its way");
  for (const [k, ending] of [[6, "failed"], [7, "succeeded"]] as const) {
    const item = await make(k);
    const at = base + 4000 + 100 * k;
    const first = row(`re_GrpPartA000${k}`, at, "succeeded", item.pi, true, 9800, 4900);
    refunds = [row(`re_GrpPartB000${k}`, at + 10, "pending", item.pi, true, 9800, 4900), first];
    is(`parts ${k}: half succeeded, half pending: nothing taken back`, await run(), 0);
    is(`parts ${k}: both places still hold it`, await item.held(), 2);
    is(`parts ${k}: the anchor keeps them inside the next read`, Number(await anchorNow()) - 300 <= at, true);
    if (ending === "failed") {
      refunds = [row(`re_GrpPartB000${k}`, at + 10, "failed", item.pi, false, 4900, 4900), row(`re_GrpPartA000${k}`, at, "succeeded", item.pi, false, 4900, 4900)];
      is("parts: the other half failed: nothing taken back", await run(), 0);
      is("parts: both places still hold it", await item.held(), 2);
      is("parts: with nothing on its way, the anchor moves to the newest refund", await anchorNow(), String(at + 10));
    } else {
      refunds = [row(`re_GrpPartB000${k}`, at + 10, "succeeded", item.pi, true, 9800, 4900), first];
      is("parts: both halves succeeded: both places are taken back", await run(), 2);
      is("parts: no place holds it any more", await item.held(), 0);
      is("parts: the charge's refunds were read to say so", chargesAsked.includes(`ch_${item.pi.slice(3)}`), true);
    }
  }

  part("a refund in parts whose charge's refunds do not read takes nothing back and holds the anchor");
  const odd = await make(8);
  const oddAt = base + 5000;
  unreadableCharges.add(`ch_${odd.pi.slice(3)}`);
  refunds = [row("re_GrpOddB0000001", oddAt + 10, "succeeded", odd.pi, true, 9800, 4900), row("re_GrpOddA0000001", oddAt, "succeeded", odd.pi, true, 9800, 4900)];
  is("unreadable: nothing taken back", await run(), 0);
  is("unreadable: both places still hold it", await odd.held(), 2);
  is("unreadable: the anchor keeps them inside the next read", Number(await anchorNow()) - 300 <= oddAt, true);
  unreadableCharges.clear();
  is("unreadable: once the charge's refunds read and add up, both places are taken back", await run(), 2);

  part("a refund in parts whose read mark does not read is held, never kept to be taken back later");
  const flaky = await make(12);
  const flakyAt = base + 5500;
  const half = row("re_GrpFlakyA000001", flakyAt, "succeeded", flaky.pi, true, 9800, 4900);
  refunds = [row("re_GrpFlakyB000001", flakyAt + 10, "pending", flaky.pi, true, 9800, 4900), half];
  const realPipeline = redis.pipeline.bind(redis);
  // The read mark answers in another shape for this run only: the succeeded half is left unknown before it was read through.
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await realPipeline(commands);
    return commands.map((c, i) => (c[0] === "SISMEMBER" ? "garbled" : replies[i]));
  }) as typeof redis.pipeline;
  try {
    is("flaky: nothing taken back", await run(), 0);
  } finally {
    redis.pipeline = realPipeline;
  }
  is("flaky: nothing kept on the retry list as taken back", (await redis.pipeline([["HLEN", `nl:grp:${sid}:refunds:retry`]]))[0], 0);
  // The other half failed: the half that succeeded is not the whole charge, and nothing goes.
  refunds = [row("re_GrpFlakyB000001", flakyAt + 10, "failed", flaky.pi, false, 4900, 4900), row("re_GrpFlakyA000001", flakyAt, "succeeded", flaky.pi, false, 4900, 4900)];
  is("flaky: the other half failed: nothing taken back", await run(), 0);
  is("flaky: both places still hold it", await flaky.held(), 2);

  part("a pass of two pages: a refund not final yet on the second page holds the anchor too");
  const paged = await make(4);
  const at = base + 6000;
  const others = Array.from({ length: 105 }, (_, i) => row(`re_GrpMany${String(i).padStart(6, "0")}`, at + 600 + i, "succeeded", `pi_GrpMany${String(i).padStart(6, "0")}`, true));
  refunds = [...others, row("re_GrpPaged000001", at, "pending", paged.pi, false)];
  is("two pages: nothing taken back while it has not gone through", await run(), 0);
  is("two pages: the anchor keeps the refund inside the next read", Number(await anchorNow()) - 300 <= at, true);
  refunds = [...others, row("re_GrpPaged000001", at, "succeeded", paged.pi, true)];
  is("two pages: once it went through, both places are taken back", await run(), 2);
  is("two pages: the anchor moves to the newest refund", await anchorNow(), String(at + 600 + 104));

  part("controls: a refund failed or canceled holds nothing, and a partial refund takes nothing back");
  const kept = await make(5);
  const late = base + 9000;
  refunds = [
    row("re_GrpCtrl000003", late + 900, "succeeded", "pi_GrpOtherCtrl01", true),
    row("re_GrpCtrl000002", late + 10, "succeeded", kept.pi, false, 1000, 1000),
    row("re_GrpCtrl000001", late + 5, "failed", kept.pi, false),
    row("re_GrpCtrl000000", late, "canceled", kept.pi, false),
  ];
  is("controls: nothing taken back", await run(), 0);
  is("controls: both places still hold it", await kept.held(), 2);
  is("controls: the anchor moves to the newest refund", await anchorNow(), String(late + 900));
  // The second money review of #3410 (Claude 3, MEDIUM): every succeeded part of a charge with a part still on its way
  // spent one of the run's CHARGE_REFUND_LOOKUPS on every run, so ten newer such charges took the whole budget, run
  // after run, and an older charge refunded in full in parts was never asked about: its places stayed.
  part("ten newer charges with a part on its way never starve an older charge refunded in full in parts");
  const busy: { pi: string; held: () => Promise<number> }[] = [];
  for (let k = 20; k < 30; k += 1) busy.push(await make(k));
  const older = await make(30);
  const t0 = base + 10_000;
  refunds = [
    ...busy.flatMap((item, i) => [
      row(`re_GrpBusyA0000${20 + i}`, t0 + 100 + 10 * i + 5, "succeeded", item.pi, true, 9800, 4900),
      row(`re_GrpBusyB0000${20 + i}`, t0 + 100 + 10 * i, "pending", item.pi, true, 9800, 4900),
    ]),
    row("re_GrpOlderB00001", t0 + 1, "succeeded", older.pi, true, 9800, 4900),
    row("re_GrpOlderA00001", t0, "succeeded", older.pi, true, 9800, 4900),
  ];
  const olderCharge = `ch_${older.pi.slice(3)}`;
  const askedOf = (charge: string) => chargesAsked.filter((c) => c === charge).length;
  let taken = 0;
  for (let i = 0; i < 2; i += 1) taken += await run();
  is("starved: within two runs the older charge's places are taken back", [taken, await older.held()], [2, 0]);
  is("starved: its two parts asked Stripe about its charge once", askedOf(olderCharge), 1);
  is("starved: the newer charges still hold both places each", (await Promise.all(busy.map((item) => item.held()))).every((n) => n === 2), true);
  const busyCharge = `ch_${busy[0].pi.slice(3)}`;
  const before = askedOf(busyCharge);
  await run();
  is("starved: a charge found with a part on its way is not asked again at once", askedOf(busyCharge), before);
  const clock = Date.now;
  try {
    Date.now = () => clock() + 3_700_000;
    await run();
  } finally {
    Date.now = clock;
  }
  is("starved: it is asked again once the recheck time passed", askedOf(busyCharge) > before, true);
  is("every created[gte] asked is a whole second", asked.every((s) => Number.isSafeInteger(s)), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
