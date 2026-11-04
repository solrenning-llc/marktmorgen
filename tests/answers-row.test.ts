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
    // Review of #2177: the page is cut between its parts, never inside one, so no price reaches the model half read.
    const parts = Array.from({ length: 800 }, (_, i) => `Line ${i}: the price is $129.`).join("\n");
    const cut = factsFor(noted, product, parts, page);
    const pagePart = cut.slice(0, cut.lastIndexOf("\n\nWhat "));
    is("a long page is cut at the end of a line: its last line whole", [cut.length <= MAX_FACTS_CHARS, /the price is \$129\.$/.test(pagePart.trimEnd())], [true, true]);
  }
  is("and a short page keeps everything, the notes last", factsFor(noted, product, "", page).endsWith(NOTES) && factsFor(noted, product, "", page).includes("Fast dinners"), true);

  done();
}

void main();
