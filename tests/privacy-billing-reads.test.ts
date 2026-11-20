/**
 * The privacy policy's billing-address paragraph (#billing-address) says what the code reads from that address, and
 * no less (VR item 2; independent review of #4938, MEDIUM). Besides the country, lib/tax-summary.ts (regionOf) reads
 * the state or province of a US or Canadian buyer for the creator's tax summary, and the billing country is used in the
 * card of a store's latest purchases (lib/recent-sales.ts, kept up to 8 days, #recent-purchases) and in the creator's
 * sales figures and export by country (lib/stats.ts). The paragraph said "We read only the country in it", for tax and
 * for the offer after paying only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { done, is, part } from "./check";

const ROOT = process.cwd();
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

part("What the code reads from the billing address");
is("the tax summary reads the state or province (regionOf)", /address\?\.state/.test(read("lib/tax-summary.ts")), true);
is("the latest-purchases card keeps the billing country", /customer_details\?\.address\?\.country/.test(read("lib/recent-sales.ts")), true);
is("the creator's sales figures read the billing country", /details\.address\?\.country/.test(read("lib/stats.ts")), true);

part("The policy's #billing-address paragraph says so");
const privacy = read("app/privacy/page.tsx").replace(/\s+/g, " ");
const start = privacy.indexOf('<p id="billing-address">');
const paragraph = start < 0 ? "" : privacy.slice(start, privacy.indexOf("</p>", start));
is("the paragraph is there", paragraph.length > 0, true);
is("it no longer says only the country is read", paragraph.includes("We read only the country"), false);
is("it names the state or province of a US or Canadian buyer", paragraph.includes("state or province"), true);
is("it names the creator's tax summary", paragraph.includes("tax summary"), true);
is("it names the creator's sales figures by country", paragraph.includes("sales figures"), true);
is("it points to the latest-purchases card, where the country is kept", paragraph.includes('href="#recent-purchases"'), true);
is("it still says the address is never used for marketing", paragraph.includes("never used for marketing"), true);

done();
