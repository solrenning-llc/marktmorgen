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
import { factsFor, PAGE_GOES_ON, REFUND_ON_PAGE } from "@/lib/answers";
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
  const picture = (alt: string) => ({ path: `images/${"a".repeat(24)}/${String(alt.length).padStart(32, "0")}.webp`, width: 800, height: 600, alt, caption: "" });
  const page = parsePage({
    blocks: [
      {
        id: "row00001",
        kind: "row",
        columns: [
          [
            { kind: "icon", name: "clock", label: "Twenty minutes" },
            { kind: "heading", text: "Fast dinners" },
            { kind: "paragraph", text: "Every recipe takes under twenty minutes." },
          ],
          [
            { kind: "subheading", text: "What you get" },
            { kind: "list", items: ["Seven recipes", "One grocery list"] },
            { kind: "image", picture: picture("A printed grocery list on a table"), decorative: false },
            { kind: "image", picture: picture("Swirls"), decorative: true },
          ],
          [
            { kind: "button", label: "See the recipes", url: "https://example.com/secret-recipes" },
            { kind: "icon", name: "sparkle", label: "" },
          ],
        ],
      },
    ],
  });
  if (page.blocks[0]?.kind !== "row") throw new Error("the row was not kept");

  part("What a row says is a fact, column by column, in the page's order");
  const facts = factsFor(store, product, "", page);
  const said = ["Twenty minutes", "Fast dinners", "Every recipe takes under twenty minutes.", "What you get", "- Seven recipes", "- One grocery list", "A printed grocery list on a table", "See the recipes"];
  is("every word the row shows is there", said.map((words) => facts.includes(words)), said.map(() => true));
  is("in the order the page shows them", said.map((words) => facts.indexOf(words)).every((at, i, all) => i === 0 || at > all[i - 1]), true);
  is("under a line that says they are columns on the page", /Columns on the page/.test(facts), true);

  part("Nothing the row does not say");
  is("a button's address is never told", facts.includes("secret-recipes"), false);
  is("a decorative picture says nothing", facts.includes("Swirls"), false);
  {
    // A video behind a button is on the page, so it is a fact (review of #2135).
    const page2 = { blocks: [{ id: "row00009", kind: "row", columns: [[{ kind: "video-window", video: { provider: "youtube", id: "dQw4w9WgXcQ" }, title: "The tour", label: "Watch the tour" }]] }] } as unknown as Parameters<typeof factsFor>[3];
    is("a video in a window is told, with its button's words and its title", factsFor(store, product, "", page2).includes('A video, opened from the button "Watch the tour": The tour'), true);
  }
  is("an empty row adds nothing", factsFor(store, product, "", parsePage({ blocks: [{ id: "row00002", kind: "row", columns: [[{ kind: "icon", name: "sparkle", label: "" }]] }] })).includes("Columns on the page"), false);

  part("A picture's caption is printed under it, so it is a fact too (inbox C4-16 (e))");
  const captioned = (alt: string, caption: string) => ({ ...picture(alt), caption });
  const withCaptions = factsFor(store, product, "", parsePage({
    blocks: [
      { id: "row00003", kind: "row", columns: [[{ kind: "image", picture: captioned("A bowl of soup", "Ready in twelve minutes"), decorative: false }, { kind: "image", picture: captioned("Swirls", "Printed on recycled paper"), decorative: true }]] },
      { id: "feat0001", kind: "feature", heading: "Shop once a week", body: "One list for the whole week.", picture: captioned("A full grocery bag", "Everything for seven dinners"), side: "left" },
    ],
  }));
  is("a row's picture says its words and its caption", ["A bowl of soup", "Ready in twelve minutes"].map((words) => withCaptions.includes(words)), [true, true]);
  is("a decorative picture's caption is printed, so it is told, its description is not", [withCaptions.includes("Printed on recycled paper"), withCaptions.includes("Swirls")], [true, false]);
  is("told as a caption of its own, never \"Under it\" with nothing above", [withCaptions.includes("A caption: Printed on recycled paper"), withCaptions.includes("Under it: Printed on recycled paper")], [true, false]);
  is("a picture-and-text block says its words, its picture and its caption", ["One list for the whole week.", "A full grocery bag", "Everything for seven dinners"].map((words) => withCaptions.includes(words)), [true, true, true]);

  part("The creator's own notes are never what the length cut takes (inbox C4-16 (f))");
  const NOTES = "Orders placed on Sunday ship on Monday.";
  const noted = { ...store, answers: { ...store.answers, facts: NOTES } };
  const long = factsFor(noted, product, "A long description. ".repeat(2_000), page);
  is("a page longer than the facts may be still keeps the notes, whole, at the end", [long.length <= MAX_FACTS_CHARS, long.endsWith(NOTES)], [true, true]);
  {
    // Review of #2177 and Codex D2's: the page is cut between its parts, never inside one, so no line reaches the model
    // without the line after it; a part too long for the room is left out whole and the model is told the page goes on.
    const parts = Array.from({ length: 800 }, (_, i) => `Line ${i}: the price is $129.`).join("\n");
    const cut = factsFor(noted, product, parts, page);
    is("a description longer than the room is left out whole, the page said to go on, the notes kept", [cut.length <= MAX_FACTS_CHARS, cut.includes("Line 0:"), cut.includes(PAGE_GOES_ON), cut.endsWith(NOTES)], [true, false, true, true]);
  }
  is("and a short page keeps everything, the notes last", factsFor(noted, product, "", page).endsWith(NOTES) && factsFor(noted, product, "", page).includes("Fast dinners"), true);

  part("A promise and its condition reach the model together or not at all (Codex D's review of #2177)");
  {
    // Codex D's case (codex/d-review-2177-refund-red): a valid page whose text blocks end just before the guarantee,
    // so that cutting at a line's end kept the refund promise and dropped the condition under it.
    const PROMISE = "Full refunds are available within fourteen days.";
    const CONDITION = "Only if the purchased file has never been downloaded.";
    const baseline = factsFor(noted, product, "", null);
    const fixed = baseline.slice(0, baseline.lastIndexOf("\n\nWhat "));
    const room = MAX_FACTS_CHARS - (baseline.length - fixed.length);
    let remaining = room - fixed.length - "\n\nThe creator's refund promise, in their words:\n".length - PROMISE.length - 2;
    const blocks: Record<string, unknown>[] = [];
    while (remaining > 0) {
      const n = Math.min(3_000, remaining - 2);
      if (n <= 0) throw new Error("bad test boundary");
      blocks.push({ id: `fill${String(blocks.length).padStart(4, "0")}`, kind: "text", heading: "", body: "x".repeat(n) });
      remaining -= n + 2;
    }
    blocks.push({ id: "refund01", kind: "guarantee", heading: "Refunds", body: `${PROMISE}\n${CONDITION}` });
    const boundary = parsePage({ blocks });
    is("the page parser keeps every block and the whole guarantee", [boundary.blocks.length, boundary.blocks.some((b) => b.kind === "guarantee" && b.body.includes(CONDITION))], [blocks.length, true]);
    const facts = factsFor(noted, product, "", boundary);
    is("the refund promise is told with its condition, the notes kept, within the limit", [facts.includes(PROMISE), facts.includes(CONDITION), facts.endsWith(NOTES), facts.length <= MAX_FACTS_CHARS], [true, true, true, true]);
    is("the text that gave way says the page goes on", facts.includes(PAGE_GOES_ON), true);

    // More refund terms than the room holds: each guarantee is told whole or left out whole, and the model is told
    // the page has refund terms it was not given, so it never takes their absence for "no refunds".
    const many = parsePage({
      blocks: Array.from({ length: 20 }, (_, i) => ({ id: `refund${String(i).padStart(2, "0")}`, kind: "guarantee", heading: "", body: `Promise ${i}: ${"y".repeat(900)}\nCondition ${i}: only if never downloaded.` })),
    });
    const crowded = factsFor(noted, product, "", many);
    const told = Array.from({ length: 20 }, (_, i) => [crowded.includes(`Promise ${i}:`), crowded.includes(`Condition ${i}:`)]);
    is("no guarantee is told without its condition", told.every(([p, c]) => p === c), true);
    is("some are told and some left out, within the limit, the notes kept", [told.some(([p]) => p), told.some(([p]) => !p), crowded.length <= MAX_FACTS_CHARS, crowded.endsWith(NOTES)], [true, true, true, true]);
    is("the refund terms left out are said to be on the page", crowded.includes(REFUND_ON_PAGE), true);
    is("and that is never said when every refund term was told", [facts.includes(REFUND_ON_PAGE), factsFor(noted, product, "", null).includes(REFUND_ON_PAGE)], [false, false]);

    // A question's answer is a term too (a refund, a delivery time, a price): told whole or not at all.
    const ANSWER_LINE_2 = "Unless the order was a gift card.";
    const asked = parsePage({
      blocks: [
        ...blocks.slice(0, -1),
        { id: "faq00001", kind: "faq", heading: "", items: [{ q: "Can I get a refund?", a: `Yes, within fourteen days.\n${ANSWER_LINE_2}` }] },
      ],
    });
    const answered = factsFor(noted, product, "", asked);
    is("a question's answer is never told without its second line", answered.includes("Yes, within fourteen days.") === answered.includes(ANSWER_LINE_2), true);
    is("and the price, told first, is always whole", answered.includes(`Price: ${baseline.split("Price: ")[1].split("\n")[0]}`), true);
  }

  done();
}

void main();
