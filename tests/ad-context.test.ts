/**
 * 632 [AA2] (m), unit 3: the ad check's context comes from the store's own
 * records (lib/ad-context.ts), never from the request: the price a buyer
 * pays today, the creator's live domain, a real running sale, a real stock
 * limit and the words of real reviews.
 */
import { adContext, adFacts, adPriceCents } from "@/lib/ad-context";
import { checkAdText } from "@/lib/ad-creative-check";
import type { Listing, Store } from "@/lib/store";
import { NO_SALE } from "@/lib/store-sale";
import { done, is, part } from "./check";

const NOW = 1_793_700_000;
const product = (over: Partial<Listing> = {}): Listing =>
  ({ id: "p1", priceCents: 4000, recurring: null, call: null, pwyw: null, keys: null, options: [], file: { path: "stores/s/p1/f.pdf" }, link: "", course: null, podcast: null, shipping: null, bundle: null, stock: null, ...over }) as unknown as Listing;
const option = (id: string, priceCents: number) => ({ id, label: id, priceCents, file: { path: `stores/s/${id}/f.pdf` }, link: "" });
const options = (...list: ReturnType<typeof option>[]) => list as unknown as Listing["options"];
const store = (over: Partial<Store> = {}) =>
  ({ statsId: null, currency: "usd", domain: null, sale: { ...NO_SALE }, subscriptionActive: true, tier: "pro", ...over }) as unknown as Store;
const sale = { name: "Spring", percent: 25, starts: NOW - 60, ends: NOW + 86_400, all: true, products: [], coupon: "SPRING" };
const live = { name: "www.Cook.Example", liveAt: NOW - 100 } as unknown as Store["domain"];

async function main(): Promise<void> {
  part("The price a buyer pays today");
  is("one price", adPriceCents(store(), product(), NOW), 4000);
  is("with a running sale taken off", adPriceCents(store({ sale }), product(), NOW), 3000);
  is("a sale that ended takes nothing off", adPriceCents(store({ sale: { ...sale, ends: NOW - 1 } }), product(), NOW), 4000);
  is("free: none", adPriceCents(store(), product({ priceCents: 0 }), NOW), null);
  is("options of different prices: none, never a guess", adPriceCents(store(), product({ options: options(option("o1", 4000), option("o2", 9000)) }), NOW), null);
  is("options of one price: that price", adPriceCents(store(), product({ options: options(option("o1", 5000), option("o2", 5000)) }), NOW), 5000);

  part("Everything else, from the record alone");
  const plain = adFacts(store(), product(), NOW);
  is("no domain, no sale, no stock limit", [plain.ownHosts, plain.realDeadline, plain.realStockLimit, plain.currency], [[], false, false, "usd"]);
  is("the creator's live domain, bare", adFacts(store({ domain: live }), product(), NOW).ownHosts, ["cook.example"]);
  is("a domain not live yet is not theirs to link", adFacts(store({ domain: { ...live!, liveAt: 0 } as unknown as Store["domain"] }), product(), NOW).ownHosts, []);
  is("nor one their plan no longer allows", adFacts(store({ domain: live, subscriptionActive: false }), product(), NOW).ownHosts, []);
  is("a running sale on it is a real deadline", adFacts(store({ sale }), product(), NOW).realDeadline, true);
  is("a sale on other products is not", adFacts(store({ sale: { ...sale, all: false, products: ["p2"] } }), product(), NOW).realDeadline, false);
  is("a limited quantity the creator set is real", adFacts(store(), product({ stock: 12 }), NOW).realStockLimit, true);

  part("What the check then decides");
  const ad = (text: string) => ({ headline: "Knife skills for busy cooks", text, description: "", button: "Learn more" });
  const facts = (s: Store, p: Listing) => adContext(s, p, NOW);
  is("a price that is the product's passes", checkAdText(ad("Yours for $40."), await facts(store(), product())).sendable, true);
  const wrong = checkAdText(ad("Yours for $19."), await facts(store(), product()));
  is("a price that is not is refused, naming the product's own", [wrong.sendable, wrong.refusals.some((finding) => finding.rule === "price_mismatch" && finding.why.includes("$40"))], [false, true]);
  is("on sale, the price after the sale is the one", checkAdText(ad("Yours for $30."), await facts(store({ sale }), product())).sendable, true);
  is("urgency with no real sale is refused", checkAdText(ad("Ends tonight, hurry!"), await facts(store(), product())).sendable, false);
  is("no store to read reviews from: none, so a quote cannot pass as one", (await facts(store(), product())).verifiedReviews, []);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
