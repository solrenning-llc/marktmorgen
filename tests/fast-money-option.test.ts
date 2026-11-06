/**
 * 567 [GD1] (d), unit 3: a price's name and its lines (a product's options,
 * app/api/store/option/route.ts) never promise fast or easy money, which the
 * Terms forbid: an option is shown wherever its product is, so it is refused as
 * it is written, with the passage, why and the fix, in the same words as the
 * rest (fastMoneyMessage). Ordinary price names pass.
 *
 * What fails here: the route saving an option without the check, or before it;
 * the editor without the message; an ordinary price name refused.
 */
import { readFileSync } from "node:fs";
import { fastMoneyMessage, fastMoneyRefusal } from "@/lib/terms-check-rules";
import { done, is, part } from "./check";

part("A price's name and lines");
is("a promise in a price's name is found", fastMoneyRefusal({ title: "Make easy money pack", summary: "", about: "" }) !== null, true);
is("a promise in its lines is found", fastMoneyRefusal({ title: "Pro", summary: "Templates\nEarn quick cash from day one", about: "" }) !== null, true);
for (const name of ["5 weeks", "Pro", "Quick start", "Easy Money Habits workbook", "Cash flow templates"]) is(`kept: ${name}`, fastMoneyRefusal({ title: name, summary: "", about: "" }), null);
is("the message names a price", /In a price's name or its lines/.test(fastMoneyMessage({ field: "option", excerpt: "Make easy money", why: "x", fix: "y" }, "save")), true);

part("The route and the editor");
const route = readFileSync("app/api/store/option/route.ts", "utf8");
is("adding and editing are checked before anything is saved", /action === "add" \|\| action === "edit"\)[\s\S]{0,200}fastMoneyRefusal\([\s\S]{0,300}error: "fast_money"[\s\S]*addOption\(ref/.test(route), true);
is("the product editor says it", /reason === "fast_money"\s*\?\s*fastMoneyMessage\(/.test(readFileSync("components/product-editor.tsx", "utf8")), true);
done();
