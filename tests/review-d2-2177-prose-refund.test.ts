/**
 * The store's answers read a row of columns (375 [TB1]; inbox C2-79 (c),
 * C4-5): what a row says on the page is a fact the model may answer from,
 * in the order the page shows it, and nothing it does not say. A button's
 * address is never a fact (the answer has no links); a decorative picture
 * says nothing, a described one says its words.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { parsePage } from "@/lib/sales-page";
import { factsFor } from "@/lib/answers";
import { MAX_FACTS_CHARS } from "@/lib/answers-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

async function main(): Promise<void> {
  redis.clear();
  const owner = "rows@example.com";
  await claimHandle(owner, "rowshop", "Row Shop", "");
  await setSubscription(owner, { customerId: "cus_Owner00009", subscriptionId: "sub_Owner00009", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  await ensureStatsId(owner);
  const made = await addProduct(owner, "Meal Planner", "A week of dinners, planned.", "27", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(owner, made.product.id, "https://example.com/planner");
  const store = (await storeForEmail(owner))!;
  const product = (await readListing(store, made.product.id))!;
  const PROMISE = "Full refunds are available within fourteen days.";
  const CONDITION = "Only if the purchased file has never been downloaded.";
  const NOTES = "Orders placed on Sunday ship on Monday.";
  const noted = { ...store, answers: { ...store.answers, facts: NOTES } };
  const variants = [
    { name: "text", make: () => ({ id: "refund01", kind: "text", heading: "Refunds", body: `${PROMISE}\n${CONDITION}` }) },
    { name: "feature", make: () => ({ id: "refund01", kind: "feature", heading: "Refunds", body: `${PROMISE}\n${CONDITION}`, side: "left" }) },
    { name: "row paragraph", make: () => ({ id: "refund01", kind: "row", columns: [[{ kind: "paragraph", text: `${PROMISE}\n${CONDITION}` }]] }) },
  ];
  part("A valid public part cannot broaden a refund by losing its next-line condition");
  for (const variant of variants) {
    const short = factsFor(noted, product, "", parsePage({ blocks: [variant.make()] }));
    is(`${variant.name}: short-page control retains both lines`, [short.includes(PROMISE), short.includes(CONDITION), short.endsWith(NOTES)], [true, true, true]);
    let observation: null | { filler: number; length: number; notes: boolean; marker: boolean; conditionOnPage: boolean } = null;
    for (let filler = 12_000; filler <= MAX_FACTS_CHARS; filler++) {
      let remaining = filler;
      const blocks: Record<string, unknown>[] = [];
      while (remaining > 0) {
        const length = Math.min(3_000, remaining);
        blocks.push({ id: `fill${String(blocks.length).padStart(4, "0")}`, kind: "text", heading: "", body: "x".repeat(length) });
        remaining -= length;
      }
      blocks.push(variant.make());
      const page = parsePage({ blocks });
      const facts = factsFor(noted, product, "", page);
      if (facts.includes(PROMISE) && !facts.includes(CONDITION)) {
        observation = { filler, length: facts.length, notes: facts.endsWith(NOTES), marker: facts.includes("The page goes on here"), conditionOnPage: JSON.stringify(page).includes(CONDITION) };
        const guarantee = factsFor(noted, product, "", parsePage({ blocks: [...blocks.slice(0, -1), { id: "refund01", kind: "guarantee", heading: "Refunds", body: `${PROMISE}\n${CONDITION}` }] }));
        is(`${variant.name}: actual guarantee control retains the condition`, [guarantee.includes(PROMISE), guarantee.includes(CONDITION)], [true, true]);
        break;
      }
    }
    console.log("D2 public refund observation", variant.name, observation);
    is(`${variant.name}: the model never receives a refund promise without the page's condition`, observation, null);
  }
  done();
}
void main();
