/**
 * Moving from HubSpot, the spreadsheet half (639 [GL7](10), unit 1, added
 * 4 November 2026): how the files HubSpot exports from its contacts and
 * deals lists read here. Rules only: no storage, no route, no screen.
 *
 * What HubSpot's own pages say about the file, read on 4 November 2026
 * (knowledge.hubspot.com "Export records", last updated April 2, 2026;
 * "HubSpot's default contact properties", September 21, 2026; "HubSpot's
 * default deal properties", September 29, 2026; "Set up and customize your
 * deal pipelines and deal stages", October 22, 2026):
 *
 *   - the file is CSV, XLSX or XLS; this reads the CSV (lib/csv.ts);
 *   - each column is named by the property's label, in the language the
 *     person chose under "Language of column headers", not by its internal
 *     name; with every property exported, "Record ID" is the first column;
 *   - each associated object has its own column, holding record IDs and the
 *     associated record's name; the exact header text is not printed, so
 *     a column is taken as associated contacts only when its label starts
 *     with "Associated Contact";
 *   - notes and other activities are not in this file at all;
 *   - the default deal pipeline has seven stages, "Closed won" being won
 *     and "Closed lost" being lost.
 *
 * Only English labels are known here. A file exported with labels in
 * another language is not taken for a HubSpot file: it reads as any other
 * spreadsheet, whose columns the creator matches by hand, as today. No
 * label is ever translated by guess.
 *
 * Nothing here is cut to fit: a deal name, stage or pipeline name too long
 * for this CRM, a stage or pipeline past what a store holds, or a file with
 * more deals than the store has room for is refused with a sentence saying
 * what to do, never shortened or partly taken.
 *
 * Pure and browser-safe: the studio's screen and the server read the same.
 */
import { MAX_DEAL_CENTS, MAX_DEAL_TITLE, MAX_DEALS, MAX_PIPELINE_NAME, MAX_PIPELINES, MAX_STAGE_NAME, MAX_STAGES, FIRST_PIPELINE_NAME, type StageKind } from "@/lib/crm-rules";
import { decimalsOf } from "@/lib/money";

/** The two lists HubSpot exports that this reads. */
export type HubSpotFile = "contacts" | "deals";

/** The English labels HubSpot's default properties are exported under (its default property pages, read 4 November 2026). */
export const HUBSPOT_LABELS = {
  recordId: "Record ID",
  contacts: { email: "Email", firstName: "First name", lastName: "Last name", phone: "Phone number" },
  deals: { title: "Deal name", stage: "Deal stage", pipeline: "Pipeline", amount: "Amount", closeDate: "Close date", currency: "Currency" },
} as const;

/** How the start of an associated-contacts column reads, once squashed (see `squash`). */
const ASSOCIATED_CONTACT = "associatedcontact";

/** The seven stages of HubSpot's default deal pipeline, in its order, with the kind each becomes here. */
export const HUBSPOT_DEFAULT_STAGES: readonly { label: string; kind: StageKind }[] = [
  { label: "Appointment scheduled", kind: "open" },
  { label: "Qualified to buy", kind: "open" },
  { label: "Presentation scheduled", kind: "open" },
  { label: "Decision maker bought-in", kind: "open" },
  { label: "Contract sent", kind: "open" },
  { label: "Closed won", kind: "won" },
  { label: "Closed lost", kind: "lost" },
];

/** The fields a row of contacts carries to the import, in the order of `COLUMNS.contacts` in lib/imports.ts. */
export const HUBSPOT_CONTACT_FIELDS = ["email", "name", "tags", "consent"] as const;

/** Said on the screen when a file is not recognized as HubSpot's. */
export const HUBSPOT_ENGLISH_ONLY =
  "Marktmorgen knows HubSpot's files by their English column names. If you exported with column names in another language, export again and choose English under \"Language of column headers\". Or match each column yourself on the next step.";

/** Said on the screen beside every HubSpot import: notes do not come in. */
export const HUBSPOT_NOTES_NOT_IMPORTED =
  "Notes are not in the file HubSpot exports from your contacts or deals list, so this import does not bring them in. To keep a contact's notes, open that contact in HubSpot, choose Actions, then Export contact data, and keep the file.";

/** Said on the screen before contacts come in: this import does not read consent from HubSpot's file. */
export const HUBSPOT_CONTACTS_CONSENT =
  "This import does not read consent from HubSpot's file. Bring these contacts in only if each of them agreed to get your emails, and confirm it on the next step.";

/** Said about the columns this import does not bring in. */
export const HUBSPOT_IGNORED_COLUMNS = "These columns are not brought in. Nothing in them is changed or kept here.";

/** Case, spaces, dashes and underscores do not matter, as in lib/csv.ts (guessColumn). */
const squash = (s: string) => s.toLowerCase().replace(/[\s_\-.]+/g, "");

/** The column whose label is exactly this one, ignoring case and spacing; -1 for none. */
function columnOf(header: readonly string[], label: string): number {
  const want = squash(label);
  return header.findIndex((h) => squash(h) === want);
}

/** One line, no control characters, spaces collapsed. Never shortened. */
const oneLine = (value: string | undefined) =>
  (value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Which HubSpot list a file was exported from, by its English labels:
 * contacts when it has "Record ID", "Email" and a first or last name;
 * deals when it has "Record ID", "Deal name" and "Deal stage". Null for
 * any other file, a HubSpot file with labels in another language included.
 */
export function hubSpotFileOf(header: readonly string[]): HubSpotFile | null {
  if (columnOf(header, HUBSPOT_LABELS.recordId) < 0) return null;
  const has = (label: string) => columnOf(header, label) >= 0;
  if (has(HUBSPOT_LABELS.deals.title) && has(HUBSPOT_LABELS.deals.stage)) return "deals";
  if (has(HUBSPOT_LABELS.contacts.email) && (has(HUBSPOT_LABELS.contacts.firstName) || has(HUBSPOT_LABELS.contacts.lastName))) return "contacts";
  return null;
}

/** Whether a file's first line is that of a HubSpot contacts or deals export, in English. */
export const isHubSpotExport = (header: readonly string[]): boolean => hubSpotFileOf(header) !== null;

/** Every non-empty label not in `used`, as the file writes it. */
const ignoredOf = (header: readonly string[], used: readonly number[]) => header.filter((label, i) => !used.includes(i) && label.trim() !== "").map((label) => label.trim());

// ---------------------------------------------------------------- contacts

/** Where a HubSpot contacts file keeps what the contacts import reads; -1 for a column it does not have. */
export type HubSpotContactColumns = { email: number; firstName: number; lastName: number; ignored: string[] };

/**
 * The columns of a HubSpot contacts file. The contacts import here keeps an
 * address, a name and tags; a phone number, a lifecycle stage, an owner and
 * every other column are listed as not brought in.
 */
export function hubSpotContactColumns(header: readonly string[]): HubSpotContactColumns {
  const email = columnOf(header, HUBSPOT_LABELS.contacts.email);
  const firstName = columnOf(header, HUBSPOT_LABELS.contacts.firstName);
  const lastName = columnOf(header, HUBSPOT_LABELS.contacts.lastName);
  return { email, firstName, lastName, ignored: ignoredOf(header, [email, firstName, lastName]) };
}

/**
 * One HubSpot contact as the contacts import takes it, in the order of
 * `HUBSPOT_CONTACT_FIELDS`: the address as written (the import checks it),
 * first and last name joined, no tags and no consent cell, since HubSpot's
 * file has neither. The import's own checks then apply as to any file.
 */
export function hubSpotContactRow(row: readonly string[], columns: HubSpotContactColumns): string[] {
  const cell = (at: number) => (at >= 0 ? (row[at] ?? "").trim() : "");
  const name = [cell(columns.firstName), cell(columns.lastName)].filter(Boolean).join(" ");
  return [cell(columns.email), name, "", ""];
}

// ---------------------------------------------------------------- deals

/** Where a HubSpot deals file keeps each field; -1 for one it does not have. */
export type HubSpotDealColumns = {
  recordId: number;
  title: number;
  stage: number;
  pipeline: number;
  amount: number;
  closeDate: number;
  /** A column labeled exactly "Currency", when the file has one (HubSpot's pages do not name it). */
  currency: number;
  /** Every column whose label starts with "Associated Contact". */
  contacts: number[];
  ignored: string[];
};

export function hubSpotDealColumns(header: readonly string[]): HubSpotDealColumns {
  const at = (label: string) => columnOf(header, label);
  const recordId = at(HUBSPOT_LABELS.recordId);
  const title = at(HUBSPOT_LABELS.deals.title);
  const stage = at(HUBSPOT_LABELS.deals.stage);
  const pipeline = at(HUBSPOT_LABELS.deals.pipeline);
  const amount = at(HUBSPOT_LABELS.deals.amount);
  const closeDate = at(HUBSPOT_LABELS.deals.closeDate);
  const currency = at(HUBSPOT_LABELS.deals.currency);
  const contacts = header.flatMap((h, i) => (squash(h).startsWith(ASSOCIATED_CONTACT) ? [i] : []));
  const used = [recordId, title, stage, pipeline, amount, closeDate, currency, ...contacts];
  return { recordId, title, stage, pipeline, amount, closeDate, currency, contacts, ignored: ignoredOf(header, used) };
}

/** What an amount cell became: an amount in the store currency's smallest unit, or none and why. */
export type HubSpotAmount = { cents: number; note: "" } | { cents: null; note: string };

/** An amount: a three-letter currency code before or after it ("USD 1500", "1500 usd"), a sign before the digits ("$1500"). */
const AMOUNT = /^(?:([A-Za-z]{3})\s*)?([^\d\sA-Za-z,.]{1,2})?\s*([\d,.]+)(?:\s*([A-Za-z]{3}))?$/;

/** The symbol a store's currency is written with, when it has one of its own ("$" for the US dollar). */
function narrowSymbol(currency: string): string {
  try {
    const parts = new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase(), currencyDisplay: "narrowSymbol" }).formatToParts(1);
    return parts.find((part) => part.type === "currency")?.value ?? "";
  } catch {
    return "";
  }
}

/**
 * A deal's amount, read only when the currency is known and is the store's:
 * from a code in the cell, then from a currency column, then from what the
 * creator said the file is in (`statedCurrency`). A currency nobody stated is
 * never assumed. Plain amounts read: 1500, 1500.50. A comma is never read
 * (1,500 may be one and a half), nor a currency column that is not a
 * three-letter code. Anything else, more decimals than the
 * currency has (other than zeros), or more than a deal holds, is no amount,
 * with a sentence saying why: never a rounded or guessed one.
 */
export function readHubSpotAmount(raw: string, storeCurrency: string, columnCurrency = "", statedCurrency = ""): HubSpotAmount {
  const text = oneLine(raw);
  if (text === "") return { cents: null, note: "" };
  const store = storeCurrency.toLowerCase();
  const unreadable = { cents: null, note: `"${text}" is not an amount this import can read, so this deal comes in with no amount. Type it on the deal, like 1500 or 1500.50, without commas.` } as const;
  const shaped = AMOUNT.exec(text);
  if (!shaped) return unreadable;
  const [, before = "", sign = "", number, after = ""] = shaped;
  if ((before && after) || !/^\d+(?:\.\d+)?$/.test(number)) return unreadable;
  const inCell = (before || after).toLowerCase();
  const column = oneLine(columnCurrency);
  if (!inCell && column && !/^[A-Za-z]{3}$/.test(column)) {
    return { cents: null, note: `The Currency column says "${column}", which is not a three-letter currency code like USD, so this deal comes in with no amount. Type the amount on the deal if you want one.` };
  }
  const currency = inCell || column.toLowerCase() || statedCurrency.trim().toLowerCase();
  if (!currency) return { cents: null, note: "The file does not say which currency this amount is in, so this deal comes in with no amount. Say which currency the file uses on the next step to keep amounts." };
  if (currency !== store) return { cents: null, note: `This amount is in ${currency.toUpperCase()} and your store uses ${store.toUpperCase()}, so this deal comes in with no amount. Type the amount in ${store.toUpperCase()} on the deal if you want one.` };
  if (sign && sign !== narrowSymbol(store)) return unreadable;
  const [whole, fraction = ""] = number.replace(/,/g, "").split(".");
  const digits = decimalsOf(store);
  if (/[^0]/.test(fraction.slice(digits))) return unreadable;
  const units = whole.replace(/^0+(?=\d)/, "") + fraction.slice(0, digits).padEnd(digits, "0");
  const cents = units.length > 16 ? Number.POSITIVE_INFINITY : Number(units);
  if (!Number.isSafeInteger(cents) || cents > MAX_DEAL_CENTS) {
    return { cents: null, note: "This amount is more than a deal here can hold, so this deal comes in with no amount. Type a smaller amount on the deal if you want one." };
  }
  return { cents, note: "" };
}

/** A close date written as year-month-day, with or without a time after it; the day as written. */
export function readHubSpotDate(raw: string): { date: string | null; note: string } {
  const text = oneLine(raw);
  if (text === "") return { date: null, note: "" };
  const day = /^(\d{4}-\d{2}-\d{2})(?:[T ][0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(text)?.[1];
  const at = day ? Date.parse(`${day}T00:00:00Z`) : Number.NaN;
  if (!day || !Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== day) {
    return { date: null, note: `The close date "${text}" is not written as year-month-day, like 2026-11-04, so it was left out. Add it on the deal if you want it.` };
  }
  return { date: day, note: "" };
}

const ADDRESS = /[^\s@;,<>()"']{1,64}@[^\s@;,<>()"']{1,255}\.[^\s@;,<>()"']{2,}/g;

/** A deal as it would come in, before anything is saved: names, not ids, for the pipeline and stage. */
export type HubSpotDealDraft = {
  /** The row number in the file, the header being 1. */
  line: number;
  /** HubSpot's Record ID, so the same file brought in twice makes nothing twice. */
  recordId: string;
  title: string;
  /** In the store currency's smallest unit; null for none. */
  cents: number | null;
  /** Why there is no amount, when the file had one that could not be read. */
  amountNote: string;
  /** Year-month-day; null for none. */
  closeDate: string | null;
  closeDateNote: string;
  pipeline: string;
  stage: string;
  /** The first address in an associated-contacts column, when the column has one; "" for none. */
  email: string;
  /** Set when the deal had more than one associated address and only the first is kept. */
  emailNote: string;
};

/** A row that does not come in, and why. */
export type HubSpotRefusal = { line: number; column: string; value: string; reason: string };

/** A stage to make, named exactly as in the file, or added so the pipeline has a won and a lost stage. */
export type ProposedStage = { name: string; kind: StageKind; fromFile: boolean };
export type ProposedPipeline = { name: string; stages: ProposedStage[]; deals: number };

export type HubSpotDealsPlan =
  | { ok: true; pipelines: ProposedPipeline[]; deals: HubSpotDealDraft[]; refused: HubSpotRefusal[]; ignored: string[] }
  | { ok: false; reason: "too_many"; count: number; room: number; sentence: string };

export type HubSpotDealsOptions = {
  /** The store's currency: amounts in any other are not taken. */
  currency: string;
  /** The currency the creator says the file's amounts are in; "" when not said. */
  statedCurrency?: string;
  /** How many new pipelines the store may still make (its plan's limit less those it has; lib/crm-rules.ts, pipelineLimit). */
  pipelineRoom: number;
  /** How many more deals the store may hold; at most MAX_DEALS. */
  dealRoom?: number;
  /** The name of the store's first pipeline, where a deal with no pipeline in the file goes; FIRST_PIPELINE_NAME when not said. */
  firstPipeline?: string;
};

/** The kind a HubSpot stage label stands for: "Closed won" and "Closed lost" by name, any other open. */
export function stageKindOf(label: string): StageKind {
  const value = oneLine(label).toLowerCase();
  if (value === "closed won") return "won";
  if (value === "closed lost") return "lost";
  return "open";
}

const defaultIndex = (label: string) => HUBSPOT_DEFAULT_STAGES.findIndex((s) => s.label.toLowerCase() === label.toLowerCase());

/**
 * The stages a pipeline gets from the labels its deals use: the open ones
 * first (HubSpot's default ones in its order, then the others as they first
 * appear: the file does not say their order, so the creator can reorder
 * them after), then the won one, then the lost one. A pipeline with no
 * "Closed won" or "Closed lost" gets a "Won" or "Lost" stage added, and one
 * with no open stage a "New" one, so it has the three kinds every pipeline
 * here has. Open stages past what a
 * pipeline holds are returned apart, to refuse their deals.
 */
function stagesOf(labels: readonly string[]): { stages: ProposedStage[]; over: string[] } {
  const open = labels.filter((l) => stageKindOf(l) === "open");
  const known = open.filter((l) => defaultIndex(l) >= 0).sort((a, b) => defaultIndex(a) - defaultIndex(b));
  const others = open.filter((l) => defaultIndex(l) < 0);
  const ordered = [...known, ...others];
  const room = MAX_STAGES - 2;
  const won = labels.find((l) => stageKindOf(l) === "won");
  const lost = labels.find((l) => stageKindOf(l) === "lost");
  const stages: ProposedStage[] = [
    ...ordered.slice(0, room).map((name) => ({ name, kind: "open" as const, fromFile: true })),
    // Every pipeline here has an open stage: one whose deals are all closed gets a "New" one.
    ...(ordered.length ? [] : [{ name: "New", kind: "open" as const, fromFile: false }]),
    won ? { name: won, kind: "won", fromFile: true } : { name: "Won", kind: "won", fromFile: false },
    lost ? { name: lost, kind: "lost", fromFile: true } : { name: "Lost", kind: "lost", fromFile: false },
  ];
  return { stages, over: ordered.slice(room) };
}

/** Why a deal in a pipeline past the store's room does not come in, with what to do. */
export function pipelineRoomReason(room: number): string {
  return `Your store has room for ${room <= 0 ? "no more pipelines" : room === 1 ? "1 more pipeline" : `${room} more pipelines`}, and this file has more, so the deals in this pipeline were not brought in. Remove a pipeline you no longer need here, or move these deals to another pipeline in HubSpot, then bring the file in again.`;
}

/** Why a deal in a stage past what its pipeline holds does not come in. */
export const STAGE_PAST_REASON = `A pipeline here holds up to ${MAX_STAGES} stages, won and lost included, and this deal's stage is past them, so it was not brought in. Move it to another stage in HubSpot, then bring the file in again.`;

/** Said when a file has more deals to bring in than the store has room for: nothing comes in. */
export function tooManyDealsSentence(count: number, room: number): string {
  const many = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "deal" : "deals"}`;
  return `This file has ${many(count)} to bring in, and your store has room for ${many(Math.max(0, room))} more (a store holds up to ${MAX_DEALS.toLocaleString("en-US")}). Nothing was brought in. Remove deals from the file, or delete deals you no longer need here, then bring it in again.`;
}

/**
 * Reads a HubSpot deals file into what would be made here: the pipelines
 * and stages to create and each deal, with every row that does not come in
 * and why. Nothing is saved. A file with more deals than the store has room
 * for is refused whole, never cut to the first ones.
 */
export function planHubSpotDeals(file: { header: readonly string[]; rows: readonly (readonly string[])[]; lines?: readonly number[] }, options: HubSpotDealsOptions): HubSpotDealsPlan {
  const columns = hubSpotDealColumns(file.header);
  const label = (at: number) => (at >= 0 ? (file.header[at] ?? "").trim() : "");
  const refused: HubSpotRefusal[] = [];
  const read: (HubSpotDealDraft & { key: string })[] = [];
  const seen = new Map<string, number>();
  file.rows.forEach((row, i) => {
    const line = file.lines?.[i] ?? i + 2;
    const cell = (at: number) => (at >= 0 ? oneLine(row[at]) : "");
    const refuse = (at: number, value: string, reason: string) => refused.push({ line, column: label(at), value, reason });
    const recordId = cell(columns.recordId);
    const title = cell(columns.title);
    if (!title) return refuse(columns.title, "", "This deal has no name. Give it a name in HubSpot, then export again.");
    if (title.length > MAX_DEAL_TITLE) return refuse(columns.title, title, `A deal name here holds up to ${MAX_DEAL_TITLE} characters, and this one is longer. Shorten it in HubSpot, then export again.`);
    const stage = cell(columns.stage);
    if (!stage) return refuse(columns.stage, "", "This deal has no stage. Choose its stage in HubSpot, then export again.");
    if (stage.length > MAX_STAGE_NAME) return refuse(columns.stage, stage, `A stage name here holds up to ${MAX_STAGE_NAME} characters, and this one is longer. Rename the stage in HubSpot, then export again.`);
    const pipeline = cell(columns.pipeline) || options.firstPipeline || FIRST_PIPELINE_NAME;
    if (pipeline.length > MAX_PIPELINE_NAME) return refuse(columns.pipeline, pipeline, `A pipeline name here holds up to ${MAX_PIPELINE_NAME} characters, and this one is longer. Rename the pipeline in HubSpot, then export again.`);
    // Checked once the row itself reads, so a row refused above never takes its Record ID.
    if (recordId) {
      const first = seen.get(recordId);
      if (first !== undefined) return refuse(columns.recordId, recordId, `Row ${first} has this Record ID too. Only the first row with a Record ID is read, so this row was not brought in.`);
      seen.set(recordId, line);
    }
    const amount = readHubSpotAmount(cell(columns.amount), options.currency, cell(columns.currency), options.statedCurrency ?? "");
    const close = readHubSpotDate(cell(columns.closeDate));
    const addresses = columns.contacts.flatMap((at) => (row[at] ?? "").match(ADDRESS) ?? []).map((a) => a.toLowerCase());
    const unique = [...new Set(addresses)];
    read.push({
      key: pipeline.toLowerCase(),
      line,
      recordId,
      title,
      cents: amount.cents,
      amountNote: amount.note,
      closeDate: close.date,
      closeDateNote: close.note,
      pipeline,
      stage,
      email: unique[0] ?? "",
      emailNote: unique.length > 1 ? `The associated contacts column lists ${unique.length} addresses for this deal. A deal here is with one person, so the first address, ${unique[0]}, is kept.` : "",
    });
  });

  // Pipelines in the order they first appear, each named as first written; past the store's room, refused.
  const pipelineRoom = Math.max(0, Math.min(MAX_PIPELINES, Math.floor(options.pipelineRoom)));
  const order: string[] = [];
  const named = new Map<string, string>();
  const labelsOf = new Map<string, string[]>();
  for (const deal of read) {
    if (!named.has(deal.key)) {
      order.push(deal.key);
      named.set(deal.key, deal.pipeline);
      labelsOf.set(deal.key, []);
    }
    const labels = labelsOf.get(deal.key) as string[];
    if (!labels.some((l) => l.toLowerCase() === deal.stage.toLowerCase())) labels.push(deal.stage);
  }
  const pipelines: ProposedPipeline[] = [];
  const stageName = new Map<string, Map<string, string>>();
  const over = new Map<string, Set<string>>();
  for (const key of order.slice(0, pipelineRoom)) {
    const made = stagesOf(labelsOf.get(key) as string[]);
    pipelines.push({ name: named.get(key) as string, stages: made.stages, deals: 0 });
    stageName.set(key, new Map(made.stages.filter((s) => s.fromFile).map((s) => [s.name.toLowerCase(), s.name])));
    over.set(key, new Set(made.over.map((l) => l.toLowerCase())));
  }
  const deals: HubSpotDealDraft[] = [];
  for (const { key, ...deal } of read) {
    const names = stageName.get(key);
    if (!names) {
      refused.push({
        line: deal.line,
        column: label(columns.pipeline),
        value: deal.pipeline,
        reason: pipelineRoomReason(pipelineRoom),
      });
      continue;
    }
    if (over.get(key)?.has(deal.stage.toLowerCase())) {
      refused.push({
        line: deal.line,
        column: label(columns.stage),
        value: deal.stage,
        reason: STAGE_PAST_REASON,
      });
      continue;
    }
    const stage = names.get(deal.stage.toLowerCase()) ?? deal.stage;
    deals.push({ ...deal, pipeline: named.get(key) as string, stage });
    const pipeline = pipelines.find((p) => p.name === named.get(key));
    if (pipeline) pipeline.deals += 1;
  }
  refused.sort((a, b) => a.line - b.line);

  const room = Math.max(0, Math.min(MAX_DEALS, Math.floor(options.dealRoom ?? MAX_DEALS)));
  if (deals.length > room) {
    return { ok: false, reason: "too_many", count: deals.length, room, sentence: tooManyDealsSentence(deals.length, room) };
  }
  return { ok: true, pipelines, deals, refused, ignored: columns.ignored };
}
