/**
 * A page cut short never lends the model half of its terms (Revisor 1's light
 * on #2177, decided by Claude 1 on 05/11/2026 at 05h25 Fortaleza).
 *
 * keptParts tells every part whole or leaves it out whole, but two parts can
 * still split one promise: "30-day money-back guarantee*" fits and the next
 * part, "*Only for unopened downloads.", does not. So whenever the facts say
 * the page goes on (PAGE_GOES_ON), no answer that speaks of a refund, a
 * return, a guarantee, a warranty, a deadline, a trial or a price's
 * condition is shown, in any of the store's languages: the visitor gets the
 * fixed line that sends them to the creator. With the whole page told, the
 * same guarantee is still answered.
 */
import { addProduct, claimHandle, ensureStatsId, setAnswers, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { parsePage } from "@/lib/sales-page";
import { PAGE_GOES_ON, answerQuestion, factsFor } from "@/lib/answers";
import { heldToFacts } from "@/lib/store-assistant-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Sent = { system: string };
const asked: Sent[] = [];
let reply = "";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.anthropic.com") {
    asked.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ content: [{ type: "text", text: reply }] }));
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

/** The fixed line, in each language a store speaks. */
const TERMS_CUT = {
  en: "I don't have the full terms here. Please ask the creator before you buy.",
  es: "No tengo aquí las condiciones completas. Pregunta al creador antes de comprar.",
  fr: "Je n'ai pas ici les conditions complètes. Posez la question au créateur avant d'acheter.",
  de: "Die vollständigen Bedingungen liegen mir hier nicht vor. Fragen Sie vor dem Kauf beim Ersteller nach.",
  it: "Qui non ho le condizioni complete. Chiedi al creatore prima di acquistare.",
  nl: "Ik heb de volledige voorwaarden hier niet. Vraag het de maker voordat je koopt.",
  pt: "Não tenho aqui as condições completas. Pergunte ao criador antes de comprar.",
} as const;

async function main(): Promise<void> {
  redis.clear();
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-only-a-stand-in-0123456789";
  const owner = "termscut@example.com";
  await claimHandle(owner, "termscut", "Terms Shop", "");
  await setSubscription(owner, { customerId: "cus_Owner00031", subscriptionId: "sub_Owner00031", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  await ensureStatsId(owner);
  const made = await addProduct(owner, "Meal Planner", "A week of dinners, planned.", "27", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(owner, made.product.id, "https://example.com/planner");
  await setAnswers(owner, { on: true, facts: "" });
  const store = (await storeForEmail(owner))!;
  const product = (await readListing(store, made.product.id))!;

  const PROMISE = "30-day money-back guarantee*";
  const CONDITION = "*Only for unopened downloads.";
  // Four long parts the page opens with, then the promise, then its condition in the next part.
  const filler = Array.from({ length: 4 }, (_, i) => ({ id: `fill000${i}`, kind: "text", heading: "", body: "x".repeat(3_000) }));
  const pageWith = (tail: string) =>
    parsePage({
      blocks: [
        ...filler,
        { id: "promise1", kind: "text", heading: "", body: PROMISE },
        { id: "conditi1", kind: "text", heading: "", body: `${CONDITION}${tail}` },
      ],
    });
  // The condition's part is longer than the room left: it is left out whole and the page is said to go on.
  const cutPage = pageWith(`\n${"y".repeat(2_900)}`);
  const wholePage = pageWith("");
  const cutFacts = factsFor(store, product, "", cutPage);
  const wholeFacts = factsFor(store, product, "", wholePage);

  part("The reviewer's two parts: the promise told, its condition left out");
  is("the cut page tells the promise, not the condition, and says the page goes on", [cutFacts.includes(PROMISE), cutFacts.includes(CONDITION), cutFacts.includes(PAGE_GOES_ON)], [true, false, true]);
  is("the whole page tells both, and never says it goes on", [wholeFacts.includes(PROMISE), wholeFacts.includes(CONDITION), wholeFacts.includes(PAGE_GOES_ON)], [true, true, false]);

  part("heldToFacts: on a cut page, no reply speaks of terms, in any language");
  const termReplies = [
    "Yes, there is a 30-day money-back guarantee.",
    "You can get a refund.",
    "Returns are accepted.",
    "It has a warranty.",
    "The deadline is in the facts.",
    "There is a free trial.",
    "Sí, hay reembolso.",
    "Oui, remboursement possible.",
    "Ja, Rückerstattung möglich.",
    "Sì, rimborso possibile.",
    "Ja, je krijgt je geld terug.",
    "Sim, há reembolso.",
  ];
  for (const text of termReplies) is(`refused on the cut page: ${text}`, heldToFacts(text, cutFacts), false);
  is("a reply about something else still passes on the cut page", heldToFacts("It is a meal planner.", cutFacts), true);
  is("control: on the whole page the guarantee with its condition passes", heldToFacts("Yes, a 30-day money-back guarantee, only for unopened downloads.", wholeFacts), true);

  part("answerQuestion: the visitor gets the fixed line, never half the terms");
  const ask = (question: string, page = cutPage, language: keyof typeof TERMS_CUT = "en") =>
    answerQuestion({ store: { ...store, language }, product, about: "", page, question });
  reply = '{"known": true, "answer": "Yes, there is a 30-day money-back guarantee."}';
  const refund = await ask("Is there a refund?");
  is("a refund question on a cut page gets the fixed line", [refund.ok && refund.answer, refund.ok && refund.known], [TERMS_CUT.en, false]);
  reply = '{"known": true, "answer": "It comes with a 30-day money-back guarantee."}';
  const other = await ask("What do I get with it?");
  is("an answer that brings up the guarantee by itself is refused too", [other.ok && other.answer, other.ok && other.known], [TERMS_CUT.en, false]);
  for (const language of Object.keys(TERMS_CUT) as (keyof typeof TERMS_CUT)[]) {
    reply = '{"known": true, "answer": "Yes, there is a 30-day money-back guarantee."}';
    const said = await ask(`Can I get my money back? (${language})`, cutPage, language);
    is(`in the store's language (${language})`, said.ok && said.answer, TERMS_CUT[language]);
  }
  reply = '{"known": true, "answer": "It is a weekly meal planner."}';
  const plain = await ask("What is it?");
  is("an answer about something else is shown on the cut page", plain.ok && plain.answer, "It is a weekly meal planner.");
  is("the model is told the rule, with the line that marks a cut page", asked.length > 0 && asked.every((sent) => sent.system.includes(PAGE_GOES_ON)), true);

  part("Control: with the whole page told, the guarantee is answered");
  reply = '{"known": true, "answer": "Yes, a 30-day money-back guarantee, only for unopened downloads."}';
  const whole = await ask("Is there a refund?", wholePage);
  is("the full guarantee is answered", [whole.ok && whole.answer, whole.ok && whole.known], ["Yes, a 30-day money-back guarantee, only for unopened downloads.", true]);

  done();
}
void main();
