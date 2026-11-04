/**
 * Moving from HubSpot, the spreadsheet rules (lib/hubspot-csv.ts), with
 * synthetic headers and rows only. What is checked:
 *
 *   - a contacts export and a deals export are known by their English labels;
 *     a file with labels in another language, or any other file, is not;
 *   - contacts map to the contacts import's columns, names joined, other
 *     columns listed as not brought in;
 *   - deals read with HubSpot's default stages and custom ones, won and lost
 *     by label, a missing won or lost stage added;
 *   - amounts read only in a stated currency that is the store's, never
 *     guessed; close dates only as year-month-day;
 *   - too many deals refuses the whole file; a bad name refuses its row;
 *     stages and pipelines past what a store holds refuse their deals;
 *   - the notes sentence says notes do not come in.
 */
import { parseCsv } from "@/lib/csv";
import { COLUMNS } from "@/lib/imports";
import { MAX_DEAL_TITLE, MAX_DEALS, MAX_STAGES } from "@/lib/crm-rules";
import {
  HUBSPOT_CONTACT_FIELDS,
  HUBSPOT_DEFAULT_STAGES,
  HUBSPOT_ENGLISH_ONLY,
  HUBSPOT_NOTES_NOT_IMPORTED,
  hubSpotContactColumns,
  hubSpotContactRow,
  hubSpotFileOf,
  isHubSpotExport,
  planHubSpotDeals,
  readHubSpotAmount,
  readHubSpotDate,
  stageKindOf,
  type HubSpotDealsPlan,
} from "@/lib/hubspot-csv";
import { done, is, part } from "./check";

const CONTACTS = "Record ID,Create date,Email,First name,Last name,Phone number,Lifecycle stage\r\n101,2026-01-02,ada@example.com,Ada,Lovelace,+1 555 0100,Customer\r\n102,2026-01-03,grace@example.com,Grace,,,Lead\r\n";
const DEALS_HEADER = ["Record ID", "Deal name", "Deal stage", "Pipeline", "Amount", "Close date", "Deal owner", "Associated Contact"];
const row = (id: string, title: string, stage: string, pipeline = "Sales Pipeline", amount = "", close = "", contact = "") => [id, title, stage, pipeline, amount, close, "", contact];
const plan = (rows: string[][], options: Partial<Parameters<typeof planHubSpotDeals>[1]> = {}, header = DEALS_HEADER): HubSpotDealsPlan =>
  planHubSpotDeals({ header, rows }, { currency: "usd", statedCurrency: "usd", pipelineRoom: 2, ...options });
const ok = (p: HubSpotDealsPlan) => {
  if (!p.ok) throw new Error(p.sentence);
  return p;
};

part("Recognition by English labels");
is("a contacts export is HubSpot's contacts", hubSpotFileOf(parseCsv(CONTACTS).header), "contacts");
is("a deals export is HubSpot's deals", hubSpotFileOf(DEALS_HEADER), "deals");
is("labels match ignoring case and spacing", hubSpotFileOf(["RECORD ID", "deal  name", "Deal Stage"]), "deals");
is("a view export with Record ID anywhere is still known", hubSpotFileOf(["Email", "Last Name", "Record ID"]), "contacts");
is("without Record ID it is a plain spreadsheet", isHubSpotExport(["Email", "First name", "Last name"]), false);
is("Record ID alone is not enough", isHubSpotExport(["Record ID", "Company name"]), false);
is("a German export is not guessed", isHubSpotExport(["Datensatz-ID", "E-Mail", "Vorname", "Nachname"]), false);
is("a Portuguese deals export is not guessed", isHubSpotExport(["ID do registro", "Nome do negócio", "Etapa do negócio", "Pipeline"]), false);
is("a ClickFunnels contacts file is not HubSpot's", isHubSpotExport(["Email Address", "First Name", "Last Name", "Tags", "Status"]), false);
is("the screen says only English labels are known, and what to do", /English/.test(HUBSPOT_ENGLISH_ONLY) && /Language of column headers/.test(HUBSPOT_ENGLISH_ONLY), true);

part("Contacts map to the contacts import");
is("the fields are the contacts import's columns, in order", [...HUBSPOT_CONTACT_FIELDS], COLUMNS.contacts);
const contacts = parseCsv(CONTACTS);
const columns = hubSpotContactColumns(contacts.header);
is("email, first and last name found", [columns.email, columns.firstName, columns.lastName], [2, 3, 4]);
is("every other column is listed as not brought in", columns.ignored, ["Record ID", "Create date", "Phone number", "Lifecycle stage"]);
is("first and last name are joined", hubSpotContactRow(contacts.rows[0], columns), ["ada@example.com", "Ada Lovelace", "", ""]);
is("a missing last name leaves the first", hubSpotContactRow(contacts.rows[1], columns), ["grace@example.com", "Grace", "", ""]);
is("a file with no name columns gives an empty name", hubSpotContactRow(["7", "x@example.com"], hubSpotContactColumns(["Record ID", "Email"])), ["x@example.com", "", "", ""]);

part("Deals with HubSpot's default stages");
const defaults = ok(
  plan([
    row("1", "Course for Acme", "Contract sent", "Sales Pipeline", "1500.00", "2026-12-01", "ada@example.com"),
    row("2", "Coaching for Beta", "Closed won", "Sales Pipeline", "250", "2026-10-15T16:50:06.678Z"),
    row("3", "Workshop for Gamma", "Appointment scheduled"),
    row("4", "Bundle for Delta", "Closed lost"),
  ]),
);
is("one pipeline proposed, named as in the file", defaults.pipelines.map((p) => [p.name, p.deals]), [["Sales Pipeline", 4]]);
is(
  "open stages in HubSpot's order, then won, then lost",
  defaults.pipelines[0].stages,
  [
    { name: "Appointment scheduled", kind: "open", fromFile: true },
    { name: "Contract sent", kind: "open", fromFile: true },
    { name: "Closed won", kind: "won", fromFile: true },
    { name: "Closed lost", kind: "lost", fromFile: true },
  ],
);
is("the first deal reads whole", defaults.deals[0], {
  line: 2,
  recordId: "1",
  title: "Course for Acme",
  cents: 150000,
  amountNote: "",
  closeDate: "2026-12-01",
  closeDateNote: "",
  pipeline: "Sales Pipeline",
  stage: "Contract sent",
  email: "ada@example.com",
  emailNote: "",
});
is("a close date with a time keeps its day", defaults.deals[1].closeDate, "2026-10-15");
is("no associated contact gives no address", defaults.deals[2].email, "");
is("nothing refused", defaults.refused, []);
is("the deal owner column is listed as not brought in", defaults.ignored, ["Deal owner"]);
is("the seven default stages: five open, Closed won, Closed lost", HUBSPOT_DEFAULT_STAGES.map((s) => s.kind), ["open", "open", "open", "open", "open", "won", "lost"]);
is("won and lost by label, any case", [stageKindOf("Closed won"), stageKindOf("CLOSED  LOST"), stageKindOf("Closed")], ["won", "lost", "open"]);

part("Custom stages and pipelines");
const custom = ok(plan([row("1", "Retainer", "Discovery call", "Partners"), row("2", "Audit", "Proposal out", "Partners"), row("3", "Audit two", "discovery call", "partners")]));
is("a custom pipeline keeps its stage names exactly, as first written", custom.pipelines[0].stages.map((s) => [s.name, s.kind, s.fromFile]), [
  ["Discovery call", "open", true],
  ["Proposal out", "open", true],
  ["Won", "won", false],
  ["Lost", "lost", false],
]);
is("a pipeline and a stage written in another case are the same ones", [custom.deals[2].pipeline, custom.deals[2].stage], ["Partners", "Discovery call"]);
const noPipeline = ok(plan([["9", "Loose deal", "Contract sent"]], {}, ["Record ID", "Deal name", "Deal stage"]));
is("a file without a pipeline column puts deals in a pipeline named Sales", noPipeline.pipelines.map((p) => p.name), ["Sales"]);

part("Amounts");
is("plain amount in the stated store currency", readHubSpotAmount("1500", "usd", "", "usd"), { cents: 150000, note: "" });
is("commas between thousands", readHubSpotAmount("12,500.50", "usd", "", "usd").cents, 1250050);
is("the store's own sign is read", readHubSpotAmount("$99.90", "usd", "", "usd").cents, 9990);
is("a code in the cell states the currency", readHubSpotAmount("USD 40", "usd").cents, 4000);
is("a currency column states it", readHubSpotAmount("40", "eur", "EUR").cents, 4000);
is("yen has no decimals", readHubSpotAmount("5000", "jpy", "", "jpy").cents, 5000);
is("trailing zero decimals are fine", readHubSpotAmount("10.500", "usd", "", "usd").cents, 1050);
is("no currency stated: no amount, and why", readHubSpotAmount("1500", "usd").cents, null);
is("the sentence says what to do", /Say which currency/.test(readHubSpotAmount("1500", "usd").note), true);
is("another currency: no amount, never converted", readHubSpotAmount("EUR 1500", "usd", "", "usd").cents, null);
is("another currency names both", /EUR and your store uses USD/.test(readHubSpotAmount("1500 EUR", "usd").note), true);
is("European writing is not guessed", readHubSpotAmount("1.500,00", "usd", "", "usd").cents, null);
is("a wrong comma group is not guessed", readHubSpotAmount("15,00", "usd", "", "usd").cents, null);
is("more decimals than the currency has: never rounded", readHubSpotAmount("10.555", "usd", "", "usd").cents, null);
is("a negative amount is not read", readHubSpotAmount("-100", "usd", "", "usd").cents, null);
is("another currency's sign is not read", readHubSpotAmount("€100", "usd", "", "usd").cents, null);
is("words are not an amount", readHubSpotAmount("about a thousand", "usd", "", "usd").cents, null);
is("an empty cell is no amount, with nothing to say", readHubSpotAmount("", "usd", "", "usd"), { cents: null, note: "" });
is("more than a deal holds: no amount, never cut", readHubSpotAmount("999999999999", "usd", "", "usd").cents, null);
const amounts = ok(plan([row("1", "A", "Contract sent", "P", "1500"), row("2", "B", "Contract sent", "P", "lots")], { statedCurrency: "" }));
is("in a plan, an amount without a currency comes in as none", amounts.deals.map((d) => d.cents), [null, null]);
is("an unreadable amount still lets the deal in, with its note", amounts.deals[1].amountNote.startsWith('"lots" is not an amount'), true);

part("Dates and associated contacts");
is("a US-style date is not guessed", readHubSpotDate("12/01/2026").date, null);
is("an impossible day is refused", readHubSpotDate("2026-02-30").date, null);
is("its sentence shows the form to use", /2026-11-04/.test(readHubSpotDate("01/12/2026").note), true);
const many = ok(plan([row("1", "Group deal", "Contract sent", "P", "", "", "101 Ada@Example.com; 102 grace@example.com")]));
is("the first associated address is kept, lowercased", many.deals[0].email, "ada@example.com");
is("and the others are said", /2 people/.test(many.deals[0].emailNote), true);

part("Refusals, never cuts");
const bad = ok(plan([row("1", "", "Contract sent"), row("2", "x".repeat(MAX_DEAL_TITLE + 1), "Contract sent"), row("3", "Fine", ""), row("4", "Again", "Contract sent"), row("4", "Twice", "Contract sent")]));
is("rows refused by line, with the column", bad.refused.map((r) => [r.line, r.column]), [
  [2, "Deal name"],
  [3, "Deal name"],
  [4, "Deal stage"],
  [6, "Record ID"],
]);
is("a long name is refused, not shortened", bad.refused[1].value.length, MAX_DEAL_TITLE + 1);
is("each reason says what to do", bad.refused.every((r) => /HubSpot|once/.test(r.reason)), true);
is("only the good row comes in", bad.deals.map((d) => d.title), ["Again"]);
const tooMany = plan(Array.from({ length: 11 }, (_, i) => row(String(i), `Deal ${i}`, "Contract sent")), { dealRoom: 10 });
is("more deals than the room refuses the whole file", tooMany.ok ? "taken" : [tooMany.reason, tooMany.count, tooMany.room], ["too_many", 11, 10]);
is("its sentence says nothing came in and what to do", !tooMany.ok && /Nothing was brought in/.test(tooMany.sentence) && /Remove deals/.test(tooMany.sentence), true);
const atRoom = plan(Array.from({ length: 10 }, (_, i) => row(String(i), `Deal ${i}`, "Contract sent")), { dealRoom: 10 });
is("exactly the room is taken", atRoom.ok && atRoom.deals.length, 10);
const capped = plan([row("1", "One", "Contract sent")], { dealRoom: MAX_DEALS * 5 });
is("the room never passes MAX_DEALS", capped.ok, true);

part("Stage cap");
const labels = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"];
const wide = ok(plan([...labels.map((l, i) => row(String(i), `Deal ${i}`, l, "Wide")), row("w", "Won deal", "Closed won", "Wide")]));
is(`a pipeline gets at most ${MAX_STAGES} stages`, wide.pipelines[0].stages.length, MAX_STAGES);
is("won and lost are kept within the cap", wide.pipelines[0].stages.slice(-2).map((s) => s.kind), ["won", "lost"]);
is("deals past the cap are refused with a reason", wide.refused.map((r) => r.value), ["S7", "S8"]);
is("the reason names the cap", wide.refused[0].reason.includes(`${MAX_STAGES} stages`), true);
const longStage = ok(plan([row("1", "Deal", "A stage name that is far too long to keep")]));
is("a stage name too long is refused, not shortened", [longStage.deals.length, longStage.refused[0]?.column], [0, "Deal stage"]);

part("Pipeline cap");
const three = plan([row("1", "A", "Contract sent", "First"), row("2", "B", "Contract sent", "Second"), row("3", "C", "Contract sent", "Third")], { pipelineRoom: 2 });
const threeOk = ok(three);
is("only as many pipelines as the room, in the order they appear", threeOk.pipelines.map((p) => p.name), ["First", "Second"]);
is("the deals in the others are refused with a reason", threeOk.refused.map((r) => [r.line, r.value]), [[4, "Third"]]);
is("the reason says the room and what to do", /room for 2 more pipelines/.test(threeOk.refused[0].reason), true);
const none = ok(plan([row("1", "A", "Contract sent", "First")], { pipelineRoom: 0 }));
is("no room makes no pipeline", [none.pipelines.length, none.deals.length, /no more pipelines/.test(none.refused[0].reason)], [0, 0, true]);

part("Notes");
is("the notes sentence says they are not in the export and not imported", /not in the file HubSpot exports/.test(HUBSPOT_NOTES_NOT_IMPORTED) && /does not bring them in/.test(HUBSPOT_NOTES_NOT_IMPORTED), true);
is("and says how to keep them", /Export contact data/.test(HUBSPOT_NOTES_NOT_IMPORTED), true);

done();
