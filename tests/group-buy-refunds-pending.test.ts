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
 *   - a full refund listed as pending takes the places back at once, as the shared rule rowGivesBack()
 *     (lib/refunds.ts) reads it for the other jobs, and as gifts and pre-orders do;
 *   - a refund still pending or requiring action whose charge is not yet refunded in full holds the anchor at its
 *     time, so a later refund never moves the read past it, and the places go once it went through;
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

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/refunds" && (init?.method ?? "GET") === "GET") {
    const limit = Number(url.searchParams.get("limit") ?? "10");
    const after = url.searchParams.get("starting_after");
    const since = Number(url.searchParams.get("created[gte]") ?? "0");
    asked.push(since);
    const listed = refunds.filter((row) => typeof row.created === "number" && row.created >= since).sort((a, b) => (b.created as number) - (a.created as number));
    const from = after ? listed.findIndex((row) => row.id === after) + 1 : 0;
    return answer({ object: "list", data: listed.slice(from, from + limit), has_more: from + limit < listed.length });
  }
  return answer({ error: { message: `no stand-in for ${init?.method ?? "GET"} ${path}` } }, 404);
}) as typeof fetch;

/** One refund row, as /refunds lists it with its charge expanded. */
function row(id: string, created: number, status: string, pi: string, refunded: boolean, back = refunded ? 9800 : 0): Record<string, unknown> {
  return { id, object: "refund", created, status, payment_intent: pi, charge: { object: "charge", refunded, amount: 9800, amount_refunded: back } };
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_group_pending_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_groups_only";
  const OWNER = "grouppend@example.com";
  await claimHandle(OWNER, "grouppend", "Group Pending", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1GroupPending001", true);
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

  part("a full refund listed as pending takes the places back at once");
  const pending = await make(1);
  refunds = [row("re_GrpPend0000001", base, "pending", pending.pi, true)];
  is("the pending full refund takes both places back", await run(), 2);
  is("no place holds it any more", await pending.held(), 0);

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
    row("re_GrpCtrl000002", late + 10, "succeeded", kept.pi, false, 1000),
    row("re_GrpCtrl000001", late + 5, "failed", kept.pi, false),
    row("re_GrpCtrl000000", late, "canceled", kept.pi, false),
  ];
  is("controls: nothing taken back", await run(), 0);
  is("controls: both places still hold it", await kept.held(), 2);
  is("controls: the anchor moves to the newest refund", await anchorNow(), String(late + 900));
  is("every created[gte] asked is a whole second", asked.every((s) => Number.isSafeInteger(s)), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
