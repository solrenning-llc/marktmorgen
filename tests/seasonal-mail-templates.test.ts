/**
 * 624 [SZ8](29): seasonal email templates (a sale such as Black Friday, the
 * end of the year, back to learning), with nothing that hurries the reader
 * and nothing written in the creator's name.
 */
import { MAIL_TEMPLATES, hasPlaceholder, serializeMailBlocks, type MailBlock } from "@/lib/mail-body";
import { templateLibraryCards } from "@/lib/template-library";
import { libraryDestination } from "@/lib/template-library-rules";
import { done, is, part } from "./check";

const SEASONAL = ["sale", "year-end", "back-to-school"];
const seasonal = MAIL_TEMPLATES.filter((t) => SEASONAL.includes(t.id));
const words = (block: MailBlock): string[] =>
  block.kind === "heading" || block.kind === "text" ? [block.text] : block.kind === "list" ? block.items : block.kind === "button" ? [block.label] : block.kind === "picture" ? [block.line] : [];
// Pressure a template must never carry: invented urgency or scarcity, a countdown, a claim about other buyers.
const PRESSURE = /\b(hurry|last chance|don'?t miss|ends? (tonight|today|soon)|only \d+ left|limited time|act now|countdown|selling fast|almost gone|while (it|they|stocks?) lasts?|best ?seller|everyone is)\b/i;

part("The three seasonal templates");
is("all three are offered, after the others", seasonal.map((t) => t.id), SEASONAL);
is("the older templates keep their place", MAIL_TEMPLATES.slice(0, 4).map((t) => t.id), ["news", "launch", "welcome", "spotlight"]);
for (const template of seasonal) {
  is(`${template.id}: every line is a part to write, never words sent in the creator's name`, template.blocks.flatMap(words).every((line) => /^⟦[^⟧\n]+⟧$/.test(line)), true);
  is(`${template.id}: so it cannot be sent as it is`, hasPlaceholder(serializeMailBlocks(template.blocks)), true);
  is(`${template.id}: nothing hurries the reader`, PRESSURE.test([template.label, template.hint, ...template.blocks.flatMap(words)].join(" ")), false);
  is(`${template.id}: a heading first and one button`, [template.blocks[0].kind, template.blocks.filter((b) => b.kind === "button").length], ["heading", 1]);
}
const sale = seasonal.find((t) => t.id === "sale")!;
const saleWords = sale.blocks.flatMap(words).join(" ");
is("a sale asks for the usual price beside the sale price", /sale price and its usual price/.test(saleWords), true);
is("an end date only as set in the store, and none if it has none", /as set in your store\. Leave this out if it has no end/.test(saleWords), true);
is("the occasion is the creator's to name", sale.label.includes("Black Friday") && /Why there is a sale now/.test(saleWords), true);
is("the end of the year needs no sale", seasonal.find((t) => t.id === "year-end")!.hint.includes("No sale needed"), true);

part("In the template library");
const cards = templateLibraryCards({ fromName: "Shop", storeLink: "https://marktmorgen.com/@shop", ordersLink: "https://marktmorgen.com/@shop/orders", product: null, paidCount: 0 }).filter((c) => c.kind === "email");
const goal = (id: string) => cards.find((c) => c.id === id)?.goal;
is("each is an email card with its goal", SEASONAL.map(goal), ["sales", "leads", "teaching"]);
is("each opens the email studio with its blocks", SEASONAL.map((id) => libraryDestination(cards.find((c) => c.id === id)!, "shop")), SEASONAL.map((id) => `/studio/email?store=shop&emailTemplate=${id}`));

done();
