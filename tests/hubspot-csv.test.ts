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
  hubSpotDealColumns,
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
is("a file without a pipeline column puts deals in the first pipeline, Sales when the store does not say its name", noPipeline.pipelines.map((p) => p.name), ["Sales"]);

part("Amounts");
is("plain amount in the stated store currency", readHubSpotAmount("1500", "usd", "", "usd"), { cents: 150000, note: "" });
is("a comma is never read (1,500 may be one and a half)", [readHubSpotAmount("12,500.50", "usd", "", "usd").cents, readHubSpotAmount("1,500", "usd", "", "usd").cents, /without commas/.test(readHubSpotAmount("1,5", "usd", "", "usd").note)], [null, null, true]);
is("the store's own sign is read", readHubSpotAmount("$99.90", "usd", "", "usd").cents, 9990);
is("a code in the cell states the currency", readHubSpotAmount("USD 40", "usd").cents, 4000);
is("a currency column states it", readHubSpotAmount("40", "eur", "EUR").cents, 4000);
is("a currency column that holds no code is said as such, never read as one", [readHubSpotAmount("40", "usd", "US Dollar", "usd").cents, /Currency column says "US Dollar", which is not a three-letter currency code/.test(readHubSpotAmount("40", "usd", "US Dollar", "usd").note), readHubSpotAmount("40", "usd", "USDC", "usd").cents], [null, true, null]);
is("only a column labeled exactly Currency is the currency column", [hubSpotDealColumns([...DEALS_HEADER, "Amount in company currency"]).currency, hubSpotDealColumns([...DEALS_HEADER, "Amount in company currency", "Currency"]).currency], [-1, DEALS_HEADER.length + 1]);
is("a code in the cell is read before such a column", readHubSpotAmount("USD 40", "usd", "US Dollar").cents, 4000);
is("yen has no decimals", readHubSpotAmount("5000", "jpy", "", "jpy").cents, 5000);
is("more digits after the point than the currency has are refused, zeros too (10.500 may be ten thousand five hundred)", readHubSpotAmount("10.500", "usd", "", "usd").cents, null);
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

part("Edge cases read strictly");
is("a point between thousands is never read as cents", ["1.500", "12.500", "1.5000", "EUR 1.500"].map((a) => readHubSpotAmount(a, "usd", "", "usd").cents), [null, null, null, null]);
is("and the note says it could be read two ways", /more digits after the point than USD has, so it could be read two ways/.test(readHubSpotAmount("1.500", "usd", "", "usd").note), true);
is("a currency with no cents is never given a cents example", [/like 1500,/.test(readHubSpotAmount("lots", "jpy", "", "jpy").note), /1500\.50/.test(readHubSpotAmount("lots", "jpy", "", "jpy").note), readHubSpotAmount("1.5", "jpy", "", "jpy").cents, readHubSpotAmount("1500", "jpy", "", "jpy").cents], [true, false, null, 1500]);
is("a day that does not exist is said as such", [readHubSpotDate("2026-02-29").date, /is not a real day/.test(readHubSpotDate("2026-02-29").note), readHubSpotDate("0000-01-01").date, /is not a real day/.test(readHubSpotDate("0000-01-01").note)], [null, true, null, true]);
is("a time after the day must be a real time", [readHubSpotDate("2026-11-04 25:61").date, readHubSpotDate("2026-11-04T9").date, readHubSpotDate("2026-11-04T09:30:00.000Z").date, readHubSpotDate("2026-11-04 17:45").date, readHubSpotDate("2028-02-29").date], [null, null, "2026-11-04", "2026-11-04", "2028-02-29"]);
const dotted = ok(plan([row("1", "Dotted", "Contract sent", "P", "", "", "Jane (jane@example.com.)")]));
is("a dot that ends a sentence is not kept in an address", dotted.deals[0].email, "jane@example.com");
is("rooms that are not numbers are no room", [planHubSpotDeals({ header: DEALS_HEADER, rows: [row("1", "A", "Contract sent")] }, { currency: "usd", pipelineRoom: Number.NaN }).ok && (planHubSpotDeals({ header: DEALS_HEADER, rows: [row("1", "A", "Contract sent")] }, { currency: "usd", pipelineRoom: Number.NaN }) as { deals: unknown[] }).deals.length, planHubSpotDeals({ header: DEALS_HEADER, rows: [row("1", "A", "Contract sent")] }, { currency: "usd", pipelineRoom: 1, dealRoom: Number.NaN }).ok], [0, false]);
is("a stage named Won or Lost is the won or lost one", [stageKindOf("Won"), stageKindOf("LOST"), stageKindOf("Won big")], ["won", "lost", "open"]);
const ownWon = ok(plan([row("1", "A", "Pitch", "Own"), row("2", "B", "Won", "Own"), row("3", "C", "Lost", "Own"), row("4", "D", "Closed won", "Own")]));
is("so a pipeline never has two stages of one name", ownWon.pipelines[0].stages.map((st) => `${st.name}:${st.kind}`), ["Pitch:open", "Won:won", "Lost:lost"]);
is("and a second won label goes to the won stage", ownWon.deals.map((d) => d.stage), ["Pitch", "Won", "Lost", "Won"]);
const firstRefused = ok(plan([row("8", "Other", "Contract sent", "P"), row("7", "Too far", "Contract sent", "Third"), row("7", "Same id", "Contract sent", "P")], { pipelineRoom: 1 }));
is("a first copy refused for its pipeline does not refuse the second", [firstRefused.deals.map((d) => d.title), firstRefused.refused.map((r) => [r.line, r.column])], [["Other", "Same id"], [[3, "Pipeline"]]]);
is("a name with a line break or a NUL is one line", hubSpotContactRow(["1", "x@example.com", "Ada\nB\u0000"], { email: 1, firstName: 2, lastName: -1, ignored: [] })[1], "Ada B");

part("Dates and associated contacts");
is("a US-style date is not guessed", readHubSpotDate("12/01/2026").date, null);
is("an impossible day is refused", readHubSpotDate("2026-02-30").date, null);
is("its sentence shows the form to use", /2026-11-04/.test(readHubSpotDate("01/12/2026").note), true);
const many = ok(plan([row("1", "Group deal", "Contract sent", "P", "", "", "101 Ada@Example.com; 102 grace@example.com")]));
is("the first associated address is kept, lowercased", many.deals[0].email, "ada@example.com");
is("and the others are said, as the column lists them", /column lists 2 addresses/.test(many.deals[0].emailNote), true);

part("Refusals, never cuts");
const bad = ok(plan([row("1", "", "Contract sent"), row("2", "x".repeat(MAX_DEAL_TITLE + 1), "Contract sent"), row("3", "Fine", ""), row("4", "Again", "Contract sent"), row("4", "Twice", "Contract sent")]));
is("rows refused by line, with the column", bad.refused.map((r) => [r.line, r.column]), [
  [2, "Deal name"],
  [3, "Deal name"],
  [4, "Deal stage"],
  [6, "Record ID"],
]);
is("a long name is refused, not shortened", bad.refused[1].value.length, MAX_DEAL_TITLE + 1);
is("each reason says what to do", bad.refused.every((r) => /HubSpot|first row/.test(r.reason)), true);
const dup = ok(plan([row("9", "First", ""), row("9", "Second", "Contract sent"), row("9", "Third", "Contract sent")]));
is("a row refused for itself never takes its Record ID: the next one with it is read", [dup.deals.map((d) => d.title), dup.refused.map((r) => [r.line, r.column])], [["Second"], [[2, "Deal stage"], [4, "Record ID"]]]);
is("the repeat names the row that has the Record ID too", /^Row 3 has this Record ID too/.test(dup.refused[1].reason), true);
const allClosed = ok(plan([row("1", "Old win", "Closed won", "Done deals")]));
is("a pipeline whose deals are all closed still gets an open stage", allClosed.pipelines[0].stages.map((st) => `${st.name}:${st.kind}:${st.fromFile}`), ["New:open:false", "Closed won:won:true", "Lost:lost:false"]);
const toFirst = ok(plan([row("1", "One", "Contract sent", "")], { firstPipeline: "Main board" }));
is("a deal with no pipeline goes to the store's first pipeline, by its name", toFirst.deals[0].pipeline, "Main board");
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
