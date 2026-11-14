/**
 * 618 [SZ2] unit 2, the two findings of the independent review of #3004
 * (proofs by Claude 1: tests/c1proof-sz2-u2-eu-words.test.ts and
 * tests/c1proof-sz2-u2-copy.test.ts, made permanent here).
 *
 *   - No country is closed in this unit (the cart still ships an incomplete
 *     product to the EU/EEA), so the studio says what is needed before selling
 *     there, never that the product "is not shipped" there; and a product that
 *     does not ship to the EU/EEA is not told about EU/EEA gaps.
 *   - Copying a shipped product to another store keeps its shipping and its
 *     legal information (only the main price's net quantity: options are not
 *     copied), so the creator's filled fields are not lost without a word.
 */
import { readFileSync } from "node:fs";
import { parseProduct } from "@/lib/catalog";
import { cartItemOf, cartShipping } from "@/lib/cart-shipping";
import { safetyGaps } from "@/lib/physical-legal";
import * as record from "@/lib/physical-legal-record";
import { copiedProduct, emptyProductLeft } from "@/lib/store-copy-rules";
import { done, is, part } from "./check";

type Summary = (shipsTo: readonly string[], info: unknown, hasPicture: boolean) => string;
const safetySummary = (record as unknown as Record<string, unknown>).safetySummary as Summary | undefined;
const summaryOf = (shipsTo: readonly string[], info: unknown, hasPicture: boolean): string =>
  typeof safetySummary === "function" ? safetySummary(shipsTo, info, hasPicture) : record.gapSummary(safetyGaps(null, hasPicture));

part("The studio words match what checkout does (no country is closed yet)");
const world = parseProduct({ id: "p1", title: "Book", priceCents: 3500, shipping: { cents: 600, region: "world", note: "" } })!;
const cart = cartShipping([cartItemOf(world)]);
is("the cart still ships an incomplete product to DE in this unit", cart.kind === "ships" && cart.countries.includes("DE"), true);
const said = summaryOf(world.shipping!.countries, world.legal?.safety ?? null, false);
is("so the studio does not say it is not shipped there", /not shipped/i.test(said), false);
is("it says what is needed before selling there", said.startsWith("Needed before selling to buyers in the EU/EEA: "), true);
is("the words of the gaps list", record.gapSummary(["manufacturer-name", "picture", "warnings"]), "Needed before selling to buyers in the EU/EEA: the manufacturer's name, a picture of the product and the warnings, or a check that it has none.");
is("nothing missing is no gaps sentence", record.gapSummary([]), "");
const form = readFileSync("components/physical-legal-editor.tsx", "utf8");
is("the form never says the product is not shipped", /not shipped/i.test(form), false);
is("the record words never say it either", /not shipped/i.test(readFileSync("lib/physical-legal-record.ts", "utf8")), false);
is("the form words the summary from where the product ships", form.includes("safetySummary(product.shipping.countries"), true);

part("A product that does not ship to the EU/EEA");
const usOnly = parseProduct({ id: "p2", title: "Mug", priceCents: 1500, shipping: { cents: 600, region: "us", note: "" } })!;
const usSaid = summaryOf(usOnly.shipping!.countries, null, false);
is("is not told about EU/EEA gaps", /Needed before|Not shipped/.test(usSaid), false);
is("is told it does not ship there", usSaid, "This product does not ship to the EU/EEA.");
const filled = {
  manufacturer: { name: "Harbor Print Co.", postal: "1 Dock Rd", electronic: "https://harbor.example/contact", country: "DE" },
  responsible: null,
  productType: "Cookbook",
  identifier: "",
  warnings: "",
  noWarnings: true,
};
is("a complete product shipped there", summaryOf(["US", "DE"], filled, true), "The EU/EEA product safety fields are filled.");
is("Norway counts as the EU/EEA", summaryOf(["NO"], null, true).startsWith("Needed before selling to buyers in the EU/EEA: "), true);

part("Copy of a shipped product with legal fields");
const legal = {
  safety: filled,
  prop65: "",
  quantities: [{ price: "", amount: "1.2", unit: "kg" }, { price: "o-gone", amount: "500", unit: "g" }],
};
const source = parseProduct({ id: "p1", title: "Book", priceCents: 3500, shipping: { cents: 600, region: "eu", note: "" }, legal })!;
is("the source reads its legal record", source.legal?.quantities.length, 2);
const left = emptyProductLeft();
const copy = copiedProduct(source, "p9", (id) => id, "2026-11-07T00:00:00.000Z", left);
is("shipping comes across", copy.shipping?.region, "eu");
is("the legal record comes across with the main price's quantity only", copy.legal ?? null, { safety: filled, prop65: "", quantities: [{ price: "", amount: "1.2", unit: "kg" }] });
is("nothing counted as left behind for it", left, emptyProductLeft());
const plain = copiedProduct(parseProduct({ id: "p3", title: "Guide", priceCents: 900 })!, "p8", (id) => id, "2026-11-07T00:00:00.000Z", emptyProductLeft());
is("a product without legal fields gets none", Object.hasOwn(plain, "legal"), false);
done();
