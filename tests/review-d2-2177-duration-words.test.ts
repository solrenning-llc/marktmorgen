import { addProduct, claimHandle, ensureStatsId, setAnswers, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { parsePage } from "@/lib/sales-page";
import { PAGE_GOES_ON, answerQuestion, factsFor } from "@/lib/answers";
import { heldToFacts } from "@/lib/store-assistant-rules";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";
import { paidPeriod } from "./billing-period-fixture";

let reply = "";
let calls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  if (new URL(String(input)).hostname === "api.anthropic.com") {
    calls++;
    return new Response(JSON.stringify({ content: [{ type: "text", text: reply }] }));
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-only-a-stand-in-0123456789";
  const owner = "durationproof@example.com";
  await claimHandle(owner, "durationproof", "Duration Shop", "");
  await setSubscription(owner, { customerId: "cus_Duration0001", subscriptionId: "sub_Duration0001", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  await ensureStatsId(owner);
  const made = await addProduct(owner, "Meal Planner", "A week of dinners, planned.", "27", null);
  if (!made.ok) throw new Error("product");
  await setProductLink(owner, made.product.id, "https://example.com/planner");
  await setAnswers(owner, { on: true, facts: "" });
  const store = (await storeForEmail(owner))!;
  const product = (await readListing(store, made.product.id))!;
  for (const number of ["thirteen", "seventeen", "thirty"]) {
    const promise = `You can try it for ${number} days.`;
    const condition = "Only if the purchased file has never been downloaded.";
    const page = parsePage({ blocks: [
      ...Array.from({ length: 4 }, (_, i) => ({ id: `fill000${i}`, kind: "text", heading: "", body: "x".repeat(3000) })),
      { id: "promise1", kind: "text", heading: "", body: promise },
      { id: "conditi1", kind: "text", heading: "", body: condition + "\n" + "y".repeat(2900) },
    ] });
    const facts = factsFor(store, product, "", page);
    is(number + ": real page loses condition and carries cutoff marker", [facts.includes(promise), facts.includes(condition), facts.includes(PAGE_GOES_ON)], [true, false, true]);
    is(number + ": heldToFacts refuses incomplete terms", heldToFacts(promise, facts), false);
    reply = JSON.stringify({ known: true, answer: promise });
    const before = calls;
    const answer = await answerQuestion({ store, product, about: "", page, question: "Tell me about the product: " + number });
    is(number + ": actual model reply is withheld", [answer.ok && answer.known, answer.ok && answer.answer], [false, "I don't have the full terms here. Please ask the creator before you buy."]);
    is(number + ": synthetic model was actually called", calls - before, 1);
  }
  done();
}
void main();
