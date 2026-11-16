/**
 * A product page's answer (lib/answers.ts) and the store guide's reasons
 * (lib/store-guide.ts) are held to the facts the model was given, as the
 * store assistant's chat, its next offer and its reminder already are
 * (`heldToFacts`, lib/store-assistant-rules.ts). Issue #4050.
 *
 * The model is played by a stand-in for `fetch`. What is checked:
 *
 *   - an answer with a code, a discount, a deadline or a refund the page
 *     never states is not shown: the visitor reads the plain "not known"
 *     sentence, and the invented words are not kept for a day;
 *   - an answer drawn from the page is still shown and kept;
 *   - an invented answer kept before this check is not served from memory;
 *   - a guide pick's reason with an invented deal is dropped (the pick stays
 *     without it), and not kept; a faithful reason stays.
 */
import { addProduct, claimHandle, ensureStatsId, setAnswers, setSubscription, storeForEmail } from "@/lib/store";
import { productIds, readListing, readListings } from "@/lib/catalog";
import { parsePage } from "@/lib/sales-page";
import { questionKey, unknownWords } from "@/lib/answers-rules";
import { answerQuestion, factsFor } from "@/lib/answers";
import { guideFacts, guideVisitor } from "@/lib/store-guide";
import { createHash } from "node:crypto";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const asked: unknown[] = [];
let reply = "";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.anthropic.com") {
    asked.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ content: [{ type: "text", text: reply }] }));
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const INVENTED = "Yes. Use code SAVE50 at checkout for 50% off today only, and you get a full refund within 90 days.";
const FAITHFUL = "It is a printable PDF with seven dinners and one grocery list.";

/** Every value the stand-in database keeps, as text. */
const everything = (): string =>
  redis
    .keys()
    .map((key) => {
      const type = redis.run(["TYPE", key]);
      if (type === "string") return `${key} ${String(redis.run(["GET", key]))}`;
      if (type === "list") return `${key} ${JSON.stringify(redis.run(["LRANGE", key, 0, -1]))}`;
      if (type === "hash") return `${key} ${JSON.stringify(redis.run(["HGETALL", key]))}`;
      return key;
    })
    .join("\n");

async function main(): Promise<void> {
  redis.clear();
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-only-a-stand-in-0123456789";

  const owner = "heldfacts@example.com";
  await claimHandle(owner, "heldfacts", "Held Facts", "");
  await setSubscription(owner, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  await ensureStatsId(owner);
  const made = await addProduct(owner, "Meal Planner", "A week of dinners, planned.", "27", null);
  if (!made.ok) throw new Error("no product");
  const second = await addProduct(owner, "Knife Skills", "Short lessons on cutting safely and fast.", "49", null);
  if (!second.ok) throw new Error("no product");
  await setAnswers(owner, { on: true, facts: "Every file is a PDF." });
  const store = (await storeForEmail(owner))!;
  const product = (await readListing(store, made.product.id))!;
  const page = parsePage({
    blocks: [{ id: "faq00001", kind: "faq", heading: "Questions", items: [{ q: "What format is it?", a: "A printable PDF." }] }],
  });
  const about = "Seven dinners and one grocery list.";
  const ask = (question: string) => answerQuestion({ store, product, about, page, question });

  part("A product page's answer");
  reply = JSON.stringify({ known: true, answer: INVENTED });
  const invented = await ask("Is there a discount?");
  is("an invented deal is not shown: the plain not-known sentence", invented.ok ? [invented.answer, invented.known] : null, [unknownWords("Held Facts"), false]);
  is("and the invented words are kept nowhere", ["SAVE50", "90 days", "50%"].map((piece) => everything().includes(piece)), [false, false, false]);
  const sent = asked.length;
  await ask("Is there a discount?");
  is("not answered from memory: the model is asked again", asked.length, sent + 1);

  reply = JSON.stringify({ known: true, answer: FAITHFUL });
  const faithful = await ask("What format is it?");
  is("an answer drawn from the page is shown", faithful.ok ? [faithful.answer, faithful.known] : null, [FAITHFUL, true]);
  const before = asked.length;
  const again = await ask("What format is it?");
  is("and kept: answered from memory", [again.ok ? again.answer : null, asked.length], [FAITHFUL, before]);

  part("An invented answer kept before the check");
  const facts = factsFor(store, product, about, page);
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const hash = sha(`${store.statsId}|${product.id}|${store.language}|${sha(facts)}|${questionKey("Is it on sale?")}`).slice(0, 40);
  redis.run(["SET", `nl:ask:a:${hash}`, JSON.stringify({ answer: INVENTED, known: true })]);
  reply = JSON.stringify({ known: false, answer: "" });
  const old = await ask("Is it on sale?");
  is("is not served from memory", old.ok ? [old.answer === INVENTED, old.known] : null, [false, false]);

  part("The store guide's reasons");
  const products = await readListings(store, productIds(store));
  is("two products in the catalog", products.length, 2);
  reply = JSON.stringify({ picks: [
    { n: 1, why: "Half price today only with code HALF, 1,000 buyers already." },
    { n: 2, why: "Short lessons on cutting safely and fast." },
  ] });
  const guided = await guideVisitor({ store, products, goal: "Dinner ideas and kitchen basics" });
  is("the invented reason is dropped, the pick kept; the faithful one stays", guided, {
    ok: true,
    picks: [
      { id: made.product.id, why: "" },
      { id: second.product.id, why: "Short lessons on cutting safely and fast." },
    ],
  });
  is("and the invented reason is kept nowhere", ["HALF", "1,000"].map((piece) => everything().includes(piece)), [false, false]);

  part("An invented reason kept before the check");
  const guideHash = sha(`guide|${store.statsId}|${store.language}|${sha(guideFacts(store, products))}|${questionKey("Something cheap")}`).slice(0, 40);
  redis.run(["SET", `nl:ask:a:${guideHash}`, JSON.stringify({ picks: [{ id: made.product.id, why: "Half price today only with code HALF, 1,000 buyers already." }] })]);
  const sentGuide = asked.length;
  const kept = await guideVisitor({ store, products, goal: "Something cheap" });
  is("is not shown from memory", [kept, asked.length], [{ ok: true, picks: [{ id: made.product.id, why: "" }] }, sentGuide]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
