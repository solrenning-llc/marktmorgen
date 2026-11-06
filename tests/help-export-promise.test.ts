/**
 * The help answer "What happens when my plan ends?" promises only what the
 * store export does today (VR; Claude 1, C1-20261105-1836-C2-1), and is held
 * to the code it describes:
 *
 *   - one file, while the plan runs counted from the studio's requests by its
 *     size (app/api/store/export/route.ts takes exportUnits from the studio
 *     allowance), never "whatever your store's size";
 *   - after the plan ends, from the notice at the top of the studio, as many
 *     times as ENDED_STORE_EXPORTS allows, in words ("once" for 1);
 *   - what is in it, as storeExport writes it: contacts and orders as
 *     spreadsheet text inside the file, and a note when a store has more
 *     orders than one file reads (the rest stay on the creator's Stripe);
 *   - what is not in it, as storeExport's own note lists it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HELP_SECTIONS } from "@/lib/help-content";
import { ENDED_STORE_EXPORTS } from "@/lib/plan-closing-rules";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
const item = HELP_SECTIONS.flatMap((section) => section.items).find((entry) => entry.q === "What happens when my plan ends?");
const answer = (item?.a ?? []).find((paragraph) => /as one file/.test(paragraph)) ?? "";
const hasWord = (word: string) => new RegExp(`(^|[^a-z])${word}([^a-z]|$)`, "i").test(answer);
const route = read("app/api/store/export/route.ts");
const exporter = read("lib/store-export.ts");

part("The help answer is found");
is("the export paragraph of 'What happens when my plan ends?'", answer.length > 0, true);

part("What it promises about when and how often");
is("never 'whatever your store's size', 'everything' or 'the whole store'", /whatever your store.s size|\beverything\b|whole store|entire store/i.test(answer), false);
is("while the plan runs, counted from the studio's requests by its size, as the route does", [/counted from your studio.s requests by its size/.test(answer), /takeAllowance\(store, "studio", exportUnits\(/.test(route)], [true, true]);
const times = ENDED_STORE_EXPORTS === 1 ? "once" : `${ENDED_STORE_EXPORTS} times`;
is("after the plan ends, as many times as ENDED_STORE_EXPORTS, from the notice at the top of the studio", [answer.includes(`${times} from the notice at the top of your studio`), /ENDED_STORE_EXPORTS/.test(route)], [true, true]);

part("What it says is in the file, as storeExport writes it");
for (const word of ["products", "pages", "thank-you notes", "posts", "courses", "lesson", "forms", "answers", "contacts", "orders", "address", "name", "bio", "links", "currency"]) {
  is(`names ${word}`, hasWord(word), true);
}
is("contacts and orders as spreadsheet text inside the file, as the exporter writes them", [/contacts and orders as spreadsheet text/.test(answer), /"contactsCsv"/.test(exporter), /"ordersCsv"/.test(exporter)], [true, true, true]);
is("a store with more orders than one file reads is told so, and the rest stay on Stripe, as the file's own note says", [/more orders than one file reads/i.test(answer) && /your own Stripe account/.test(answer), /More orders than one file reads: the rest are on your own Stripe account\./.test(exporter)], [true, true]);

part("What it says is not in the file, as the file's own note lists it");
const left = (/"notIncluded":"([^"]*)"/.exec(exporter)?.[1] ?? "").toLowerCase();
for (const word of ["files", "videos", "community posts", "email sequences", "broadcasts", "reviews", "coupons", "affiliates", "funnels", "CRM deals", "tasks"]) {
  is(`leaves out ${word}, as the file says`, [left.includes(word.toLowerCase()), hasWord(word)], [true, true]);
}
is("nothing else is in it, and files and videos download from their own pages", [/Nothing else is in it\./.test(answer), /Files and videos download from their own pages\./.test(answer)], [true, true]);

done();
