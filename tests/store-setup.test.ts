/**
 * A store drafted with AI from a few sentences (lib/ai.ts writeStoreSetup,
 * lib/store-setup.ts; added 10 October 2026). Checked: the model is told to
 * work only from the creator's words and never to invent; what comes back is
 * held to its shapes; and what the creator keeps lands as drafts that are not
 * on sale, the line under the name, and the questions only where there were
 * none.
 */
import { claimHandle, ensureStatsId, setFaq, setSubscription, storeForEmail } from "@/lib/store";
import { SETUP_MONEY_OR_NUMBER, statedPrice, writeStoreSetup } from "@/lib/ai";
import { keepStoreSetup, setupTemplate } from "@/lib/store-setup";
import { readPage } from "@/lib/sales-page-store";
import { templateOutline } from "@/lib/sales-page";
import { KIND, readListing } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Sent = { system: string; messages: { content: string }[] };
const asked: Sent[] = [];
let reply = "";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.anthropic.com") {
    asked.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ content: [{ type: "text", text: reply }] }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-only-a-stand-in-0123456789";
  const owner = "setup@example.com";
  await claimHandle(owner, "setupshop", "Setup Shop", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_Setup0001", subscriptionId: "sub_Setup0001", active: true, tier: "pro", period: paidPeriod() });

  part("The draft");
  reply = JSON.stringify({
    bios: ["Weeknight dinners for busy parents.", "Weeknight dinners for busy parents.", "Cook once, eat all week."],
    products: [
      { title: "Sunday Meal Planner", summary: "A week of dinners planned in one page.", kind: "download", price: "$12" },
      { title: "Batch Cooking Course", summary: "Ten short lessons.", kind: "course", price: "49" },
      { title: "Monthly Menu Club", summary: "A new menu every month.", kind: "membership", price: "7" },
      { title: "A fourth", summary: "", kind: "download", price: "5" },
    ],
    faq: [{ q: "How do I get the planner?", a: "As a download after paying, see https://example.com." }, { q: "No answer", a: "" }],
  });
  const drafted = await writeStoreSetup((await storeForEmail(owner))!, { about: "I teach busy parents to batch cook on Sundays.", selling: "A planner for $12, a course at 49 dollars, a club." });
  if (!drafted.ok) throw new Error("no draft");
  is("lines once each", drafted.value.bios, ["Weeknight dinners for busy parents.", "Cook once, eat all week."]);
  is("three products at most, prices only where the creator named them (the club's 7 was the model's guess)", drafted.value.products.map((p) => [p.title, p.kind, p.price]), [["Sunday Meal Planner", "download", "12"], ["Batch Cooking Course", "course", "49"], ["Monthly Menu Club", "membership", ""]]);
  is("told never to guess a price", /Never guess, suggest or round a price/.test(asked[0].system), true);
  is("answers whole, with no links", drafted.value.faq, [{ q: "How do I get the planner?", a: "As a download after paying, see" }]);
  is("told to work from the creator's words only, and to invent nothing", [
    asked[0].messages[0].content.includes("batch cook on Sundays"),
    /Work ONLY from what the creator says/.test(asked[0].system),
    /Never invent a credential/.test(asked[0].system),
  ], [true, true, true]);
  is("nothing to work from, nothing asked", (await writeStoreSetup((await storeForEmail(owner))!, { about: " ", selling: "" })).ok, false);

  part("A price is the creator's, written as a price, or empty");
  is("written as a price in the store's currency, kept", [
    statedPrice("12", "a planner for $12", "usd"),
    statedPrice("1200", "the course is 1,200 dollars", "usd"),
    statedPrice("49.5", "49.50 USD a month", "usd"),
    statedPrice("49.5", "nur €49,50 im Monat", "eur"),
    statedPrice("1500", "1.500 kr", "dkk"),
    statedPrice("1500", "¥1500", "jpy"),
  ], ["12", "1200", "49.5", "49.5", "1500", "1500"]);
  is("a bare number, another currency or nothing: empty", [
    statedPrice("10", "10 lessons for ages 5-12", "usd"),
    statedPrice("2026", "since 2026", "usd"),
    statedPrice("49", "€49", "usd"),
    statedPrice("7", "a planner for $12", "usd"),
    statedPrice("", "$12", "usd"),
    statedPrice("0", "$0", "usd"),
    statedPrice("4950", "€49,50", "eur"),
  ], ["", "", "", "", "", "", ""]);

  part("At most three questions, to press, only when something is missing");
  reply = JSON.stringify({
    bios: [],
    products: [],
    faq: [],
    questions: [
      { q: "What do you mainly sell?", options: ["Recipes", "Courses", "Recipes", "Coaching calls"] },
      { q: "Who is it for?", options: ["Busy parents", "Students"] },
      { q: "What price do you charge?", options: ["$5", "$10"] },
      { q: "How many recipes are there?", options: ["10", "20"] },
      { q: "Only one answer?", options: ["Yes"] },
      { q: "Fourth real question?", options: ["A", "B"] },
      { q: "Fifth?", options: ["A", "B"] },
    ],
  });
  const asking = await writeStoreSetup((await storeForEmail(owner))!, { about: "I cook.", selling: "" });
  if (!asking.ok) throw new Error("no questions");
  is("questions with two to four distinct answers, none about a price or a number, three at most", asking.value.questions, [
    { q: "What do you mainly sell?", options: ["Recipes", "Courses", "Coaching calls"] },
    { q: "Who is it for?", options: ["Busy parents", "Students"] },
    { q: "Fourth real question?", options: ["A", "B"] },
  ]);
  is("never about money or a count", ["What price do you charge?", "How are you pricing it?", "What does it cost?", "Any fees?", "How do buyers pay?", "What is your budget?", "How long is it?", "How often do you post?"].map((q) => SETUP_MONEY_OR_NUMBER.test(q)), [true, true, true, true, true, true, true, true]);
  is("but a question about who is in charge, or what it is, may be asked", ["Who is in charge of the club?", "What kind of product is it?", "Who is it for?"].map((q) => SETUP_MONEY_OR_NUMBER.test(q)), [false, false, false]);
  is("told to ask only for what is indispensable, and never for a price", [/unless something indispensable is missing/.test(asked[asked.length - 1].system), /Never ask for a price/.test(asked[asked.length - 1].system)], [true, true]);
  reply = JSON.stringify({ bios: ["Recipes for busy parents."], products: [], faq: [], questions: [] });
  const answered = await writeStoreSetup((await storeForEmail(owner))!, { about: "I cook.", selling: "", answers: [{ q: "What do you mainly sell?", a: "Recipes" }, { q: "Who is it for?", a: "Busy parents" }, { q: "x", a: "" }, { q: "4", a: "a" }, { q: "5", a: "b" }] });
  is("the answers go back into the next draft, three at most, empty ones dropped", [answered.ok, asked[asked.length - 1].messages[0].content.includes("- What do you mainly sell? Recipes"), asked[asked.length - 1].messages[0].content.includes("- 5 b")], [true, true, false]);
  is("a draft with nothing to ask carries no questions", answered.ok ? answered.value.questions : "no", undefined);

  part("Questions held to their shape");
  reply = JSON.stringify({ bios: [], products: [], faq: [], questions: [
    { q: "Which format?", options: ["10 recipes", "20 recipes"] },
    { q: "Which format do you prefer for what you make and sell to your audience today, and for whom exactly, if you would say?", options: ["A very long answer that goes far past forty characters in all", "B", "C", "D", "E"] },
  ] });
  const shaped = await writeStoreSetup((await storeForEmail(owner))!, { about: "I cook.", selling: "" });
  const held = shaped.ok ? shaped.value.questions ?? [] : [];
  is("one answered with numbers is dropped; a long one is cut to 100 and 40, four answers at most", [held.length, held[0]?.q.length, held[0]?.options[0].length, held[0]?.options.length], [1, 100, 40, 4]);

  part("What the creator keeps");
  const kept = await keepStoreSetup(owner, (await storeForEmail(owner))!, {
    bio: "Cook once, eat all week.",
    products: [
      { title: "Sunday Meal Planner", summary: "A week of dinners planned in one page.", kind: "download", price: "12" },
      { title: "Monthly Menu Club", summary: "A new menu every month.", kind: "membership", price: "7" },
      { title: "Free?", summary: "", kind: "download", price: "abc" },
    ],
    faq: [{ q: "How do I get the planner?", a: "As a download after paying." }],
  });
  const store = (await storeForEmail(owner))!;
  is("the line, two drafts each with its page, the questions, and the one with no price refused by name", kept, { bio: true, products: 2, pages: 2, faq: true, refused: ["Free?"] });
  is("the line is under the name", store.bio, "Cook once, eat all week.");
  is("every product a draft, not on sale", store.catalog.items.map((item) => (item.kind & KIND.hidden) !== 0), [true, true]);
  is("the club is monthly", (store.catalog.items[1].kind & KIND.recurring) !== 0, true);
  part("Each draft product gets the sales page of its kind, with nothing invented");
  const asksBefore = asked.length;
  const [plannerPage, clubPage] = await Promise.all(store.catalog.items.map((item) => readPage(store.statsId, item.id)));
  is("the planner's page opens on its own title and summary, then the download template", [plannerPage.blocks[0]?.kind, (plannerPage.blocks[0] as { headline?: string }).headline, (plannerPage.blocks[0] as { sub?: string }).sub, plannerPage.blocks.slice(1).map((b) => b.kind)], ["hero", "Sunday Meal Planner", "A week of dinners planned in one page.", templateOutline("guide")]);
  is("the club's page is the membership template", clubPage.blocks.slice(1).map((b) => b.kind), templateOutline("membership"));
  const answers = plannerPage.blocks.filter((b) => b.kind === "faq").flatMap((b) => (b as { items: { a: string }[] }).items.map((i) => i.a));
  is("no sentence is written for the creator: no answer is filled in", answers.filter((x) => x !== ""), []);
  const fresh = (await storeForEmail(owner))!;
  const listings = await Promise.all(fresh.catalog.items.map((item) => readListing(fresh, item.id)));
  is("each product is marked as having its page, so the editor and the product page find it, and removing it removes the page", listings.map((listing) => listing?.page), [true, true]);
  is("and no AI was asked for it", asked.length, asksBefore);
  is("the template follows the kind, and a free product gets the free one", [setupTemplate("download", false), setupTemplate("course", false), setupTemplate("call", false), setupTemplate("membership", false), setupTemplate("course", true), setupTemplate("odd", false)], ["guide", "course", "coaching", "membership", "free", "guide"]);
  await setFaq(owner, [{ q: "Mine", a: "My answer." }]);
  await keepStoreSetup(owner, (await storeForEmail(owner))!, { faq: [{ q: "Theirs", a: "Not kept." }] });
  is("questions already written are never replaced", (await storeForEmail(owner))!.faq, [{ q: "Mine", a: "My answer." }]);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
