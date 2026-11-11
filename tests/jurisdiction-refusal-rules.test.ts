/**
 * The rule behind "refuse-consumers" (AV1 step 5), before any charge.
 *
 * A deemed-supplier record may say that a jurisdiction's consumers cannot
 * buy (lib/deemed-supplier.ts). That is only true if the checkout refuses
 * them before it asks Stripe for anything. lib/jurisdiction-refusal-rules.ts
 * is the pure decision such a checkout will call: from the buyer's location
 * evidence and the records, sell or refuse, and the plain sentence the buyer
 * reads. It fails closed:
 *
 *   - no complete, valid record set: nobody can buy (today: none is recorded);
 *   - fewer than two location pieces, or a piece that is not a country code:
 *     refused as unknown, never guessed;
 *   - any piece that points to a refusing jurisdiction refuses, even when
 *     another piece points elsewhere;
 *   - a territory whose VAT or sales-tax status was not verified against an
 *     official text counts for every jurisdiction it may belong to, and is
 *     refused if any of them refuses.
 *
 * Synthetic records only; the real DEEMED_SUPPLIER_RECORDS stays empty.
 */
import { DEEMED_SUPPLIER_RECORDS, deemedSupplierReady, type DeemedSupplierRecord } from "@/lib/deemed-supplier";
import {
  ASSIGNED_COUNTRY_CODES,
  EU_MEMBER_STATES,
  MIN_LOCATION_EVIDENCE,
  UNVERIFIED_TERRITORIES,
  candidateJurisdictions,
  checkoutLocationDecision,
} from "@/lib/jurisdiction-refusal-rules";
import { done, is, part } from "./check";

const record = (jurisdiction: DeemedSupplierRecord["jurisdiction"], treatment: DeemedSupplierRecord["treatment"]): DeemedSupplierRecord => ({
  jurisdiction,
  treatment,
  implementedIn: "lib/jurisdiction-refusal-rules.ts (synthetic)",
  recordedOn: "2026-11-11",
  registration: treatment === "collect" ? "synthetic registration, never real" : "",
  evidence: "tests/jurisdiction-refusal-rules.test.ts (synthetic)",
});
/** EU and UK consumers refused; US and other collected. Invented for the test. */
const SYNTHETIC: DeemedSupplierRecord[] = [record("EU", "refuse-consumers"), record("UK", "refuse-consumers"), record("US", "collect"), record("other", "collect")];
const decide = (countries: readonly (string | null | undefined)[], records: unknown = SYNTHETIC) => checkoutLocationDecision(countries, records);

part("Today nothing is recorded, so nobody can buy");
is("the real records are still empty", DEEMED_SUPPLIER_RECORDS.length, 0);
is("and the gate still says not ready", deemedSupplierReady(), false);
for (const where of [["US", "US"], ["DE", "DE"], ["BR", "BR"]]) {
  const today = checkoutLocationDecision(where);
  is(`${where.join("+")} is refused as not recorded`, [today.allowed, today.allowed ? null : today.reason], [false, "not-recorded"]);
}

part("A broken record set refuses everyone");
is("a jurisdiction recorded twice", decide(["US", "US"], [...SYNTHETIC, record("US", "collect")]).allowed, false);
is("a jurisdiction missing", decide(["US", "US"], SYNTHETIC.slice(0, 3)).allowed, false);
is("not a list", decide(["US", "US"], { US: "collect" }).allowed, false);

part("Location evidence: two pieces, each a country code");
is("two pieces are required", MIN_LOCATION_EVIDENCE, 2);
const one = decide(["US"]);
is("one piece is not enough", [one.allowed, one.allowed ? null : one.reason], [false, "location-unknown"]);
const none = decide([]);
is("no piece at all", [none.allowed, none.allowed ? null : none.reason], [false, "location-unknown"]);
for (const bad of [null, undefined, "", "us", "USA", "1A", "XX", "ZZ", "T1", "AA", "QM"]) {
  const got = decide(["US", bad]);
  is(`${JSON.stringify(bad)} is unknown, never guessed`, [got.allowed, got.allowed ? null : got.reason], [false, "location-unknown"]);
}
is("more than two pieces are all read", decide(["US", "US", "FR"]).allowed, false);

part("Only assigned ISO 3166-1 codes are countries; every other two letters are unknown (Claude 3 on #3681, MEDIUM)");
// Never assigned (JJ, OO, WW, ZX), Greece's VAT prefix (EL, never a country code: Greece is GR), and codes ISO only keeps
// transitionally reserved for countries that no longer exist (AN, CS, YU, TP): none of them says where a buyer is.
for (const bad of ["JJ", "OO", "WW", "ZX", "EL", "AN", "CS", "YU", "TP"]) {
  const beside = decide(["US", bad]);
  const twice = decide([bad, bad]);
  is(`${bad}: not a country, so unknown, beside a real one and on its own`, [candidateJurisdictions(bad), beside.allowed ? null : beside.reason, twice.allowed ? null : twice.reason], [null, "location-unknown", "location-unknown"]);
}
is("every one of the 249 assigned codes, and XK as providers send Kosovo, is a country", ASSIGNED_COUNTRY_CODES.length === 249 && [...ASSIGNED_COUNTRY_CODES, "XK"].every((code) => candidateJurisdictions(code) !== null), true);
is("Curaçao, Sint Maarten and the Caribbean Netherlands (once AN) still count for the EU too", [candidateJurisdictions("CW"), candidateJurisdictions("SX"), candidateJurisdictions("BQ")], [["EU", "other"], ["EU", "other"], ["EU", "other"]]);

part("Records the gate itself refuses are refused here too, before any copy (Claude 3 on #3681, LEVE)");
const extraKey = SYNTHETIC.map((row, i) => (i === 2 ? { ...row, sneaky: 1 } : row));
is("a record with a field the gate does not know: the gate says not ready, and nobody can buy", [deemedSupplierReady(extraKey), decide(["US", "US"], extraKey).allowed], [false, false]);

part("Every piece counts");
is("US and US: collected there, so sold", decide(["US", "US"]), { allowed: true, jurisdictions: ["US"] });
const mixed = decide(["US", "DE"]);
is("one piece in the EU refuses, though the other is in the US", [mixed.allowed, mixed.allowed ? null : mixed.reason, mixed.jurisdictions], [false, "refused-jurisdiction", ["US", "EU"]]);
is("Brazil and Brazil: other, collected, sold", decide(["BR", "BR"]).allowed, true);
is("Germany twice: refused", decide(["DE", "DE"]).allowed, false);
is("the United Kingdom: refused", decide(["GB", "GB"]).allowed, false);

part("Where each country belongs");
is("the 27 member states", EU_MEMBER_STATES.length, 27);
is("each is in the EU, and only there", EU_MEMBER_STATES.filter((c) => JSON.stringify(candidateJurisdictions(c)) !== JSON.stringify(["EU"])), []);
is("Greece is GR, its ISO code (EL is only VAT's own prefix)", EU_MEMBER_STATES.includes("GR"), true);
is("the code EU itself", candidateJurisdictions("EU"), ["EU"]);
is("GB and the reserved UK", [candidateJurisdictions("GB"), candidateJurisdictions("UK")], [["UK"], ["UK"]]);
is("the United States", candidateJurisdictions("US"), ["US"]);
is("Brazil, Canada, Norway, Switzerland", ["BR", "CA", "NO", "CH"].map(candidateJurisdictions), [["other"], ["other"], ["other"], ["other"]]);
is("an unknown shape belongs nowhere", candidateJurisdictions("usa"), null);

part("Unverified territories count for every jurisdiction they may belong to");
is("Monaco may be the EU", candidateJurisdictions("MC"), ["EU", "other"]);
is("the Isle of Man may be the UK", candidateJurisdictions("IM"), ["UK", "other"]);
is("Puerto Rico may be the US", candidateJurisdictions("PR"), ["US", "other"]);
is("Åland and Réunion may be the EU", [candidateJurisdictions("AX"), candidateJurisdictions("RE")], [["EU", "other"], ["EU", "other"]]);
is("Monaco twice is refused while the EU refuses", decide(["MC", "MC"]).allowed, false);
is("the Isle of Man twice is refused while the UK refuses", decide(["IM", "IM"]).allowed, false);
is("Puerto Rico twice is sold while the US and other both collect", decide(["PR", "PR"]).allowed, true);
const prRefused = decide(["PR", "PR"], [record("EU", "collect"), record("UK", "collect"), record("US", "collect"), record("other", "refuse-consumers")]);
is("and refused once other refuses", [prRefused.allowed, prRefused.jurisdictions], [false, ["US", "other"]]);
is("no unverified territory is also an EU member", UNVERIFIED_TERRITORIES.filter((t) => (EU_MEMBER_STATES as readonly string[]).includes(t)), []);

part("What the buyer reads");
const refused = decide(["DE", "DE"]);
const unknown = decide(["US"]);
const notRecorded = checkoutLocationDecision(["US", "US"]);
for (const [name, got] of [["refused", refused], ["unknown", unknown], ["not recorded", notRecorded]] as const) {
  const words = got.allowed ? "" : got.buyerMessage;
  is(`${name}: says nothing was charged`, /Nothing was charged\./.test(words), true);
  is(`${name}: no tax jargon, no blame`, /\b(VAT|OSS|nexus|facilitator|deemed|jurisdiction|illegal|fraud)\b/i.test(words), false);
  is(`${name}: short`, words.length > 0 && words.length <= 160, true);
}
is("an unknown location asks for the country, it does not accuse", /couldn't confirm your country/.test(unknown.allowed ? "" : unknown.buyerMessage), true);

part("The decision is data, never a live object");
const tricky = [{ jurisdiction: "EU", get treatment() { return "collect"; }, implementedIn: "x", recordedOn: "2026-11-11", registration: "x", evidence: "x" }, ...SYNTHETIC.slice(1)];
is("a record with a getter is refused", decide(["DE", "DE"], tricky).allowed, false);

done();
