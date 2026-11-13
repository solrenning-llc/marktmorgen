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
import { mayListen, sendFeedLink } from "@/lib/podcast-access";
import { takePublicRequest } from "@/lib/traffic";
import { answering } from "./security/next-headers";
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
/** Addresses whose Stripe reading fails. */
const failing = new Set<string>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname.includes("resend")) return answer({ id: "00000000-0000-4000-8000-000000000000" });
  void init;
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") {
    const email = url.searchParams.get("customer_details[email]") ?? "";
    asked.push(email);
    if (failing.has(email)) return answer({ error: { message: "a stand-in outage" } }, 500);
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
/** From the `after`-th INCRBY on the store's request count on, the count answers far over any window. */
let fullAfter: number | null = null;
let takes = 0;
const run = redis.run.bind(redis);
redis.run = (c: (string | number)[]) => {
  if (fullAfter !== null && String(c[0]).toUpperCase() === "INCRBY" && String(c[1]).startsWith("nl:traffic:r:")) {
    takes += 1;
    if (takes >= fullAfter) return 1_000_000_000;
  }
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

  part("An index that cannot be read is unknown: never access given back, never a definite no (Claude 1 on #3717)");
  odd = { command: "GET", prefix: "nl:pm:moved:", reply: 7, times: 1 };
  is("the old address's mark unreadable: unknown, never its listening back", await listens("ana.old@example.com"), "unknown");
  odd = { command: "HGETALL", prefix: "nl:pm:into:", reply: ["odd"], times: 1 };
  is("the new address's index unreadable: unknown, never \"holds none\"", await listens("ana.new@example.com"), "unknown");
  odd = { command: "HGETALL", prefix: "nl:pm:into:", reply: ["odd"], times: 1 };
  is("what it bought itself needs no index read", await listens("ana.new@example.com", other.product.id), true);
  odd = { command: "HGET", prefix: "nl:pm:into:", reply: "not-a-move-id", times: 1 };
  is("a back line that is not a move id: unknown, never \"not moved\"", await listens("ana.old@example.com"), "unknown");
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

  part("A feed and an episode are asked by the app maker's servers: the store's shared room, never one connection's share (Claude 1 and Codex H2 on #3717)");
  sessions["dee.old@example.com"] = [paid("3", show.product.id)];
  is("dee moved", (await applyPurchaseMove(store, await move("dee.old@example.com", "dee.new@example.com"))).state, "moved");
  const app = new Request("https://example.com/feed", { headers: { "x-forwarded-for": "198.51.100.7" } });
  answering(app);
  // The app server's share of the day used up: its own requests are refused from here on.
  odd = { command: "HINCRBY", prefix: "nl:traffic:c:", reply: 1_000_000_000, times: 1_000 };
  let spent = false;
  for (let i = 0; i < 2_000 && !spent; i += 1) spent = !(await takePublicRequest(store, "buyer", Date.now(), 1));
  odd = null;
  is("the app server's own share is spent", spent, true);
  for (const key of redis.keys().filter((k) => k.startsWith("nl:pod:ok:"))) redis.run(["DEL", key]);
  let feed: boolean | "unknown";
  try {
    feed = await mayListen(store, show.product.id, "dee.new@example.com", { shared: true });
  } catch {
    feed = "unknown";
  }
  is("the moved buyer's feed through that server still lists the podcast", feed, true);
  answering(null);

  part("The \"send me the link\" form answers the same for a buyer and a stranger when the room runs out (Claude 1 and Codex H2 on #3717)");
  sessions["eve@example.com"] = [paid("4", show.product.id)];
  const form = async (email: string, ip: string) => {
    for (const key of redis.keys().filter((k) => k.startsWith("nl:pod:ok:"))) redis.run(["DEL", key]);
    takes = 0;
    fullAfter = 2;
    try {
      return await sendFeedLink({ store, product: show.product, email, ip, base: "https://movecast.example", from: "Move Cast <hello@example.com>" }).catch(() => "error");
    } finally {
      fullAfter = null;
    }
  };
  is("a buyer: sent", await form("eve@example.com", "203.0.113.1"), "sent");
  is("a stranger: sent too, never an answer that tells them apart", await form("stranger@example.com", "203.0.113.2"), "sent");

  part("An old address whose purchases cannot be read is unknown, never \"holds none\" (Claude 1 and Codex H2 on #3717, LEVE)");
  sessions["fay.old@example.com"] = [paid("5", show.product.id)];
  is("fay moved", (await applyPurchaseMove(store, await move("fay.old@example.com", "fay.new@example.com"))).state, "moved");
  for (const key of redis.keys().filter((k) => k.startsWith("nl:pod:ok:"))) redis.run(["DEL", key]);
  failing.add("fay.old@example.com");
  is("Stripe failing for the old address: unknown", await listens("fay.new@example.com"), "unknown");
  failing.delete("fay.old@example.com");
  is("and once it answers, the new address listens", await listens("fay.new@example.com"), true);

  done();
}

void main();
