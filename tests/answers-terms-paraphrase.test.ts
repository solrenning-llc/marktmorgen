/**
 * A page cut short refuses paraphrased terms too (Revisor 1's coverage light
 * on #2177 after 49f9a252): a word list alone lets "every cent back" or
 * "risk-free for a month" through. So, while the facts say the page goes on
 * (PAGE_GOES_ON), no answer is shown and no question is put to the model
 * that carries a period of time (a number or a number word before a unit of
 * time, in the seven store languages) or the paraphrases of money back, risk
 * free, a window or "if you don't like it". A common question on the same
 * cut page is still answered, and on the whole page the guarantee is.
 */
import { addProduct, claimHandle, ensureStatsId, setAnswers, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { parsePage } from "@/lib/sales-page";
import { PAGE_GOES_ON, answerQuestion, factsFor } from "@/lib/answers";
import { heldToFacts } from "@/lib/store-assistant-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

let calls = 0;
let reply = "";
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.anthropic.com") {
    calls += 1;
    return new Response(JSON.stringify({ content: [{ type: "text", text: reply }] }));
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const FIXED = "I don't have the full terms here. Please ask the creator before you buy.";

async function main(): Promise<void> {
  redis.clear();
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-only-a-stand-in-0123456789";
  const owner = "paraphrase@example.com";
  await claimHandle(owner, "paraphrase", "Paraphrase Shop", "");
  await setSubscription(owner, { customerId: "cus_Owner00032", subscriptionId: "sub_Owner00032", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  await ensureStatsId(owner);
  const made = await addProduct(owner, "Meal Planner", "A week of dinners, planned.", "27", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(owner, made.product.id, "https://example.com/planner");
  await setAnswers(owner, { on: true, facts: "" });
  const store = (await storeForEmail(owner))!;
  const product = (await readListing(store, made.product.id))!;

  const PROMISE = "30-day money-back guarantee*";
  const CONDITION = "*Only for unopened downloads.";
  const filler = Array.from({ length: 4 }, (_, i) => ({ id: `fill000${i}`, kind: "text", heading: "", body: "x".repeat(3_000) }));
  const pageWith = (tail: string) =>
    parsePage({
      blocks: [...filler, { id: "promise1", kind: "text", heading: "", body: PROMISE }, { id: "conditi1", kind: "text", heading: "", body: `${CONDITION}${tail}` }],
    });
  const cutPage = pageWith(`\n${"y".repeat(2_900)}`);
  const wholePage = pageWith("");
  const cutFacts = factsFor(store, product, "", cutPage);
  const wholeFacts = factsFor(store, product, "", wholePage);
  is("the cut page says it goes on, the whole page does not", [cutFacts.includes(PAGE_GOES_ON), wholeFacts.includes(PAGE_GOES_ON), wholeFacts.includes(CONDITION)], [true, false, true]);

  const answers = [
    "You have 30 days to get every cent back.",
    "If you don't like it, we'll pay you back in full.",
    "You can try it risk-free for a month.",
    "Você pode pedir o dinheiro de volta em 30 dias.",
    "Puedes recuperar tu dinero en 30 días.",
  ];
  const questions = ["Is there a 30 day window?", "What happens if I don't like it?"];

  part("heldToFacts: paraphrased terms on a cut page are refused");
  for (const text of [...answers, ...questions]) is(`refused: ${text}`, heldToFacts(text, cutFacts), false);
  is("control: a common reply on the cut page passes", heldToFacts("It includes PDF files.", cutFacts), true);

  part("answerQuestion: a paraphrased answer on a cut page gets the fixed line");
  const ask = (question: string, page = cutPage) => answerQuestion({ store, product, about: "", page, question });
  for (const text of answers) {
    reply = JSON.stringify({ known: true, answer: text });
    const said = await ask(`Tell me about it: ${text.length}`);
    is(`not shown: ${text}`, [said.ok && said.answer, said.ok && said.known], [FIXED, false]);
  }

  part("answerQuestion: a question with a period of time or \"if I don't like it\" is not put to the model");
  for (const question of questions) {
    reply = JSON.stringify({ known: true, answer: "Yes, a 30-day money-back guarantee." });
    const before = calls;
    const said = await ask(question);
    is(`fixed line, no model call: ${question}`, [said.ok && said.answer, said.ok && said.known, calls - before], [FIXED, false, 0]);
  }

  part("Controls");
  reply = JSON.stringify({ known: true, answer: "It includes PDF files." });
  const formats = await ask("What file formats are included?");
  is("on the cut page, a common question is still answered", [formats.ok && formats.answer, formats.ok && formats.known], ["It includes PDF files.", true]);
  reply = JSON.stringify({ known: true, answer: "Yes: you have 30 days to get every cent back, only for unopened downloads." });
  const whole = await ask("Is there a 30 day window?", wholePage);
  is("without PAGE_GOES_ON, the guarantee is answered", [whole.ok && whole.answer, whole.ok && whole.known], ["Yes: you have 30 days to get every cent back, only for unopened downloads.", true]);
  is("and passes heldToFacts on the whole page", heldToFacts("You have 30 days to get every cent back, only for unopened downloads.", wholeFacts), true);

  done();
}
void main();
