/**
 * 567 [GD1] (d), unit 2: the sales page of a product is on the store with it,
 * so a promise of fast or easy money in any of its words (every block, its
 * second version, its search title and description: lib/page-translate.ts,
 * pageWords) is refused while the product is published, and checked again when
 * a draft is published. The page editor says it in the same words as the
 * product editor (fastMoneyMessage). Nothing the creator wrote is changed.
 *
 * What fails here: a promise in a page's words that passes; a subject or a
 * warning against it that is stopped; the routes saving or publishing without
 * the check; the page editor without the message.
 */
import { readFileSync } from "node:fs";
import { fastMoneyMessage, fastMoneyOnPage } from "@/lib/terms-check-rules";
import { pageWords } from "@/lib/page-translate";
import { EMPTY_PAGE, parsePage } from "@/lib/sales-page";
import { done, is, part } from "./check";

part("Every word a reader reads on the page is checked");
is("a promise in a block is found, as on the sales page", fastMoneyOnPage(["Ten loaves, step by step.", "Make easy money baking at home."])?.field, "page");
is("plain page words pass", fastMoneyOnPage(["Ten loaves, step by step.", "Easy Money Habits, the book club edition", "Avoid get-rich-quick schemes"]), null);
const page = parsePage({ ...EMPTY_PAGE, seoTitle: "Bread basics", seoDescription: "Get rich quick with sourdough", blocks: [] });
is("the search description is among the words read", pageWords(page).includes("Get rich quick with sourdough") && fastMoneyOnPage(pageWords(page))?.field === "page", true);
is("the editor names the sales page", /In the sales page/.test(fastMoneyMessage(fastMoneyOnPage(["Make easy money baking."]), "save")), true);

part("Both routes and the page editor");
const pageRoute = readFileSync("app/api/store/page/route.ts", "utf8");
is("a published product's page is refused before it is written", /product\.hidden !== true\)[\s\S]{0,200}fastMoneyOnPage\(pageWords\(page\)\)[\s\S]*writePage\(/.test(pageRoute), true);
const productRoute = readFileSync("app/api/store/product/route.ts", "utf8");
is("publishing a draft reads its page and checks it", /readPage\(guarded\.store\.statsId, draft\.id\)[\s\S]{0,200}fastMoneyOnPage\(pageWords\(shownPage\)\)/.test(productRoute), true);
is("the page editor says it in the same words", /data\.error === "fast_money" \? fastMoneyMessage\(/.test(readFileSync("components/page-editor.tsx", "utf8")), true);
done();
