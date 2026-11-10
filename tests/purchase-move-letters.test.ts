/**
 * 611 [WP10], unit 4b: the first reader of a buyer's purchases that follows
 * the index of moved addresses (lib/purchase-move-index.ts) is the email
 * kept for members (lib/letter-access.ts, holdsLetter).
 *
 * What is checked, with a stand-in Stripe account answering by address:
 * after a move, the new address reads what the old one bought and the old
 * one no longer does; a mark without its line moves nothing; an index that
 * cannot be read changes nothing (the old address keeps what it bought, the
 * new one gains nothing from it, and keeps what it bought itself), never
 * "nothing"; the store deleting the move gives the old address its reading
 * back; and at most MAX_MOVED_INTO old addresses are asked about, as the
 * index never holds more for one address.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { holdsLetter } from "@/lib/letter-access";
import type { Letter } from "@/lib/letter-rules";
import { askPurchaseMove, confirmPurchaseMove } from "@/lib/purchase-moves";
import { MAX_MOVED_INTO, applyPurchaseMove, forgetMovedPerson } from "@/lib/purchase-move-index";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_orders_only_a_stand_in";
process.env.STRIPE_SECRET_KEY = "sk_test_purchase_move_only_a_stand_in";

const HANDLE = "moveclub";
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
  const OWNER = "move.club.owner@example.com";
  await claimHandle(OWNER, HANDLE, "Move Club", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_moveclub", subscriptionId: "sub_moveclub", active: true, tier: "pro", period: paidPeriod() });
  await setStripeAccount(OWNER, "acct_1TestMoveClub01", true);
  const club = await addProduct(OWNER, "Butter Club", "", "49", null);
  const knives = await addProduct(OWNER, "Knife Skills", "", "29", null);
  if (!club.ok || !knives.ok) throw new Error("no products");
  const store = (await storeForEmail(OWNER)) as Store;
  const letter = (id: string, product: string): Letter => ({ id: id.padStart(24, "0"), sid: store.sid, subject: "For members", body: "Members only.", sentAt: 1, publishedAt: 1, products: [product] });
  const clubLetter = letter("c1", club.product.id);
  const knifeLetter = letter("k1", knives.product.id);
  const reads = async (address: string, which = clubLetter) => {
    try {
      return await holdsLetter(store, which, address);
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

  sessions["ana.old@example.com"] = [paid("1", club.product.id)];
  sessions["ana.new@example.com"] = [paid("2", knives.product.id)];

  part("Before the move");
  is("the old address reads the club's email", await reads("ana.old@example.com"), true);
  is("the new one does not", await reads("ana.new@example.com"), false);
  is("the new one reads what it bought itself", await reads("ana.new@example.com", knifeLetter), true);

  part("After the move");
  const id = await move("ana.old@example.com", "ana.new@example.com");
  is("moved", (await applyPurchaseMove(store, id)).state, "moved");
  is("the new address reads what the old one bought", await reads("Ana.New@example.com"), true);
  is("and still what it bought itself", await reads("ana.new@example.com", knifeLetter), true);
  is("the old address no longer reads it, though its answer was kept for minutes", await reads("ana.old@example.com"), false);

  odd = { command: "INCRBY", prefix: "nl:traffic:r:", reply: "not a count", times: 1 };
  is("no room to read the old address: unknown, never \"holds none\"", await reads("ana.new@example.com"), "unknown");
  odd = null;

  part("An index that cannot be read changes nothing, and is never read as nothing");
  odd = { command: "GET", prefix: "nl:pm:moved:", reply: 7, times: 1 };
  is("the old address keeps what it bought", await reads("ana.old@example.com"), true);
  odd = { command: "HGETALL", prefix: "nl:pm:into:", reply: ["odd"], times: 1 };
  is("the new address gains nothing from it", await reads("ana.new@example.com"), false);
  odd = { command: "HGETALL", prefix: "nl:pm:into:", reply: ["odd"], times: 1 };
  is("and keeps what it bought itself", await reads("ana.new@example.com", knifeLetter), true);
  odd = null;

  part("A mark without its line moves nothing");
  sessions["bo.old@example.com"] = [paid("3", club.product.id)];
  const half = await move("bo.old@example.com", "bo.new@example.com");
  odd = { command: "HSET", prefix: "nl:pm:into:", reply: "QUEUED", times: 1 };
  is("stopped midway", (await applyPurchaseMove(store, half)).state, "unknown");
  odd = null;
  is("the old address still reads", await reads("bo.old@example.com"), true);
  is("the new one not yet", await reads("bo.new@example.com"), false);
  is("finished on the next try", (await applyPurchaseMove(store, half)).state, "moved");
  is("now the new one reads, the old one not", [await reads("bo.new@example.com"), await reads("bo.old@example.com")], [true, false]);

  part("The store deleting the new address gives the old one its reading back");
  await forgetMovedPerson(store, "ana.new@example.com");
  is("the old address reads again", await reads("ana.old@example.com"), true);
  is("the deleted one does not", await reads("ana.new@example.com"), false);

  part(`At most MAX_MOVED_INTO (${MAX_MOVED_INTO}) old addresses are asked about`);
  const into = "cy.new@example.com";
  for (let i = 0; i < MAX_MOVED_INTO; i += 1) is(`move ${i + 1}`, (await applyPurchaseMove(store, await move(`cy.old${i}@example.com`, into))).state, "moved");
  is("one more is refused", (await applyPurchaseMove(store, await move("cy.extra@example.com", into))).state, "too-many");
  asked.length = 0;
  for (const key of redis.keys().filter((k) => k.startsWith("nl:letters:ok:"))) redis.run(["DEL", key]);
  await reads(into);
  is("Stripe is asked about the new address and its old ones only", asked.length <= MAX_MOVED_INTO + 1, true);

  part("An address that received moved purchases does not move again");
  sessions["di.old@example.com"] = [paid("4", club.product.id)];
  is("moved in", (await applyPurchaseMove(store, await move("di.old@example.com", "di.mid@example.com"))).state, "moved");
  is("moving it on is refused, so nothing is lost on the way", (await applyPurchaseMove(store, await move("di.mid@example.com", "di.far@example.com"))).state, "holds-moved");
  is("the address it moved to still reads", await reads("di.mid@example.com"), true);

  done();
}

void main();
