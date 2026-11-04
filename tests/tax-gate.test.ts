/**
 * The tax gate and the deemed-supplier gate (18 October 2026).
 *
 * Since 18 October 2026 the owner uses no accountant: a tax doubt is closed
 * by an official text or by a consultation answer recorded with its date and
 * source (docs/tax-consultations.md, lib/tax-gate.ts CONSULTATION_ANSWERS),
 * or it stays at the reading with more tax (rule 19). And EU VAT's art. 9a
 * (Implementing Regulation 282/2011) makes Marktmorgen the supplier of what a
 * store sells electronically to an EU consumer (docs/eu-vat-article-9a.md).
 * What is checked:
 *
 *   - no flag an accountant's word could turn exists anywhere, and no page,
 *     comment or rule says an accountant confirms anything;
 *   - the gate reading is the one with every tax stacked while EU hosting is
 *     not live, and the after-design reading is refused until it is;
 *   - a recorded consultation answer carries its question, authority, date,
 *     source and reading;
 *   - all six current prices retain positive modeled net at full registered use
 *     and unchanged room, without waiving a missing review or another gate;
 *   - art. 9a is one more reason nothing is on sale: no plan can start and no
 *     store's checkout can open while the EU, UK, US and other records are
 *     missing, and the reasons name art. 9a;
 *   - the tax documents say what the code does and count what they list.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as Gate from "@/lib/tax-gate";
import {
  CONSULTATION_ANSWERS, EU_HOSTING_CONFIRMED, GATE_READING_ID, TAX_QUESTIONS,
  consultationProblems, gateProblems, gateReading, taxGateValid, type ConsultationAnswer,
} from "@/lib/tax-gate";
import {
  DEEMED_SUPPLIER_JURISDICTIONS, DEEMED_SUPPLIER_RECORDS, deemedSupplierProblems, deemedSupplierReady, type DeemedSupplierRecord,
} from "@/lib/deemed-supplier";
import {MOST_CORRECT_READING} from "@/lib/receiving-costs";
import {EU_HOSTING_READING,MOST_TAX_READING} from "./historical-receiving-model";
import {reviewedUnitUnder} from "@/lib/reviewed-receiving";
import {reviewedReceivingTaxInput} from "./reviewed-receiving-fixture";
import {syntheticTaxContext} from "./customer-tax-review-fixture";
import { ASSISTANT_ON_SALE, PLANS_ON_SALE } from "@/lib/opening";
import { canSell } from "@/lib/store-checkout";
import type { Store } from "@/lib/store";
import { planUnits, roomKept } from "./margin-alignment-table";
import { CURRENT_COMMERCIAL_MARGIN_REVIEW, commercialPlansMayOpen } from "@/lib/commercial-margin";
import { done, is, part } from "./check";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(root, dir))) {
    const path = `${dir}/${name}`;
    if (statSync(join(root, path)).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|md|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

part("No accountant (owner, 18 October 2026)");
const OLD_FLAG = ["ACCOUNTANT", "CONFIRMATION"].join("_");
is("the gate module has no accountant flag", OLD_FLAG in Gate, false);
const sources = [...walk("lib"), ...walk("app"), ...walk("scripts").filter((f) => !f.endsWith(".py")), ...walk("tests").filter((f) => !f.endsWith("tax-gate.test.ts"))];
is("no source file declares the old flag", sources.filter((f) => read(f).includes(OLD_FLAG)), []);
// "accountant" may be written only to say there is none.
const allowed = /\b(no|not to use an|uses no|without an?)\s+accountant\b/i;
const pages = ["AGENTS.md", "CLAUDE.md", ...walk("docs"), ...walk("lib"), ...walk("app")];
const said = pages.flatMap((file) =>
  read(file)
    .split("\n")
    .map((line, i) => ({ file, line: i + 1, text: line }))
    .filter(({ text }) => /accountant/i.test(text) && text.replace(new RegExp(allowed.source, "gi"), "").match(/accountant/i)),
);
is("no rule, page or comment leaves a doubt for an accountant to close", said.map(({ file, line }) => `${file}:${line}`), []);

part("The gate reading");
is("TX selects correct metadata without certifying a review or requiring EU hosting",[EU_HOSTING_CONFIRMED,GATE_READING_ID,gateReading()===MOST_CORRECT_READING],[false,"most-correct",true]);
is("and the flag stays false in this change", read("lib/tax-gate.ts").includes("export const EU_HOSTING_CONFIRMED = false;"), true);
is("the gate setting in force is accepted", gateProblems(GATE_READING_ID, EU_HOSTING_CONFIRMED), []);
is("a historical after-design selection cannot replace the current TX policy",gateProblems("most-tax-after-design" as never,false).length>0,true);
is("EU confirmation cannot authorize that retired selection",gateProblems("most-tax-after-design" as never,true).length>0,true);
is("an unknown reading is refused", gateProblems("lenient" as never, true).length > 0, true);
is("the after-design reading is the receiving model's EU hosting one", [EU_HOSTING_READING.profitTaxBps, EU_HOSTING_READING.revenueTaxBps, EU_HOSTING_READING.salesTaxInsideBps], [2_868, 500, 0]);
is("the most-tax reading stacks every tax", [MOST_TAX_READING.profitTaxBps, MOST_TAX_READING.revenueTaxBps, MOST_TAX_READING.salesTaxInsideBps], [7_818, 500, 2_700]);

part("A consultation answer is recorded whole");
is("every recorded answer is complete", consultationProblems(), []);
is("none is recorded yet", CONSULTATION_ANSWERS.length, 0);
const good: ConsultationAnswer = { question: 10, authority: "Prefeitura de Fortaleza", date: "2027-02-01", source: "SEFIN, processo nº 0000/2027", reading: "ISS not due" };
is("a complete answer passes", consultationProblems([good]), []);
is("an answer without its source, with an unknown authority, a bad date or no such question does not", consultationProblems([
  { ...good, source: " " },
  { ...good, authority: "an accountant" as never },
  { ...good, date: "1 Feb 2027" },
  { ...good, question: TAX_QUESTIONS + 1 },
]).length, 4);
is("so the gate's setting is valid today", taxGateValid(), true);

part("TX: historical consultation records cannot decide the gate");
const historicalAnswers = CONSULTATION_ANSWERS as ConsultationAnswer[];
const beforeHistoricalRecord = taxGateValid();
try {
  historicalAnswers.push({ ...good, date: "not-a-date", source: "" });
  is("a malformed historical record is still recognized as malformed",
    consultationProblems().length > 0, true);
  is("but a historical record cannot change the current gate setting",
    taxGateValid(), beforeHistoricalRecord);
  is("and cannot supply missing commercial or jurisdiction approval",
    [CURRENT_COMMERCIAL_MARGIN_REVIEW, commercialPlansMayOpen(true), deemedSupplierReady(), PLANS_ON_SALE],
    [null, false, false, false]);
} finally {
  historicalAnswers.pop();
}
is("the real consultation record remains empty", CONSULTATION_ANSWERS.length, 0);
for (const historicalFlag of [false, true]) {
  is("the same permitted reading does not depend on a hosting flag",
    gateProblems(GATE_READING_ID, historicalFlag), []);
  is("an unknown reading is refused for either hosting value",
    gateProblems("unknown" as never, historicalFlag).length > 0, true);
}


part("MR/TX: complete synthetic full-use evidence never waives the unchanged gates");
const gated=planUnits(false).map(unit=>{
 const usage=unit.usageCents+roomKept(unit),scope=syntheticTaxContext(unit.id.replaceAll('-','_'),unit.id.includes('-year-')?12:1);
 return {id:unit.id,result:reviewedUnitUnder(unit.priceCents,usage,reviewedReceivingTaxInput(unit.priceCents,usage,scope),true)};
});
is("all six current price-cycle cases are tested at full registered use and unchanged room", gated.length, 6);
for (const row of gated) {
  is("a nonpositive registered net fails " + row.id, row.result!==null && row.result.netCents > 0 && row.result.meetsFloor, true);
}
is("positive model results never supply the absent actual review", CURRENT_COMMERCIAL_MARGIN_REVIEW, null);
is("a launch request cannot replace the missing review", commercialPlansMayOpen(true), false);
is("the recorded release flags remain closed", [PLANS_ON_SALE, ASSISTANT_ON_SALE], [false, false]);
is("the explicit opening request is not changed", read("lib/opening.ts").includes("const OPENING_REQUESTED: boolean = false;"), true);

part("Art. 9a: one more reason nothing is on sale");
const problems = deemedSupplierProblems();
is("no treatment is recorded", DEEMED_SUPPLIER_RECORDS.length, 0);
is("so the deemed-supplier gate is shut", deemedSupplierReady(), false);
is("and its reasons name art. 9a for the EU, and the UK, US states and other countries", [
  problems.some((p) => p.startsWith("EU:") && p.includes("art. 9a") && p.includes("282/2011")),
  problems.some((p) => p.startsWith("UK:")),
  problems.some((p) => p.startsWith("US:")),
  problems.some((p) => p.startsWith("other:")),
], [true, true, true, true]);
if (!deemedSupplierReady()) is("while it is shut no plan can start, whatever the margin review says", PLANS_ON_SALE, false);
is("the release gate reads it", /PLANS_ON_SALE: boolean = [^;]*deemedSupplierReady\(\)/.test(read("lib/opening.ts")), true);
const shop = { stripeAccountId: "acct_fixture013", stripeChargesEnabled: true, subscriptionActive: false, suspended: false } as unknown as Store;
const savedKey = process.env.STRIPE_SECRET_KEY;
process.env.STRIPE_SECRET_KEY = "sk_test_notARealKeyOnlyForTheseChecks";
is("a store with Stripe connected and no plan cannot sell, so no EU consumer can buy from one", canSell(shop), false);
if (savedKey === undefined) delete process.env.STRIPE_SECRET_KEY;
else process.env.STRIPE_SECRET_KEY = savedKey;
const complete: DeemedSupplierRecord[] = DEEMED_SUPPLIER_JURISDICTIONS.map((jurisdiction) => ({
  jurisdiction, treatment: "refuse-consumers", implementedIn: "lib/example.ts", recordedOn: "2027-01-01", registration: "", evidence: "tests/example.test.ts",
}));
is("a complete set of records opens this gate (and only this one)", deemedSupplierReady(complete), true);
is("a tax collected without its registration does not", deemedSupplierProblems(complete.map((r) => (r.jurisdiction === "EU" ? { ...r, treatment: "collect" as const } : r))), ["EU: a tax collected needs its registration"]);
is("nor a jurisdiction recorded twice, or missing", [
  deemedSupplierReady([...complete, complete[0]]),
  deemedSupplierReady(complete.filter((r) => r.jurisdiction !== "UK")),
], [false, false]);


part("A tax treatment needs an actual calendar date");
for (const date of ["2026-02-29", "2026-02-31", "2026-04-31", "1900-02-29", "2026-13-01", "2026-00-01", "2026-01-00", "2026-1-01", "", "not-a-date", null, undefined]) {
  const records = complete.map(record => record.jurisdiction === "EU" ? { ...record, recordedOn: date as string } : record);
  is("impossible or malformed record date keeps the gate closed", deemedSupplierProblems(records), ["EU: recordedOn"]);
  is("an invalid calendar date never counts as ready", deemedSupplierReady(records), false);
}
for (const date of ["2024-02-29", "2000-02-29", "2026-02-28", "2026-04-30", "2026-12-31"]) {
  is("valid month ends and leap days retain existing acceptance", deemedSupplierProblems(complete.map(record => ({ ...record, recordedOn: date }))), []);
}
is("date validation creates no actual treatment or permission to sell", [DEEMED_SUPPLIER_RECORDS.length, deemedSupplierReady(), PLANS_ON_SALE, ASSISTANT_ON_SALE], [0, false, false, false]);


part("A consultation answer also needs an actual calendar date");
for (const date of ["2026-02-29", "2026-02-31", "2026-04-31", "1900-02-29", "2026-13-01", "2026-00-01", "2026-01-00", "2026-1-01", "", "not-a-date", null, undefined]) {
  is("an impossible consultation date cannot support a tax reading", consultationProblems([{ ...good, date: date as string }]), ["consultation answer 1: date"]);
}
for (const date of ["2024-02-29", "2000-02-29", "2026-02-28", "2026-04-30", "2026-12-31"]) {
  is("a valid consultation day still needs the existing authority and source", consultationProblems([{ ...good, date }]), []);
}
is("no real answer or opening is introduced by selecting TX metadata",[CONSULTATION_ANSWERS.length,GATE_READING_ID,EU_HOSTING_CONFIRMED,taxGateValid(),PLANS_ON_SALE],[0,"most-correct",false,true,false]);

part("The documents say what the code does");
const nine = read("docs/eu-vat-article-9a.md");
is("the art. 9a reading cites the official texts and their day", [
  nine.includes("https://eur-lex.europa.eu/eli/reg_impl/2011/282/2025-04-14/eng"),
  nine.includes("explanatory_notes_2015_en.pdf"),
  nine.includes("OSS_guidelines_en.pdf"),
  nine.includes("read 18 Oct 2026"),
], [true, true, true, true]);
is("and reads every checkout path", ["Digital products", "Courses", "Private podcasts", "Memberships", "Calls", "Tips", "Payment requests", "Physical goods", "own plans"].filter((path) => !nine.includes(path)), []);
is("and what follows: VAT on the full price, the non-Union OSS from the first sale, art. 63c records, two pieces of evidence", ["full sale price", "Non-Union OSS from the first sale", "art. 63c", "two items of non-contradictory evidence", "never from Marktmorgen's commission"].filter((words) => !nine.includes(words)), []);
const doubts = read("docs/tax-uncertainty.md");
const statuses = { "CLOSED-TEXT": 0, "CLOSED-DESIGN": 0, "CLOSABLE-CONSULTA": 0, OPEN: 0 } as Record<string, number>;
const listed = doubts.slice(doubts.indexOf("## The 27 questions"), doubts.indexOf("**Links.**"));
const numbered = listed.split("\n").filter((line) => /^\d+\. \*\*/.test(line));
for (const line of numbered) for (const status of Object.keys(statuses)) statuses[status] += (line.split("**")[2] ?? "").match(new RegExp(`\\b${status}\\b`, "g"))?.length ?? 0;
is("the questions are numbered 1 to the gate's last", numbered.map((line) => Number(line.split(".")[0])), Array.from({ length: TAX_QUESTIONS }, (_, i) => i + 1));
is("and the counts are what they list", doubts.includes(`CLOSED-TEXT ${statuses["CLOSED-TEXT"]}, CLOSED-DESIGN ${statuses["CLOSED-DESIGN"]}, CLOSABLE-CONSULTA ${statuses["CLOSABLE-CONSULTA"]}, OPEN ${statuses.OPEN}`), true);
console.log(`  statuses: ${JSON.stringify(statuses)}`);
const consultations = read("docs/tax-consultations.md");
is("the consultations point at the shared drafts and the code's list", ["tax-consultations-receita-drafts.md", "tax-consultations-fortaleza-draft.md", "CONSULTATION_ANSWERS", "IN RFB 2.058/2021"].filter((words) => !consultations.includes(words)), []);

done();
