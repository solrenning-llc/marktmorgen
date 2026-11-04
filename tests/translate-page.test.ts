/**
 * A whole sales page translated (lib/page-translate.ts, lib/ai.ts
 * translatePage). The model is played by a stand-in for `fetch` that
 * "translates" by writing every string in capitals. Checked: every word a
 * reader reads is taken, in order, and nothing else (ids, pictures' files,
 * videos, a product picked for a card, a comparison's ticks); the words go
 * back where they came from; a long page goes in parts, each part one of the
 * month's jobs; an answer that does not fit changes nothing and is not
 * counted; a page too long is refused before the model is asked.
 */
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { answerModel, translatePage } from "@/lib/ai";
import { CELL_NO, CELL_YES, parsePage } from "@/lib/sales-page";
import { MAX_TRANSLATE_PARTS, TRANSLATE_PART_CHARS, pageWords, translateParts, withWords } from "@/lib/page-translate";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

let mode: "caps" | "short" | "longer" | "same" = "caps";
const asked: { system: string; model: string; strings: string[] }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.anthropic.com") return new Response("{}", { status: 404 });
  const body = JSON.parse(String(init?.body)) as { system: string; model: string; messages: { content: string }[] };
  const strings = JSON.parse(body.messages[0].content) as string[];
  asked.push({ system: body.system, model: body.model, strings });
  const t =
    mode === "caps" ? strings.map((s) => s.toUpperCase())
    : mode === "longer" ? strings.map((s) => `${s} (translated)`)
    : mode === "same" ? strings.map(() => "EMPIEZA HOY")
    : strings.slice(1);
  return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ t }) }] }));
}) as typeof fetch;

const picture = { path: `images/${"a".repeat(24)}/${"b".repeat(32)}.webp`, width: 800, height: 600, alt: "A loaf on a board", caption: "Day one" };
const page = parsePage({
  seoTitle: "Sunday Baking",
  seoDescription: "Bread for the weekend",
  blocks: [
    { id: "hero0001", kind: "hero", headline: "Bake bread on Sunday", sub: "Six loaves, step by step", media: "picture", video: null, button: true },
    { id: "bene0001", kind: "benefits", heading: "What you get", items: ["Six recipes", "A shopping list"] },
    { id: "faq00001", kind: "faq", heading: "Questions", items: [{ q: "Do I need a mixer?", a: "No." }] },
    { id: "comp0001", kind: "compare", heading: "Compared", columnA: "This", columnB: "Alone", rows: [{ label: "Recipes tested", a: CELL_YES, b: CELL_NO }] },
    { id: "pict0001", kind: "pictures", heading: "", items: [picture] },
    { id: "prod0001", kind: "product", heading: "Goes well with", product: "p".repeat(12), note: "" },
    { id: "cta00001", kind: "cta", label: "Get the recipes", note: "" },
  ],
});

async function main(): Promise<void> {
  part("The words taken");
  const words = pageWords(page);
  is("every word a reader reads, in order, and nothing else", words, [
    "Bake bread on Sunday",
    "Six loaves, step by step",
    "What you get",
    "Six recipes",
    "A shopping list",
    "Questions",
    "Do I need a mixer?",
    "No.",
    "Compared",
    "This",
    "Alone",
    "Recipes tested",
    "A loaf on a board",
    "Day one",
    "Goes well with",
    "Get the recipes",
    "Sunday Baking",
    "Bread for the weekend",
  ]);
  const back = withWords(page, words.map((w) => w.toUpperCase()));
  const pics = back.blocks[4] as Extract<(typeof back.blocks)[number], { kind: "pictures" }>;
  const compare = back.blocks[3] as Extract<(typeof back.blocks)[number], { kind: "compare" }>;
  is("put back where they came from", [back.blocks[0].kind === "hero" && back.blocks[0].headline, pics.items[0].alt, back.seoTitle], ["BAKE BREAD ON SUNDAY", "A LOAF ON A BOARD", "SUNDAY BAKING"]);
  is("with ids, files, checks and the product picked untouched", [back.blocks.map((b) => b.id), pics.items[0].path, compare.rows[0].a, compare.rows[0].b, (back.blocks[5] as { product: string }).product], [page.blocks.map((b) => b.id), picture.path, CELL_YES, CELL_NO, "p".repeat(12)]);
  is("a word missing keeps the original", withWords(page, ["Hornea pan"]).blocks[1], page.blocks[1]);
  const many = Array.from({ length: 30 }, () => "x".repeat(500));
  is("a long page split in parts of at most the size asked", translateParts(many).map((p) => p.join("").length <= TRANSLATE_PART_CHARS), Array(4).fill(true));

  part("Translated");
  redis.clear();
  process.env.ANTHROPIC_API_KEY = `sk-ant-api03-${"x".repeat(40)}`;
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const store = (await storeForEmail("owner@example.com"))!;
  const result = await translatePage(store, { page, language: "Spanish" });
  is("by the smaller model, told the language and to add nothing", [asked[0].model, asked[0].system.includes("into Spanish"), asked[0].system.includes("Add nothing and leave nothing out")], [answerModel(), true, true]);
  is("the page back in the new words", result.ok ? [(result.value.page.blocks[0] as { headline: string }).headline, result.value.page.seoDescription] : null, ["BAKE BREAD ON SUNDAY", "BREAD FOR THE WEEKEND"]);
  is("one of the month's jobs for a short page", result.ok ? result.left : null, 39);

  const longPage = parsePage({ blocks: Array.from({ length: 3 }, (_, i) => ({ id: `text000${i}`, kind: "text", heading: "", body: "word ".repeat(900) })) });
  asked.length = 0;
  const long = await translatePage(store, { page: longPage, language: "German" });
  is("a longer page asked in parts at once, each part a job", [asked.length, long.ok ? long.left : null], [translateParts(pageWords(longPage)).length, 39 - translateParts(pageWords(longPage)).length]);

  part("What changes nothing");
  mode = "short";
  const before = long.ok ? long.left : 0;
  const bad = await translatePage(store, { page, language: "French" });
  mode = "caps";
  const after = await translatePage(store, { page, language: "French" });
  is("an answer with a string missing is refused but its attempt stays counted", [bad.ok, after.ok ? after.left : null], [false, before - 2]);
  asked.length = 0;
  const huge = parsePage({ blocks: Array.from({ length: MAX_TRANSLATE_PARTS + 2 }, (_, i) => ({ id: `huge${String(i).padStart(4, "0")}`, kind: "text", heading: "", body: "w".repeat(TRANSLATE_PART_CHARS) })) });
  const refused = await translatePage(store, { page: huge, language: "Dutch" });
  is("a page too long, before the model is asked", [refused.ok ? null : refused.reason, asked.length], ["long", 0]);
  const empty = await translatePage(store, { page: parsePage({ blocks: [] }), language: "Dutch" });
  is("a page with no words", empty.ok ? null : empty.reason, "notes");

  part("A block kept whole, and the second version (inbox C4-17)");
  const booking = { id: "book0001", kind: "booking", product: "c".repeat(10), heading: "x".repeat(95) };
  const kept = parsePage({ blocks: [booking, { id: "text0001", kind: "text", heading: "Why talk", body: "Twenty minutes." }] });
  mode = "longer";
  const longer = await translatePage(store, { page: kept, language: "German" });
  is(
    "a heading the translation makes too long: the block stays as it was, counted, and the rest is translated",
    longer.ok ? [longer.value.untranslated, longer.value.page.blocks.map((b) => b.kind), longer.value.page.blocks[0], (longer.value.page.blocks[1] as { heading: string }).heading] : null,
    [1, ["booking", "text"], kept.blocks[0], "Why talk (translated)"],
  );
  const withB = parsePage({
    blocks: [{ id: "hero0001", kind: "hero", headline: "Start today", sub: "", media: "none", video: null }],
    variant: { id: "", blocks: [{ id: "hero0001", kind: "hero", headline: "Begin today", sub: "", media: "none", video: null }] },
  });
  is("a page with a second version to start with", withB.variant !== null, true);
  mode = "same";
  const same = await translatePage(store, { page: withB, language: "Spanish" });
  is(
    "a second version the translation makes the same as the first is dropped, never kept whole in the old language",
    same.ok ? [same.value.page.variant, (same.value.page.blocks[0] as { headline: string }).headline, same.value.untranslated] : null,
    [null, "EMPIEZA HOY", 0],
  );
  const bWithBooking = parsePage({
    blocks: [{ id: "text0001", kind: "text", heading: "Why", body: "One." }],
    variant: { id: "", blocks: [{ id: "text0001", kind: "text", heading: "Why not", body: "Two." }, booking] },
  });
  mode = "longer";
  const second = await translatePage(store, { page: bWithBooking, language: "German" });
  const b = second.ok ? second.value.page.variant : null;
  is(
    "in the second version, its own words translated and only the refused block as it was",
    b ? [(b.blocks[0] as { heading: string }).heading, b.blocks[1], second.ok ? second.value.untranslated : null] : null,
    ["Why not (translated)", bWithBooking.variant?.blocks[1], 1],
  );
  mode = "caps";
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
