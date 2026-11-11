/**
 * 754 [STN1], unit 1: words a template left for the creator to write are never
 * shown to visitors. A part marked ⟦like this⟧ (lib/funnel-ai-rules.ts) and
 * a part in [brackets] from one of the campaigns (lib/funnel-starters.ts),
 * matched exactly, so the creator's own brackets are never taken for one,
 * stop a page from going out: a store's own page while it is shown or
 * scheduled, a product's page while the product is on the store, either
 * version. A hidden page and a draft's page keep them. The refusal says the
 * block and the part, so the editor can open that block.
 *
 * What fails here: a published product's page saved with a part to write in
 * either version; a shown store page saved with a campaign's [bracket]; a
 * refusal that does not say where; a hidden page or a draft's page refused;
 * the creator's own brackets refused.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import * as rules from "@/lib/template-text-rules";
import { MAX_PART_SHOWN, bracketPartsIn, partIn, templateLeftMessage, templateTextIn } from "@/lib/template-text-rules";
import { STARTER_PROMPTS, templateLeft } from "@/lib/template-text";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { FUNNEL_STARTERS } from "@/lib/funnel-starters";
import { BLOCK_KINDS, type BlockKind, type PageBlock, type Picture, type QuotesBlock, type TextBlock, type Video } from "@/lib/sales-page";
import { POST as savePage } from "@/app/api/store/page/route";
import { POST as sitePage } from "@/app/api/store/site-page/route";
import { POST as productRoute } from "@/app/api/store/product/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "template.words@example.com";
const ORIGIN = "https://marktmorgen.com";

/** A campaign's own part in [brackets], exactly as a page made from it holds it. */
const physical = FUNNEL_STARTERS.find((starter) => starter.id === "physical-product");
const STARTER_PART = "[Give its measurements and weight, what it is made of and how to look after it. Say anything it needs that is not in the box.]";

const PICTURE: Picture = { path: "pages/pic.webp", width: 800, height: 600, alt: "A loaf on a board", caption: "Day two" };
const VIDEO: Video = { provider: "youtube", id: "dQw4w9WgXcQ", hash: "" };
/**
 * One block of every kind with every field it holds written (Revisor 2 on
 * #3593): the type makes a new kind, or a new field a kind requires, a type
 * error here until it is added, and the check below sets each of its words
 * to a part left to write in turn.
 */
const EVERY_KIND: { [K in BlockKind]: Extract<PageBlock, { kind: K }> } = {
  hero: { id: "b-hero", kind: "hero", headline: "Bread at home", sub: "In a weekend", media: "video", video: VIDEO, layout: "split", button: true, screens: "phone", saved: "abcdefghij" },
  text: { id: "b-text", kind: "text", heading: "Why", body: "Because." },
  benefits: { id: "b-benefits", kind: "benefits", heading: "You get", items: ["A loaf", "A starter"] },
  inside: { id: "b-inside", kind: "inside", heading: "Inside", items: [{ title: "Flour", detail: "Which one" }] },
  bio: { id: "b-bio", kind: "bio", heading: "About me", body: "I bake.", photo: true },
  faq: { id: "b-faq", kind: "faq", heading: "Questions", items: [{ q: "How long?", a: "Two days." }] },
  guarantee: { id: "b-guarantee", kind: "guarantee", heading: "Guarantee", body: "30 days." },
  cta: { id: "b-cta", kind: "cta", label: "Buy it", note: "Instant access" },
  reviews: { id: "b-reviews", kind: "reviews", heading: "Reviews", first: ["0123456789abcdef01234567"] },
  video: { id: "b-video", kind: "video", heading: "A lesson", video: VIDEO, caption: "Lesson one" },
  pictures: { id: "b-pictures", kind: "pictures", heading: "Pages", items: [PICTURE] },
  countdown: { id: "b-countdown", kind: "countdown", heading: "Doors close", until: 1_900_000_000, note: "Then the price goes up" },
  fit: { id: "b-fit", kind: "fit", heading: "Who it is for", yesLabel: "For", noLabel: "Not for", yes: ["Beginners"], no: ["Pros"] },
  steps: { id: "b-steps", kind: "steps", heading: "How", items: [{ title: "Pay", detail: "Then read" }] },
  compare: { id: "b-compare", kind: "compare", heading: "Compare", columnA: "This", columnB: "A class", rows: [{ label: "Price", a: "$29", b: "$200" }] },
  bonuses: { id: "b-bonuses", kind: "bonuses", heading: "Bonuses", items: [{ title: "Recipes", detail: "Ten of them" }] },
  facts: { id: "b-facts", kind: "facts", heading: "By the numbers", show: ["lessons"] },
  feature: { id: "b-feature", kind: "feature", heading: "Shaping", body: "Fold it twice.", picture: PICTURE, side: "left" },
  product: { id: "b-product", kind: "product", heading: "Also", product: "p1", note: "Goes well with it" },
  quotes: { id: "b-quotes", kind: "quotes", heading: "Said elsewhere", items: [{ text: "Best bread course.", name: "Ana", url: "https://example.com/post" }] },
  form: { id: "b-form", kind: "form", heading: "Tell us", form: "f1" },
  row: {
    id: "b-row",
    kind: "row",
    columns: [
      [
        { kind: "heading", text: "One" },
        { kind: "subheading", text: "Two" },
        { kind: "paragraph", text: "Three" },
        { kind: "list", items: ["Four"] },
        { kind: "icon", name: "check", label: "Five" },
        { kind: "button", label: "Six", url: "https://example.com/six" },
      ],
      [
        { kind: "image", picture: PICTURE, decorative: false },
        { kind: "video", video: VIDEO, title: "Seven" },
        { kind: "video-window", video: VIDEO, title: "Eight", label: "Nine" },
      ],
    ],
  },
  booking: { id: "b-booking", kind: "booking", product: "c1", heading: "Book a call" },
  divider: { id: "b-divider", kind: "divider" },
  space: { id: "b-space", kind: "space", size: "small" },
};

/** Every string a block holds, by its path, but its own id and a kind, which say what it is. */
function wordPaths(value: unknown, path: (string | number)[] = []): (string | number)[][] {
  if (typeof value === "string") return [path];
  if (Array.isArray(value)) return value.flatMap((item, i) => wordPaths(item, [...path, i]));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => (key === "kind" || (path.length === 0 && key === "id") ? [] : wordPaths(item, [...path, key])));
  }
  return [];
}

/** A copy of the block with the string at `path` set to `words`. */
function withWordsAt<T>(block: T, path: (string | number)[], words: string): T {
  const copy = structuredClone(block) as Record<string | number, unknown>;
  let at = copy;
  for (const key of path.slice(0, -1)) at = at[key] as Record<string | number, unknown>;
  at[path[path.length - 1]] = words;
  return copy as T;
}

async function main(): Promise<void> {
  redis.clear();
  is("the campaign still holds the part this test uses", JSON.stringify(physical?.bundle.pages ?? []).includes(STARTER_PART), true);
  await claimHandle(OWNER, "templatewords", "Template Words", "");
  await ensureStatsId(OWNER);
  const shown = await addProduct(OWNER, "Guide", "", "29", null);
  const draft = await addProduct(OWNER, "Draft guide", "", "19", null, null, true);
  if (!shown.ok || !draft.ok) throw new Error("no product");
  const session = await openSession(OWNER);
  const post = async (route: (request: NextRequest) => Promise<Response>, path: string, body: Record<string, unknown>) => {
    const response = await route(
      new NextRequest(`${ORIGIN}/api/store/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` },
        body: JSON.stringify(body),
      }),
    );
    return { status: response.status, data: (await response.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const why: TextBlock = { id: "text0001", kind: "text", heading: "Why", body: "Because it works for me." };
  const marked: TextBlock = { id: "text0002", kind: "text", heading: "About me", body: "I teach bread. ⟦Add one sentence about who you are⟧" };
  const bracketed: TextBlock = { id: "text0003", kind: "text", heading: "Size and materials", body: STARTER_PART };
  const own: TextBlock = { id: "text0004", kind: "text", heading: "Notes", body: "Sizes run small [see the chart] and ship in 2 days [US only]." };
  /** A part ⟦like this⟧ written over two lines, with either line ending (Codex CX1, #3581). */
  const twoLines = [
    ["LF", { ...marked, body: "⟦Write the first line\nand the second line⟧" }],
    ["CRLF", { ...marked, body: "⟦Write the first line\r\nand the second line⟧" }],
  ] as const;

  part("A product's page, while the product is on the store");
  const refused = await post(savePage, "page", { id: shown.product.id, page: { blocks: [why, marked] } });
  is("a part ⟦like this⟧ is refused, with the block and the part", [refused.status, refused.data.error, refused.data.block, refused.data.kind, refused.data.part], [400, "placeholder", "text0002", "text", "⟦Add one sentence about who you are⟧"]);
  const second = await post(savePage, "page", { id: shown.product.id, page: { blocks: [why], variant: { id: "", blocks: [{ ...why, heading: "Why not" }, bracketed] } } });
  is("a campaign's part in the second version is refused too", [second.status, second.data.error, second.data.block, second.data.part], [400, "placeholder", "text0003", STARTER_PART]);
  for (const [ending, block] of twoLines) {
    const over = await post(savePage, "page", { id: shown.product.id, page: { blocks: [why, block] } });
    is(`a part ⟦like this⟧ over two lines (${ending}) is refused, with the block`, [over.status, over.data.error, over.data.block], [400, "placeholder", "text0002"]);
  }
  const ownWords = await post(savePage, "page", { id: shown.product.id, page: { blocks: [why, own] } });
  is("the creator's own brackets are words, and save", [ownWords.status, ownWords.data.ok], [200, true]);
  const kept = await post(savePage, "page", { id: draft.product.id, page: { blocks: [why, marked, bracketed] } });
  is("a draft's page keeps its parts to write", [kept.status, kept.data.ok], [200, true]);

  part("A store's own page, while it is shown or scheduled");
  const added = await post(sitePage, "site-page", { action: "add", title: "Your product", slug: "your-product" });
  const id = String(added.data.id);
  const open = await post(sitePage, "site-page", { action: "save", id, page: { blocks: [why, bracketed], hidden: false } });
  is("a campaign's part in [brackets] is refused, with the block and the part", [open.status, open.data.error, open.data.block, open.data.kind, open.data.part], [400, "placeholder", "text0003", "text", STARTER_PART]);
  const later = await post(sitePage, "site-page", { action: "save", id, page: { blocks: [bracketed], hidden: true, showFrom: Math.floor(Date.now() / 1000) + 3_600 } });
  is("nor scheduled to show by itself", [later.status, later.data.error], [400, "placeholder"]);
  const markedOut = await post(sitePage, "site-page", { action: "save", id, page: { blocks: [marked], hidden: false } });
  is("a part ⟦like this⟧ still is, now saying where", [markedOut.data.error, markedOut.data.block], ["placeholder", "text0002"]);
  for (const [ending, block] of twoLines) {
    const over = await post(sitePage, "site-page", { action: "save", id, page: { blocks: [why, block], hidden: false } });
    is(`a part ⟦like this⟧ over two lines (${ending}) is refused on a shown page, with the block`, [over.status, over.data.error, over.data.block], [400, "placeholder", "text0002"]);
    const kept = await post(sitePage, "site-page", { action: "save", id, page: { blocks: [why, block], hidden: true } });
    is(`kept hidden, a part over two lines (${ending}) saves`, kept.data.ok, true);
  }
  const hidden = await post(sitePage, "site-page", { action: "save", id, page: { blocks: [why, bracketed, marked], hidden: true } });
  is("kept hidden, it saves", hidden.data.ok, true);
  const written = await post(sitePage, "site-page", { action: "save", id, page: { blocks: [why, own], hidden: false } });
  is("once written in the creator's own words, it can be shown", written.data.ok, true);

  part("Every words field of every kind of block (Revisor 2 on #3593)");
  const quote = (text: string, name: string): QuotesBlock => ({ id: "quote001", kind: "quotes", heading: "Said elsewhere", items: [{ text, name, url: "https://example.com/post" }] });
  const quoteOut = await post(sitePage, "site-page", { action: "save", id, page: { blocks: [why, quote("⟦Paste what someone said about it⟧", "Ana")], hidden: false } });
  is("a quote's words left to write are refused on a shown page, with the block", [quoteOut.status, quoteOut.data.error, quoteOut.data.block, quoteOut.data.part], [400, "placeholder", "quote001", "⟦Paste what someone said about it⟧"]);
  const nameOut = await post(savePage, "page", { id: shown.product.id, page: { blocks: [why, quote("Best bread course.", "⟦Their name⟧")] } });
  is("a quote's name left to write is refused on a published product's page", [nameOut.status, nameOut.data.error, nameOut.data.block, nameOut.data.part], [400, "placeholder", "quote001", "⟦Their name⟧"]);
  const quoteHidden = await post(sitePage, "site-page", { action: "save", id, page: { blocks: [quote("⟦Paste what someone said about it⟧", "Ana")], hidden: true } });
  is("kept hidden, a quote left to write saves", quoteHidden.data.ok, true);
  is("a block of every kind is checked", BLOCK_KINDS.every(({ kind }) => kind in EVERY_KIND), true);
  const missed: string[] = [];
  let fields = 0;
  for (const block of Object.values(EVERY_KIND) as PageBlock[]) {
    is(`the ${block.kind} block, written, has no part left`, templateTextIn({ blocks: [block] }, STARTER_PROMPTS), null);
    for (const path of wordPaths(block)) {
      fields += 1;
      for (const [where, words] of [["marked", "⟦Write this⟧"], ["bracketed", STARTER_PART]] as const) {
        const left = withWordsAt(block, path, words);
        const found = templateLeft({ blocks: [why, left] });
        const second = templateLeft({ blocks: [why], variant: { id: "", blocks: [left] } as never });
        if (found?.block !== block.id || found.part !== words || second?.block !== block.id) missed.push(`${block.kind}.${path.join(".")} (${where})`);
      }
    }
  }
  is("every words field of every kind is read, in either version", { fields: fields > 60, missed }, { fields: true, missed: [] });

  part("Publishing a draft whose page has a part left (Revisor 2 on #3593)");
  const stillDraft = async () => (await readListing((await storeForEmail(OWNER))!, draft.product.id))?.hidden;
  const publish = () => post(productRoute, "product", { action: "visibility", id: draft.product.id, hidden: false });
  await post(savePage, "page", { id: draft.product.id, page: { blocks: [why, marked] } });
  const first = await publish();
  is("refused, saying the product, the block and the part, and it stays a draft", [first.status, first.data.error, first.data.product, first.data.field, first.data.block, first.data.kind, first.data.part, await stillDraft()], [409, "placeholder", "Draft guide", "block", "text0002", "text", "⟦Add one sentence about who you are⟧", true]);
  await post(savePage, "page", { id: draft.product.id, page: { blocks: [why], variant: { id: "", blocks: [{ ...why, heading: "Why not" }, quote("Best bread course.", "⟦Their name⟧")] } } });
  const inSecond = await publish();
  is("a part in the second version is refused too", [inSecond.status, inSecond.data.error, inSecond.data.block, await stillDraft()], [409, "placeholder", "quote001", true]);
  await post(savePage, "page", { id: draft.product.id, page: { blocks: [why], seoTitle: "Bread", seoDescription: STARTER_PART } });
  const inSearch = await publish();
  is("and a campaign's part in the search line", [inSearch.status, inSearch.data.field, inSearch.data.block, inSearch.data.part], [409, "search", null, STARTER_PART]);
  await post(savePage, "page", { id: draft.product.id, page: { blocks: [why, own] } });
  const clean = await publish();
  is("once written in the creator's own words, it is published", [clean.status, clean.data.ok, await stillDraft()], [200, true, false]);
  const publishMessage = (rules as Record<string, unknown>).templatePublishMessage as ((left: { field: string; kind: string | null; part: string }, product: string | null) => string) | undefined;
  is("the message says the product, where the part is, and the way on", [
    publishMessage?.({ field: "block", kind: "quotes", part: "⟦Their name⟧" }, "Draft guide"),
    publishMessage?.({ field: "search", kind: null, part: "[Your product]" }, null),
    publishMessage?.({ field: "test", kind: null, part: "⟦Say it⟧" }, "Guide"),
  ], [
    "“Draft guide” has a part for you to write on its sales page, in the Said elsewhere block: “⟦Their name⟧”. Open it under Sales pages, replace it with your own words, including the brackets, then publish it. Nothing was published.",
    "This product has a part for you to write on its sales page, in the search title or line: “[Your product]”. Open it under Sales pages, replace it with your own words, including the brackets, then publish it. Nothing was published.",
    "“Guide” has a part for you to write on its sales page, in the headline you are testing: “⟦Say it⟧”. Open it under Sales pages, replace it with your own words, including the brackets, then publish it. Nothing was published.",
  ]);
  const products = readFileSync("components/product-editor.tsx", "utf8");
  is("the product list says it when publishing, and never carries the campaigns", [/data\.error === "placeholder"[\s\S]{0,600}templatePublishMessage\(/.test(products), /from "@\/lib\/(template-text|funnel-starters)"/.test(products)], [true, false]);

  part("The rule, alone");
  is("every campaign part is read, each once, none a link's words", [STARTER_PROMPTS.length > 50, new Set(STARTER_PROMPTS).size === STARTER_PROMPTS.length, STARTER_PROMPTS.includes(STARTER_PART), STARTER_PROMPTS.every((p) => /^\[[^\]\n]{2,}\]$/.test(p))], [true, true, true, true]);
  is("a link's words in brackets are not a part", bracketPartsIn(["Read [the guide](https://example.com/guide) first."]), []);
  is("the first part met wins, marked or bracketed", [partIn("Hi ⟦name⟧ and [Your product]", ["[Your product]"]), partIn("[Your product] then ⟦name⟧", ["[Your product]"]), partIn("Plain words.", ["[Your product]"])], ["⟦name⟧", "[Your product]", null]);
  is("a part ⟦like this⟧ over two lines is one part, with either line ending", [partIn("Hi ⟦first\nsecond⟧ there", []), partIn("Hi ⟦first\r\nsecond⟧ there", [])], ["⟦first\nsecond⟧", "⟦first\r\nsecond⟧"]);
  is("a part in the search line is found and said there", templateLeft({ blocks: [why], seoTitle: "Bread", seoDescription: "⟦Say who it is for⟧" }), { field: "search", block: null, kind: null, part: "⟦Say who it is for⟧" });
  is("a part in the headline being tested is found", templateLeft({ blocks: [why], test: { id: "t1", headline: "[Your product]", sub: "" } as never })?.field, "test");
  is("a long part is shortened when said back", (templateTextIn({ blocks: [{ ...why, body: `⟦${"x".repeat(400)}⟧` }] }, [])?.part ?? "").length, MAX_PART_SHOWN);
  is("the creator's own brackets stay words", templateLeft({ blocks: [own] }), null);
  is("the message says the block, the part and the two ways on", [
    templateLeftMessage({ field: "block", part: "[Your product]" }, "Text", "site"),
    templateLeftMessage({ field: "search", part: "⟦Say who⟧" }, null, "product"),
  ], [
    "In the Text block, “[Your product]” is a part for you to write. Replace it with your own words, including the brackets, or keep the page hidden. Nothing was saved.",
    "In the search title or line, “⟦Say who⟧” is a part for you to write. Replace it with your own words, including the brackets, or take the product off your store first. Nothing was saved.",
  ]);

  part("The page editor");
  const editor = readFileSync("components/page-editor.tsx", "utf8");
  is("it says where the part is and opens that block", /data\.error === "placeholder"[\s\S]{0,900}templateLeftMessage\([\s\S]{0,200}if \(block\) show\(block\.id\)/.test(editor), true);
  is("it never carries the campaigns", /from "@\/lib\/(template-text|funnel-starters)"/.test(editor), false);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
