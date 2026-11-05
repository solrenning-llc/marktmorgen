import { storeExport } from "@/lib/store-export";
import type { Store } from "@/lib/store";
import { state } from "./review-u2683-export-world";
import { done, is } from "./check";

const store = { statsId: "fixture-stats", handle: "sample", name: "Sample", bio: "A synthetic store", links: [], currency: "USD", createdAt: 1 } as unknown as Store;
const take = async () => JSON.parse(await new Response(storeExport(store, 0)).text());

async function main() {
  const normal = await take();
  is("the real stream is JSON with the seven named data parts and its exclusion note", Object.keys(normal).sort(), ["exportedAt", "store", "products", "courses", "posts", "forms", "contactsCsv", "ordersCsv", "notIncluded"].sort());
  is("the real store part holds the six properties described by the help", normal.store, { handle: "sample", name: "Sample", bio: "A synthetic store", links: [], createdAt: 1, currency: "USD" });
  is("the product includes its page, description and thank-you note", [normal.products[0].page, normal.products[0].about, normal.products[0].thanks], [{ title: "A page" }, "A product's full description.", "Thank you."]);
  is("each fixture lesson's actual text is carried in the course", normal.courses[0].lessonText, { "fixture-lesson": "A lesson's full text." });
  is("the form response is carried with its form", normal.forms[0].answers[0].answers, { sample: "A synthetic answer" });
  is("contacts and orders are spreadsheet text inside JSON", [normal.contactsCsv, normal.ordersCsv], ['"email"\n"buyer@example.test"', '"paid_with"\n"stripe"']);
  is("an ordinary complete sales reading adds no partial-sales note", Object.hasOwn(normal, "ordersNote"), false);
  is("the payload names the excluded community, mail and CRM content", ["community posts", "email sequences", "CRM deals and tasks"].map(word => normal.notIncluded.includes(word)), [true, true, true]);

  state.partial = true;
  const partial = await take();
  is("a partial sales reading adds the promised note", partial.ordersNote, "More orders than one file reads: the rest are on your own Stripe account.");
  is("a partial reading still preserves the returned spreadsheet text", partial.ordersCsv, normal.ordersCsv);

  state.connected = false;
  const unconnected = await take();
  is("no sales connection is explicitly distinguished", [unconnected.ordersCsv, unconnected.ordersNote], ["", "No Stripe or PayPal account was connected, so there are no orders to list."]);

  state.formsFail = true;
  const unread = await take();
  is("an unavailable section is named in the real stream instead of breaking JSON", unread.unreadPart4, "This part could not be read just now. Download the file again in a few minutes.");
  is("the later contacts section survives a failed form read", unread.contactsCsv, normal.contactsCsv);
  done();
}
void main();
