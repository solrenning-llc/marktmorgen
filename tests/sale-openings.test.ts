/**
 * Every place that opens a new charge to a buyer on a creator's account is
 * listed in lib/sale-openings.ts, so the "refuse-consumers" refusal (AV1
 * step 5, lib/jurisdiction-refusal-rules.ts) can never be wired into some of
 * them and missed in another.
 *
 *   - the real sources are scanned: every onAccount POST to /checkout/sessions
 *     or /payment_intents is in the list, and every listed file still makes one;
 *   - no file opens one past onAccount, with its own fetch to Stripe;
 *   - a "refuse-consumers" record that does not name every sale opening, or
 *     whose openings do not call checkoutLocationDecision, is caught. The real
 *     DEEMED_SUPPLIER_RECORDS is empty today, so the check is checked here
 *     on synthetic records, and on the real records as they stand.
 *
 * Reads files only. Nothing is recorded and no flag moves.
 */
import fs from "node:fs";
import path from "node:path";
import { DEEMED_SUPPLIER_RECORDS, type DeemedSupplierRecord } from "@/lib/deemed-supplier";
import { COVERED_OPENINGS, NOT_A_SALE, SALE_OPENINGS, openingCalls, openingsWithoutRefusal } from "@/lib/sale-openings";
import { done, is, part } from "./check";

const ROOT = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") sourceFiles(rel, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const files = [...sourceFiles("lib"), ...sourceFiles("app")];
const listed = new Set([...SALE_OPENINGS, ...NOT_A_SALE, ...COVERED_OPENINGS].map((entry) => entry.file));

part("The scanner itself, on synthetic sources");
{
  is("a one-line call is found", openingCalls(`await onAccount("POST", account, "/checkout/sessions", body);`).length, 1);
  is("a call over several lines is found", openingCalls(`await onAccount(\n  "POST",\n  store.stripeAccountId as string,\n  "/payment_intents",\n  body,\n);`).length, 1);
  is("a template literal path is found", openingCalls(`onAccount("POST", a, \`/checkout/sessions\`, body)`).length, 1);
  is("expiring a session opens nothing", openingCalls(`onAccount("POST", a, "/checkout/sessions/" + id + "/expire", body)`).length, 0);
  is("a read opens nothing", openingCalls(`onAccount("GET", a, "/checkout/sessions", undefined)`).length, 0);
  is("capturing opens nothing new", openingCalls(`onAccount("POST", a, "/payment_intents/" + id + "/capture")`).length, 0);
  // PayPal opens an order on the creator's PayPal account (Claude 4 and Claude 3 on #3682, MEDIUM).
  is("a PayPal order is found", openingCalls(`const made = await call("POST", "/v2/checkout/orders", {`), ["/v2/checkout/orders"]);
  is("capturing a PayPal order opens nothing new", openingCalls(`await call("POST", \`/v2/checkout/orders/\${encodeURIComponent(order)}/capture\`, {})`).length, 0);
  // A provider chosen at run time, with onAccount as the default (LEVE on #3682).
  is("onAccount as a default provider is found", openingCalls(`await (runtime.provider ?? onAccount)("POST", claim.row.accountId, "/checkout/sessions", body)`), ["/checkout/sessions"]);
}

part("Every real opening is listed, and every listed file still opens one");
{
  const found = new Map<string, string[]>();
  for (const file of files) {
    if (file === "lib/stripe-account.ts") continue;
    const calls = openingCalls(read(file));
    if (calls.length) found.set(file, calls);
  }
  const unlisted = [...found.keys()].filter((file) => !listed.has(file));
  is("no file opens a checkout or a payment on a creator's account without being in lib/sale-openings.ts", unlisted, []);
  const stale = [...listed].filter((file) => !found.has(file));
  is("every file in lib/sale-openings.ts still opens one", stale, []);
  for (const entry of [...SALE_OPENINGS, ...NOT_A_SALE, ...COVERED_OPENINGS]) {
    is(`${entry.file} opens ${entry.opens}`, found.get(entry.file)?.includes(entry.opens) ?? false, true);
  }
  is("no file is listed twice", new Set(SALE_OPENINGS.map((entry) => entry.file)).size, SALE_OPENINGS.length);
  is("a file is a sale or not, never both", SALE_OPENINGS.some((entry) => NOT_A_SALE.some((other) => other.file === entry.file)), false);
  is("PayPal's order is a sale opening", SALE_OPENINGS.some((entry) => entry.file === "lib/paypal-sales.ts" && entry.opens === "/v2/checkout/orders"), true);
  is("an opening covered by another is covered by a listed sale opening, and is not one itself", COVERED_OPENINGS.every((entry) => SALE_OPENINGS.some((sale) => sale.file === entry.by) && !SALE_OPENINGS.some((sale) => sale.file === entry.file)), true);
  is("the confirmation outbox's session is reached only from createCheckout", COVERED_OPENINGS.map((entry) => [entry.file, entry.by]), [["lib/order-confirmation-outbox.ts", "lib/store-checkout.ts"]]);
}

part("Nothing opens a checkout or a payment past onAccount");
{
  const direct = files.filter(
    (file) => file !== "lib/stripe-account.ts" && /v1\/(checkout\/sessions|payment_intents)["'`?]/.test(read(file)),
  );
  is("only lib/stripe-account.ts speaks to Stripe's checkout and payment endpoints", direct, []);
}

part("A refuse-consumers record must cover every sale opening");
{
  const record = (over: Partial<DeemedSupplierRecord>): DeemedSupplierRecord => ({
    jurisdiction: "EU",
    treatment: "refuse-consumers",
    implementedIn: SALE_OPENINGS.map((entry) => entry.file).join(", "),
    recordedOn: "2026-11-11",
    registration: "",
    evidence: "tests/synthetic.test.ts",
    ...over,
  });
  const wired = (file: string) => `import { checkoutLocationDecision } from "@/lib/jurisdiction-refusal-rules";\nconst decided = checkoutLocationDecision(pieces); // ${file}`;
  // Only a call counts, never the name alone (Claude 3 on #3682, LEVE).
  const named = (file: string) => `import { checkoutLocationDecision } from "@/lib/jurisdiction-refusal-rules";\n// ${file} calls checkoutLocationDecision(pieces) one day\n/* checkoutLocationDecision(x) */`;
  const bare = () => "// nothing here";

  is("every opening named and calling the decision passes", openingsWithoutRefusal([record({})], wired), []);
  is("openings that never call checkoutLocationDecision are each named", openingsWithoutRefusal([record({})], bare).length, SALE_OPENINGS.length);
  is("an import or a comment is not a call: each opening is still a gap", openingsWithoutRefusal([record({})], named).length, SALE_OPENINGS.length);
  const short = record({ implementedIn: SALE_OPENINGS.slice(1).map((entry) => entry.file).join(", ") });
  is("an opening left out of the record is named", openingsWithoutRefusal([short], wired), [`EU: ${SALE_OPENINGS[0].file} is not named in implementedIn`]);
  is("a collect record is not a refusal, so this check leaves it to its own", openingsWithoutRefusal([record({ treatment: "collect" })], bare), []);
  is("no record, nothing to cover", openingsWithoutRefusal([], bare), []);
  const near = record({ implementedIn: SALE_OPENINGS.map((entry) => `${entry.file}x`).join(", ") });
  is("a near name does not count as naming the file", openingsWithoutRefusal([near], wired).length, SALE_OPENINGS.length);
}

part("The real records, as they stand");
{
  is("no recorded refusal leaves a sale opening unguarded", openingsWithoutRefusal(DEEMED_SUPPLIER_RECORDS, read), []);
  is("nothing is recorded by this change", DEEMED_SUPPLIER_RECORDS.length, 0);
}

done();
