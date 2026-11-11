/**
 * 611 [WP10], unit 4e: a buyer's private podcast (lib/podcast-access.ts,
 * mayListen: the feed, each episode and the "send me the link" form) follows
 * the index of moved addresses (lib/purchase-move-index.ts), as the emails
 * kept for members do since unit 4b.
 *
 * With a stand-in Stripe account answering by address: after a move, the new
 * address listens to what the old one bought and the old one no longer
 * does; no room to read an old address is unknown, never "holds none"; an
 * index that cannot be read changes nothing (the old address keeps what it
 * bought, the new one gains nothing from it), never "nothing"; the store
 * deleting the move gives the old address its listening back; and at most
 * MAX_MOVED_INTO old addresses are asked about. The creator always listens.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { mayListen } from "@/lib/podcast-access";
import { askPurchaseMove, confirmPurchaseMove } from "@/lib/purchase-moves";
import { MAX_MOVED_INTO, applyPurchaseMove, forgetMovedPerson } from "@/lib/purchase-move-index";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_orders_only_a_stand_in";
process.env.STRIPE_SECRET_KEY = "sk_test_purchase_move_only_a_stand_in";

const HANDLE = "movecast";
const NOW = Math.floor(Date.now() / 1000);

/** Paid checkouts by the address they were paid with, as the creator's Stripe account lists them. */
const sessions: Record<string, Record<string, unknown>[]> = {};
/** The addresses Stripe was asked about. */
const asked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname.includes("resend")) return answer({ id: "00000000-0000-4000-8000-000000000000" });
  void init;
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") {
    const email = url.searchParams.get("customer_details[email]") ?? "";
    asked.push(email);
    return answer({ object: "list", data: sessions[email] ?? [], has_more: false });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const paid = (id: string, product: string) => ({
  id: `cs_test_${id.padStart(24, "0")}`,
  object: "checkout.session",
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created: NOW - 86_400,
  customer: "cus_TestMover0001",
  metadata: { store: HANDLE, product },
  payment_intent: { id: `pi_test${id.padStart(10, "0")}`, latest_charge: { object: "charge", amount: 4900, amount_refunded: 0, refunded: false } },
});

/** Answers `reply` to `command` on keys starting with `prefix`, the next `times` times. */
let odd: { command: string; prefix: string; reply: unknown; times: number } | null = null;
const run = redis.run.bind(redis);
redis.run = (c: (string | number)[]) => {
  if (odd && odd.times > 0 && String(c[0]).toUpperCase() === odd.command && String(c[1]).startsWith(odd.prefix)) {
    odd.times -= 1;
    return odd.reply;
  }
  return run(c);
};

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "move.cast.owner@example.com";
  await claimHandle(OWNER, HANDLE, "Move Cast", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_movecast", subscriptionId: "sub_movecast", active: true, tier: "pro", period: paidPeriod() });
  await setStripeAccount(OWNER, "acct_1TestMoveCast01", true);
  const show = await addProduct(OWNER, "Bread Talk", "", "49", null);
  const other = await addProduct(OWNER, "Knife Talk", "", "29", null);
  if (!show.ok || !other.ok) throw new Error("no products");
  const store = (await storeForEmail(OWNER)) as Store;
  const listens = async (address: string, product = show.product.id) => {
    try {
      return await mayListen(store, product, address);
    } catch {
      return "unknown";
    }
  };
  const move = async (from: string, to: string) => {
    const made = await askPurchaseMove({ from, to, scope: store.sid });
    if (!made.ok) throw new Error(`not asked: ${made.reason}`);
    for (const token of [made.fromToken, made.toToken]) {
      const confirmed = await confirmPurchaseMove(token);
      if (!confirmed.ok) throw new Error(`not confirmed: ${confirmed.reason}`);
    }
    return made.id;
  };

  sessions["ana.old@example.com"] = [paid("1", show.product.id)];
  sessions["ana.new@example.com"] = [paid("2", other.product.id)];

  part("Before the move");
  is("the old address listens", await listens("ana.old@example.com"), true);
  is("the new one does not", await listens("ana.new@example.com"), false);
  is("the new one listens to what it bought itself", await listens("ana.new@example.com", other.product.id), true);
  is("the creator always listens", await listens(OWNER), true);

  part("After the move");
  const id = await move("ana.old@example.com", "ana.new@example.com");
  is("moved", (await applyPurchaseMove(store, id)).state, "moved");
  is("the new address listens to what the old one bought", await listens("Ana.New@example.com"), true);
  is("and still to what it bought itself", await listens("ana.new@example.com", other.product.id), true);
  is("the old address no longer does, though its answer was kept for minutes", await listens("ana.old@example.com"), false);

  odd = { command: "INCRBY", prefix: "nl:traffic:r:", reply: "not a count", times: 1 };
  is("no room to read the old address: unknown, never \"holds none\"", await listens("ana.new@example.com"), "unknown");
  odd = null;

  part("An index that cannot be read changes nothing, and is never read as nothing");
  odd = { command: "GET", prefix: "nl:pm:moved:", reply: 7, times: 1 };
  is("the old address keeps what it bought", await listens("ana.old@example.com"), true);
  odd = { command: "HGETALL", prefix: "nl:pm:into:", reply: ["odd"], times: 1 };
  is("the new address gains nothing from it", await listens("ana.new@example.com"), false);
  odd = { command: "HGETALL", prefix: "nl:pm:into:", reply: ["odd"], times: 1 };
  is("and keeps what it bought itself", await listens("ana.new@example.com", other.product.id), true);
  odd = null;

  part("The store deleting the new address gives the old one its listening back");
  await forgetMovedPerson(store, "ana.new@example.com");
  is("the old address listens again", await listens("ana.old@example.com"), true);
  is("the deleted one does not", await listens("ana.new@example.com"), false);

  part(`At most MAX_MOVED_INTO (${MAX_MOVED_INTO}) old addresses are asked about`);
  const into = "cy.new@example.com";
  for (let i = 0; i < MAX_MOVED_INTO; i += 1) is(`move ${i + 1}`, (await applyPurchaseMove(store, await move(`cy.old${i}@example.com`, into))).state, "moved");
  asked.length = 0;
  for (const key of redis.keys().filter((k) => k.startsWith("nl:pod:ok:"))) redis.run(["DEL", key]);
  await listens(into);
  is("Stripe is asked about the new address and its old ones only", asked.length <= MAX_MOVED_INTO + 1, true);

  done();
}

void main();
