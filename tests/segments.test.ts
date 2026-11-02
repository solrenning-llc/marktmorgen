/**
 * Saved groups and the three ways to narrow an email by money
 * (lib/segments.ts, lib/segments-rules.ts; added 12 October 2026). Checked:
 *
 *   - only an amount, a channel name and one of the offered day counts are
 *     taken from a request;
 *   - the store's buyers are read from its sales, each address once whatever
 *     its capitals, with an extra after a checkout in its buyer's money,
 *     support payments and other currencies left out, and where each first
 *     came from; the reading is kept so the next count asks Stripe nothing;
 *   - "spent at least", "first found you through" and "has not bought in"
 *     keep the right people, and only buyers;
 *   - a list narrowed that way keeps only them;
 *   - a group is saved under a name, the same name replaces it, an empty one
 *     is refused, and it can be removed.
 */
import { NO_NARROW, buyerLedger, isNarrowed, keeps, ledgerChannels, listSegments, readNarrow, removeSegment, saveSegment } from "@/lib/segments";
import { audience, leadsKey } from "@/lib/contacts";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const DAY = 86_400;
const now = Math.floor(NOW / 1000);
let stripeCalls = 0;

const session = (id: string, email: string, daysAgo: number, cents: number, meta: Record<string, string> = {}, currency = "usd") => ({
  id: `cs_test_${id.padEnd(12, "0")}`,
  status: "complete",
  payment_status: "paid",
  created: now - daysAgo * DAY,
  amount_total: cents,
  currency,
  customer_details: { email },
  payment_intent: `pi_${id.padEnd(14, "0")}`,
  metadata: { store: "bakery", product: "p1", ...meta },
});

const sessions = [
  session("ana1", "Ana@Example.com", 200, 20000, { channel: "instagram" }),
  session("ana2", "ana@example.com", 10, 5000, { channel: "youtube" }),
  session("ben1", "ben@example.com", 120, 3000, { channel: "tiktok" }),
  session("cy01", "cy@example.com", 5, 9000),
  session("tip1", "dee@example.com", 3, 50000, { kind: "tip" }),
  session("eur1", "eve@example.com", 3, 50000, {}, "eur"),
  session("oth1", "fay@example.com", 3, 50000, { store: "somebody-else" }),
];
const intents = [
  { id: "pi_extra000000001", status: "succeeded", created: now - 120 * DAY, amount: 4000, currency: "usd", receipt_email: "BEN@example.com", metadata: { kind: "upsell", store: "bakery", product: "kit" } },
];

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") return new Response("{}", { status: 404 });
  stripeCalls += 1;
  if (url.pathname === "/v1/checkout/sessions") return new Response(JSON.stringify({ data: sessions, has_more: false }));
  if (url.pathname === "/v1/payment_intents") return new Response(JSON.stringify({ data: intents, has_more: false }));
  return new Response(JSON.stringify({ data: [], has_more: false }));
}) as typeof fetch;

function shop(): Store {
  return {
    sid: "sidbake00001",
    handle: "bakery",
    previousHandles: [],
    releasedHandles: [],
    statsId: "s".repeat(32),
    listId: "list0001",
    currency: "usd",
    stripeAccountId: "acct_test_segments1",
    catalog: { id: null, head: [], items: [{ id: "p1", kind: 0, options: [] }], inline: [{ id: "p1", title: "Bread School", options: [] }] },
  } as unknown as Store;
}

const contact = (agreed = true) =>
  JSON.stringify({ agreed, agreedAt: "", firstAt: "", lastAt: "", titles: [], ids: [], source: "buyer", unsub: false, unsubAt: "", t: "", name: "", tags: [], importedAt: "" });

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_segments_only_a_stand_in";
  const store = shop();

  part("What a request may ask");
  is("an amount, a channel and an offered number of days", readNarrow({ minSpent: 10000.4, channel: " Instagram ", quietDays: 90 }), { minSpent: 10000, channel: "instagram", quietDays: 90 });
  is("anything else is nothing", readNarrow({ minSpent: -5, channel: "<script>", quietDays: 45 }), NO_NARROW);
  is("nothing asked is not narrowed", [isNarrowed(NO_NARROW), isNarrowed({ ...NO_NARROW, quietDays: 30 })], [false, true]);

  part("The store's buyers, from its sales");
  const ledger = await buyerLedger(store);
  const row = (e: string) => {
    const r = ledger.buyers.get(e);
    return r ? [r.cents, r.channel] : null;
  };
  is("each address once, all it paid, where it first came from", [row("ana@example.com"), row("ben@example.com"), row("cy@example.com")], [[25000, "instagram"], [7000, "tiktok"], [9000, "direct"]]);
  is("how many times each bought: each checkout once, an offer taken after paying not again (270 [GR1])", ["ana@example.com", "ben@example.com", "cy@example.com"].map((e) => ledger.buyers.get(e)?.orders), [2, 1, 1]);
  is("support and another store's sales are not buyers here", [row("dee@example.com"), row("fay@example.com")], [null, null]);
  // A sale in euros, from before the store changed its currency (22 [E5], unit 2c): a buyer, with a purchase and its date, but nothing added to "spent".
  is("a buyer who paid in another currency is a buyer: the order and the date count, the money does not", [row("eve@example.com"), ledger.buyers.get("eve@example.com")?.orders, (ledger.buyers.get("eve@example.com")?.last ?? 0) > 0], [[0, "direct"], 1, true]);
  is("the channels, the most buyers first", ledgerChannels(ledger).sort(), ["direct", "instagram", "tiktok"]);
  const asked = stripeCalls;
  await buyerLedger(store);
  is("read again within ten minutes: nothing asked of Stripe", stripeCalls, asked);

  part("Who each narrowing keeps");
  const keep = (n: Partial<typeof NO_NARROW>) => ["ana@example.com", "ben@example.com", "cy@example.com", "eve@example.com", "nobody@example.com"].filter(keeps({ ...NO_NARROW, ...n }, ledger, NOW));
  // eve paid 500 euros three days ago, in another currency than the store's (22 [E5], unit 2c).
  is("spent at least $80: euros are not added, so not eve", keep({ minSpent: 8000 }), ["ana@example.com", "cy@example.com"]);
  is("first found you through Instagram", keep({ channel: "instagram" }), ["ana@example.com"]);
  is("first found you directly, eve among them", keep({ channel: "direct" }), ["cy@example.com", "eve@example.com"]);
  is("has not bought in 90 days, but has bought: not eve, who bought three days ago", keep({ quietDays: 90 }), ["ben@example.com"]);
  is("all three at once", keep({ minSpent: 1, channel: "tiktok", quietDays: 30 }), ["ben@example.com"]);

  part("A list narrowed that way");
  await redis.pipeline([
    ["HSET", leadsKey("list0001"), "ana@example.com", contact()],
    ["HSET", leadsKey("list0001"), "ben@example.com", contact()],
    ["HSET", leadsKey("list0001"), "cy@example.com", contact(false)],
    ["HSET", leadsKey("list0001"), "nobody@example.com", contact()],
  ]);
  is("only those who may be written to and match", (await audience("list0001", undefined, undefined, undefined, keeps({ ...NO_NARROW, minSpent: 1 }, ledger, NOW))).sort(), ["ana@example.com", "ben@example.com"]);

  part("Saved groups");
  is("a group needs a name", await saveSegment(store, { name: " ", narrow: { minSpent: 100 } }), { ok: false, reason: "name" });
  is("and needs to choose somebody", await saveSegment(store, { name: "Everyone" }), { ok: false, reason: "empty" });
  is("a product the store does not have is refused", await saveSegment(store, { name: "Odd", productId: "nope" }), { ok: false, reason: "product" });
  const saved = await saveSegment(store, { name: "Best customers", who: "buyers", narrow: { minSpent: 10000 } });
  is("saved", saved.ok ? saved.segments.map((s) => [s.name, s.who, s.minSpent]) : saved, [["Best customers", "buyers", 10000]]);
  const again = await saveSegment(store, { name: "best customers", narrow: { quietDays: 180 } });
  is("the same name replaces it", again.ok ? again.segments.map((s) => [s.name, s.minSpent, s.quietDays]) : again, [["best customers", 0, 180]]);
  const id = (await listSegments("list0001"))[0].id;
  is("and it can be removed", (await removeSegment(store, id)).length, 0);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
