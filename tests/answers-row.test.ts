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

  done();
}

void main();
