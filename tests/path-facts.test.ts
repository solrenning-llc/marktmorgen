/**
 * Marktmorgen Path read end to end from a store's own records (lib/path-facts.ts,
 * lib/path.ts, 18 October 2026), with synthetic records and Stripe played by
 * a stand-in for `fetch`: no real message, no live record. What is checked:
 *
 *   - each day closes on the record the store already keeps: its name and
 *     line, a product with a file, a paid checkout Stripe marks as test
 *     mode, a visit counted from a social network, three short links, an
 *     address left on the store, a real paid order;
 *   - a real order counts only when Stripe says it is complete, paid and in
 *     live mode, never a tip or a payment request; in test mode none can;
 *   - a refund in full takes the sale and its money back, while the level
 *     reached is kept; refunds Stripe could not list in full leave the money
 *     unknown and move no level;
 *   - the record: the answers kept, today counted once, written only when
 *     something changed, counted in the store's data room, and gone with
 *     the store.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, storeForEmail, updateDetails } from "@/lib/store";
import { moneyFrom, readPathFacts, readPathMoney } from "@/lib/path-facts";
import { forgetPath, readPath, startPath, visitPath, PATH_SLOT, PATH_READ_UNITS } from "@/lib/path";
import { allowanceUsed } from "@/lib/store-allowance";
import { dataKey } from "@/lib/store-data";
import { readAnswers, levelKept, pathProgress } from "@/lib/path-rules";
import { redisPipeline } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_path_only";

const OWNER = "path@example.com";
const ACCOUNT = "acct_fixture009";
let sessions: Record<string, unknown>[] = [];
let refunds: Record<string, unknown>[] = [];
let refundsMore = false;
let stripeCalls = 0;

const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") return new Response("{}", { status: 404 });
  stripeCalls += 1;
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") return answer({ object: "list", data: sessions, has_more: false });
  if (path === "/payment_intents") return answer({ object: "list", data: [], has_more: false });
  if (path === "/refunds") return answer({ object: "list", data: refunds, has_more: refundsMore });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

let n = 0;
const checkout = (over: Record<string, unknown> = {}) => ({
  id: `cs_test_path${String(++n).padStart(6, "0")}`,
  object: "checkout.session",
  status: "complete",
  payment_status: "paid",
  amount_total: 4_900,
  currency: "usd",
  created: 1_790_000_000 + n,
  livemode: false,
  payment_intent: `pi_path${String(n).padStart(8, "0")}`,
  metadata: { store: "pathstore", product: "p1" },
  ...over,
});

async function main() {
  await claimHandle(OWNER, "pathstore", "Path Store", "");
  let store = (await ensureStatsId(OWNER))!;
  const answers = readAnswers({ goalCents: 100_000, skills: "baking", subject: "sourdough", minutes: 30, audience: "instagram", timeZone: "America/Sao_Paulo" }, store.currency);
  if (!answers.ok) throw new Error("answers");

  part("Nothing yet");
  {
    is("no path before the questions", await readPath(store), null);
    const started = await startPath(store, answers.answers, Date.UTC(2026, 9, 18, 15));
    is("begun", started.ok, true);
    const record = (await readPath(store))!;
    is("the answers kept", record.answers.subject, "sourdough");
    is("today counted in the person's own day", record.checkins, ["2026-10-18"]);
    const read = await readPathFacts(store, null);
    is("a name with no line is not a published title", read.titlePublished, false);
    is("nothing to sell yet", read.productWithFile, false);
    is("in test mode the test purchase is open", read.testPurchase, "open");
    const [room] = await redisPipeline([["HGET", dataKey(store)!, PATH_SLOT]]);
    is("the record is counted in the store's data room", Number(room) > 0, true);
  }

  part("Each day on its own record");
  {
    await updateDetails(OWNER, "Path Store", "Sourdough guides for home bakers");
    const added = await addProduct(OWNER, "The starter guide", "", "19");
    if (!added.ok) throw new Error("product");
    await setProductLink(OWNER, added.product.id, "https://example.com/guide");
    await setStripeAccount(OWNER, ACCOUNT, true);
    store = (await storeForEmail(OWNER))!;
    const life = `nl:stats:${store.statsId}:life`;
    await redisPipeline([["HSET", life, "r:instagram", "1", "r:google", "40", "fs:instagram", "1", "u", "41"]]);
    await redisPipeline([["HSET", `nl:slink:store:${store.statsId}`, "a1", "{}", "a2", "{}", "a3", "{}"]]);
    sessions = [checkout()];
    const money = await readPathMoney(store);
    const read = await readPathFacts(store, money);
    is("Day 1: the name and the line", read.titlePublished, true);
    is("Day 2: a product with something to hand over", read.productWithFile, true);
    is("Day 3: a paid checkout Stripe marks as test mode", read.testPurchase, "done");
    is("Day 4: a visit from a social network, not a search", read.socialVisits, 1);
    is("Day 5: three short links", read.postLinks, 3);
    is("Day 6: an address left on the store", read.leads, 1);
    is("Day 7: a test purchase is never a real sale", read.realSales, 0);
    const progress = pathProgress(read, answers.answers, Date.UTC(2026, 9, 18), Date.UTC(2026, 9, 19));
    is("six of seven done, the sale left", progress.days.map((m) => m.state), ["done", "done", "done", "done", "done", "done", "open"]);
  }

  part("Real orders, confirmed by Stripe");
  {
    sessions = [
      checkout(),
      checkout({ livemode: true, amount_total: 4_900 }),
      checkout({ livemode: true, amount_total: 500, metadata: { store: "pathstore", kind: "tip" } }),
      checkout({ livemode: true, amount_total: 9_000, metadata: { store: "pathstore", kind: "request" } }),
      checkout({ livemode: true, payment_status: "unpaid" }),
      checkout({ livemode: true, metadata: { store: "otherstore" } }),
    ];
    const money = (await readPathMoney(store))!;
    is("one real order: not a tip, a bill, an unpaid one or another store's", money.real, 1);
    is("its money kept", money.cents, 4_900);
    is("and the test purchase still seen", money.test, true);
    const record = (await readPath(store))!;
    const visited = await visitPath(store, { ...record, money: null, counts: null }, Date.UTC(2026, 9, 19, 15));
    is("Sunrise kept on the record", visited.record.best, 1);
    is("today counted once", visited.record.checkins, ["2026-10-18", "2026-10-19"]);
    const again = await visitPath(store, visited.record, Date.UTC(2026, 9, 19, 15, 5));
    is("the fresh reading reused: Stripe not asked again", again.record.money?.at, visited.record.money?.at);
    is("the counts kept with it", visited.record.counts, { at: Date.UTC(2026, 9, 19, 15), social: 1, visitors: 41, links: 3, leads: 1 });
    // countStudio takes the requests at the real moment of the call (visitPath's own
    // clock only decides whether the reading is stale), so its window is read at that
    // moment: a fixed date fell into another month's window from 1 November 2026 on.
    const used = await allowanceUsed(store, "studio");
    is("a reading takes its studio requests first", used >= PATH_READ_UNITS, true);
    const calls = stripeCalls;
    const refused = await visitPath(store, visited.record, Date.UTC(2026, 9, 19, 16), async () => false);
    is("with no studio room, Stripe is not asked", stripeCalls, calls);
    is("and the last reading is shown, with when it was read", refused.record.money?.at, visited.record.money?.at);
    is("still a real sale on it", refused.facts.realSales, 1);
  }

  part("A refund takes the sale back, never the level");
  {
    const sold = sessions[1] as { payment_intent: string };
    refunds = [{ id: "re_path0001", status: "succeeded", amount: 4_900, currency: "usd", payment_intent: sold.payment_intent, created: 1_790_000_100 }];
    const money = (await readPathMoney(store))!;
    is("refunded in full: no real sale", money.real, 0);
    is("and no money", money.cents, 0);
    const read = await readPathFacts(store, money);
    is("the first-sale mission open again", pathProgress(read, answers.answers, 0, 1).days[6].state, "open");
    is("Sunrise kept", levelKept(1, read), 1);
    refunds = [{ id: "re_path0002", status: "succeeded", amount: 1_000, currency: "usd", payment_intent: sold.payment_intent, created: 1_790_000_100 }];
    const partly = (await readPathMoney(store))!;
    is("a part refund keeps the sale", partly.real, 1);
    is("and takes its part off the money", partly.cents, 3_900);
    refundsMore = true;
    refunds = [];
    const unknown = (await readPathMoney(store))!;
    is("refunds not listed in full: the money unknown", unknown.cents, null);
    is("so no level moves on it", levelKept(-1, await readPathFacts(store, unknown)) <= 1, true);
    refundsMore = false;
    is("a membership's refund no sale claims is taken off it", moneyFrom([{ cents: 2_000, currency: "usd", intent: "", live: true }], [{ cents: 2_000, currency: "usd", paymentIntent: "pi_elsewhere" }], "usd", 1), { at: 1, test: false, real: 0, cents: 0, currency: "usd" });
  }

  part("Written only when something changed, gone with the store");
  {
    const before = stripeCalls;
    const record = (await readPath(store))!;
    await visitPath(store, record, (record.money?.at ?? 0) + 1_000);
    is("a fresh reading asks Stripe nothing", stripeCalls, before);
    await forgetPath(store);
    is("forgotten", await readPath(store), null);
    const [room] = await redisPipeline([["HGET", dataKey(store)!, PATH_SLOT]]);
    is("and its room given back", Number(room ?? 0), 0);
  }
}

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
