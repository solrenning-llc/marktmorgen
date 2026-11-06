/**
 * 618 [SZ2] unit 2: the legal information fields of a physical product are
 * stored on its own product record and edited in the studio
 * (docs/sz2-physical-legal-fields.md, "Next units", 1).
 *
 *   - what the creator sends is checked on the server with lib/physical-legal.ts;
 *     anything invalid is refused with the field it is about, never cut or blanked;
 *   - saved only on a product that is shipped, with a net quantity only for a price it has;
 *   - kept on the product record (read back by parseProduct), left out of the
 *     listing, kept when shipping changes, and a malformed stored record reads as
 *     nothing filled (every EU/EEA gap open), never as complete;
 *   - the route answers with the saved product; the studio confirms the save only
 *     when that answer carries exactly what it sent (an unknown answer is not a save);
 *   - the studio block has visible labels, field-named errors and the gaps summary;
 *     what buyers see and the checkout countries are unit 3's (tests/sz2-u3-display.test.ts).
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { addOption, addProduct, claimHandle, ensureStatsId, setProductLegal, setProductShipping, setStripeAccount, setSubscription } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { listingOf, parseProduct, readProduct } from "@/lib/catalog";
import { storeForEmail } from "@/lib/store";
import { parseShipping } from "@/lib/shipping";
import { safetyGaps } from "@/lib/physical-legal";
import { LEGAL_LABELS, checkLegalWrite, confirmsLegal, gapSummary, legalProblemMessage, readPhysicalLegal } from "@/lib/physical-legal-record";
import { AGENT_COVERAGE } from "@/lib/agent-coverage";
import { POST as legalRoute } from "@/app/api/store/physical-legal/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "sz2-owner@example.com";

const SAFETY = {
  manufacturer: { name: "Harbor Print Co.", postal: "1 Dock Rd, Austin, TX 78701", electronic: "safety@harbor.example", country: "US" },
  responsible: { name: "EU Rep GmbH", postal: "Hafenstr. 1, 20457 Hamburg", electronic: "https://eurep.example/contact", country: "DE" },
  productType: "Hardcover cookbook, 120 pages",
  identifier: "Batch 2026-11",
  warnings: "",
  noWarnings: true,
};
const PROP65 = "WARNING: This product can expose you to lead, which is known to the State of California to cause cancer. For more information go to www.P65Warnings.ca.gov.";

async function main(): Promise<void> {
  redis.clear();

  part("Checked on the server, field by field");
  const good = checkLegalWrite({ safety: SAFETY, prop65: PROP65, quantities: [{ price: "", amount: "1.2", unit: "kg" }] });
  is("a complete record is taken as typed", good.ok ? [good.legal.safety?.manufacturer.name, good.legal.safety?.responsible?.country, good.legal.prop65, good.legal.quantities] : good.problems, ["Harbor Print Co.", "DE", PROP65, [{ price: "", amount: "1.2", unit: "kg" }]]);
  const partial = checkLegalWrite({ safety: { manufacturer: { name: "Harbor Print Co." } }, prop65: "", quantities: [] });
  is("a partial record can be saved (its gaps stay listed)", partial.ok ? safetyGaps(partial.legal.safety, true) : partial.problems, ["manufacturer-postal", "manufacturer-electronic", "manufacturer-country", "type", "warnings"]);
  const bad = checkLegalWrite({
    safety: {
      manufacturer: { name: "x".repeat(201), postal: "1 Dock Rd\u0007", electronic: "not an address", country: "ZZ" },
      responsible: { name: "", postal: "", electronic: "http://eurep.example", country: "" },
      productType: "Cookbook",
      warnings: "Keep away from fire.",
      noWarnings: true,
    },
    prop65: "This product contains lead.",
    quantities: [{ price: "", amount: "0", unit: "kg" }, { price: "", amount: "1", unit: "kg" }],
  });
  is(
    "an invalid record is refused, each problem naming its field",
    bad.ok ? "saved" : bad.problems,
    [
      { field: "manufacturer.name", problem: "long" },
      { field: "manufacturer.postal", problem: "control" },
      { field: "manufacturer.electronic", problem: "address" },
      { field: "manufacturer.country", problem: "country" },
      { field: "responsible.electronic", problem: "address" },
      { field: "warnings", problem: "both" },
      { field: "prop65", problem: "signal" },
      { field: "quantity:", problem: "amount" },
    ],
  );
  is("never cut or blanked: an overlong value is a refusal, not a shorter value", checkLegalWrite({ safety: { productType: "t".repeat(201) } }).ok, false);
  is("a Prop 65 text without the site is refused", checkLegalWrite({ prop65: "WARNING: lead." }).ok ? "saved" : (checkLegalWrite({ prop65: "WARNING: lead." }) as { problems: unknown[] }).problems, [{ field: "prop65", problem: "site" }]);
  is("the same price twice is refused", (checkLegalWrite({ quantities: [{ price: "", amount: "1", unit: "kg" }, { price: "", amount: "2", unit: "kg" }] }) as { ok: boolean }).ok, false);
  is("an empty amount is no quantity, not an error", checkLegalWrite({ quantities: [{ price: "", amount: " ", unit: "kg" }] }), { ok: true, legal: { safety: null, prop65: "", quantities: [] } });
  is("a shape that is not a record is refused", [checkLegalWrite("x").ok, checkLegalWrite([]).ok, checkLegalWrite({ quantities: "1 kg" }).ok, checkLegalWrite({ safety: { noWarnings: "yes" } }).ok], [false, false, false, false]);
  is(
    "the messages name the field in plain words",
    [legalProblemMessage({ field: "manufacturer.electronic", problem: "address" }), legalProblemMessage({ field: "manufacturer.name", problem: "long" }), legalProblemMessage({ field: "prop65", problem: "site" }), legalProblemMessage({ field: "warnings", problem: "both" })],
    [
      "Manufacturer email or web page: type an email address, or a web page that starts with https://.",
      "Manufacturer name: use up to 200 characters.",
      "California Proposition 65 warning: name the website www.P65Warnings.ca.gov, as the warning you were given does.",
      "Warnings and safety information: write the warnings, or check “This product has no warnings”, not both.",
    ],
  );

  part("Read back from storage");
  is("nothing stored is no record", [readPhysicalLegal(undefined), readPhysicalLegal(null), readPhysicalLegal("x")], [null, null, null]);
  const odd = readPhysicalLegal({ safety: { manufacturer: { name: "\u0007" } }, prop65: "lead", quantities: [{ price: "", amount: "-1", unit: "kg" }, "x"] });
  is("a malformed stored record reads as nothing filled, so every gap stays open", [odd?.safety?.manufacturer.name, odd?.prop65, odd?.quantities, safetyGaps(odd?.safety ?? null, true).length], ["", "", [], 6]);

  part("Saved on the product record, only on a shipped product");
  await claimHandle(OWNER, "harborbooks", "Harbor Books", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestSz2Books01", true);
  await setSubscription(OWNER, { customerId: "cus_Sz2Owner01", subscriptionId: "sub_Sz2Owner01", active: true, period: paidPeriod() });
  const book = await addProduct(OWNER, "The Supper Book", "Printed, 120 pages.", "35", null);
  const pdf = await addProduct(OWNER, "Supper PDF", "", "12", null);
  if (!book.ok || !pdf.ok) throw new Error("no product");
  const legal = good.ok ? good.legal : null;
  if (!legal) throw new Error("no legal record");
  const notShipped = await setProductLegal(OWNER, pdf.product.id, legal);
  is("refused on a product that is not shipped", notShipped.ok ? "saved" : notShipped.reason, "ship_first");
  const shipping = parseShipping({ cents: 600, region: "world", note: "" })!;
  await setProductShipping(OWNER, book.product.id, shipping);
  await addOption(OWNER, book.product.id, "Signed", "45");
  const optionId = (await readProduct((await storeForEmail(OWNER))!, book.product.id))?.options[0]?.id ?? "";
  is("the option is there", optionId !== "", true);
  const unknownPrice = await setProductLegal(OWNER, book.product.id, { ...legal, quantities: [{ price: "opt_gone", amount: "1", unit: "kg" }] });
  is("a quantity for a price the product does not have is refused", unknownPrice.ok ? "saved" : unknownPrice.reason, "quantity_price");
  const withOption = { ...legal, quantities: [...legal.quantities, { price: optionId, amount: "1.5", unit: "kg" as const }] };
  const saved = await setProductLegal(OWNER, book.product.id, withOption);
  is("saved on the shipped product", saved.ok ? saved.product.legal : saved.reason, withOption);
  const store = (await storeForEmail(OWNER))!;
  const read = await readProduct(store, book.product.id);
  is("read back from the product record", read?.legal, withOption);
  is("kept when shipping changes", (await setProductShipping(OWNER, book.product.id, { ...shipping, note: "Ships tomorrow" })).ok ? (await readProduct((await storeForEmail(OWNER))!, book.product.id))?.legal : "refused", withOption);
  is("left out of the listing (cards and the store head stay the same size)", read ? Object.hasOwn(listingOf(read), "legal") : "none", false);
  is("parseProduct keeps it, and a product without it has none", [parseProduct({ id: "p1", title: "T", priceCents: 100, legal: withOption })?.legal, Object.hasOwn(parseProduct({ id: "p1", title: "T", priceCents: 100 }) ?? {}, "legal")], [withOption, false]);
  const cleared = await setProductLegal(OWNER, book.product.id, null);
  is("cleared with null", cleared.ok ? cleared.product.legal ?? null : cleared.reason, null);

  part("The route: valid saved, invalid refused with its fields, unknown not a save");
  const session = await openSession(OWNER);
  const post = async (body: unknown) => {
    const response = await legalRoute(new NextRequest("https://marktmorgen.com/api/store/physical-legal", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const sent = { safety: SAFETY, prop65: PROP65, quantities: [{ price: "", amount: "1.2", unit: "kg" }] };
  const ok = await post({ id: book.product.id, legal: sent });
  is("a valid record is saved", [ok.status, ok.body.ok], [200, true]);
  is("the answer confirms exactly what was sent", confirmsLegal(ok.body, true, book.product.id, legal), true);
  is("an answer for another product, without the record, or not ok is not a save", [confirmsLegal(ok.body, true, pdf.product.id, legal), confirmsLegal({ ok: true }, true, book.product.id, legal), confirmsLegal(ok.body, false, book.product.id, legal), confirmsLegal(null, true, book.product.id, legal), confirmsLegal(ok.body, true, book.product.id, { ...legal, prop65: "" })], [false, false, false, false, false]);
  const refused = await post({ id: book.product.id, legal: { ...sent, prop65: "WARNING: lead." } });
  is("an invalid record is refused with the fields", [refused.status, refused.body.error, refused.body.problems], [400, "invalid", [{ field: "prop65", problem: "site" }]]);
  is("still the saved record after a refusal", (await readProduct((await storeForEmail(OWNER))!, book.product.id))?.legal?.prop65, PROP65);
  is("without the legal field nothing is changed", [(await post({ id: book.product.id })).status, (await post({ id: book.product.id })).body.error], [400, "legal_shape"]);
  is("an unknown product", (await post({ id: "nope", legal: sent })).status, 404);
  is("on a product that is not shipped", (await post({ id: pdf.product.id, legal: sent })).body.error, "ship_first");
  is("the studio action has its agent row", Object.hasOwn(AGENT_COVERAGE, "POST store/physical-legal"), true);

  part("The studio block");
  is("the summary of what is missing", [gapSummary([]), gapSummary(["manufacturer-name", "picture", "warnings"])], ["", "Not shipped to the EU/EEA until these are filled: the manufacturer's name, a picture of the product and the warnings, or a check that it has none."]);
  const form = readFileSync("components/physical-legal-editor.tsx", "utf8");
  for (const words of ["Product safety and manufacturer", "Net quantity", "California Proposition 65 warning (optional)", "LEGAL_LABELS", "EU responsible person", "aria-invalid", "aria-describedby", "role=\"alert\"", "min-h-11", "/api/store/physical-legal", "confirmsLegal", "checkLegalWrite", "gapSummary"]) {
    is(`the form has: ${words}`, form.includes(words), true);
  }
  is("its labels, shared with the errors", [LEGAL_LABELS["manufacturer.name"], LEGAL_LABELS.noWarnings, LEGAL_LABELS.productType], ["Manufacturer name", "This product has no warnings", "Product type or model"]);
  is("the form never writes a warning for the creator", /WARNING:/.test(form), false);
  is("it never says the product complies", /\b(compliant|complies|compliance)\b/i.test(form), false);
  const editor = readFileSync("components/product-editor.tsx", "utf8");
  is("shown on a shipped product, after the shipping block", /<ShippingEditor product=\{product\} \/>\s*\{product\.shipping \? <PhysicalLegalEditor product=\{product\} \/> : null\}/.test(editor), true);

  part("Shown to buyers and used by checkout since unit 3 (tests/sz2-u3-display.test.ts)");
  for (const file of ["app/[handle]/p/[product]/page.tsx", "lib/store-checkout.ts", "lib/cart-shipping.ts"]) {
    is(`${file} reads it`, /physical-legal/.test(readFileSync(file, "utf8")), true);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
