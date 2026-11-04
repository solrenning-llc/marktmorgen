/**
 * Moving from another platform: three imports, each a spreadsheet the
 * creator brings from Stan, Gumroad, Kajabi, Mailchimp or anywhere else.
 *
 *   contacts   addresses onto the store's email list — only people the
 *              creator confirms agreed to hear from them, and never anyone
 *              who unsubscribed here (lib/contacts.ts). Up to 50,000 rows.
 *   products   drafts in the store, each checked the way the product editor
 *              checks it, hidden until the creator publishes it. Up to 500.
 *   members    members of a membership elsewhere, each emailed their own link
 *              to keep it here, first charged on the day it would have
 *              renewed there (lib/move-members.ts). Nobody is given a
 *              membership: keeping it is a checkout. Up to 20,000 rows, and
 *              the emails count with the past buyers' in the same month.
 *   purchases  past buyers given what they bought before, with no payment
 *              and no receipt here, marked for what they are
 *              (lib/imported-purchases.ts). Up to 20,000 rows, and, only if
 *              the creator ticks it, one email to each buyer saying so — at
 *              most what reserveMoved allows a store in a calendar month, and
 *              within the company's daily cap (lib/mail.ts), since they go
 *              out from our sender to addresses only the creator vouches for.
 *
 * The browser reads the file (lib/csv.ts), the creator says which column is
 * which, and the rows come here in batches of up to BATCH_ROWS, each cell
 * capped. Nothing is trusted: every row is checked again here, when it is
 * applied. The work itself is done a chunk at a time — a few hundred rows,
 * or fifty products — so no request runs long: the studio's page advances it
 * while it is open (runImport, from app/api/store/import), and the job every
 * five minutes finishes whatever is left (app/api/cron/imports). Two never
 * run the same import at once: each takes the import's lock.
 *
 * Every row that is not brought in is written down with its row number, the
 * column and the reason, and the creator downloads that as a spreadsheet
 * (lib/csv.ts writes it, so nothing in it runs as a formula). A store runs
 * one import at a time.
 *
 *   nl:import:<id>              the import: its kind, store, state, counts
 *   nl:import:<id>:rows         the rows as they came, one batch per entry
 *   nl:import:<id>:seen         what was seen already -> the row it was on
 *   nl:import:<id>:errors       rows not brought in, for the report
 *   nl:import:<id>:mail         buyers still to be emailed (purchases only)
 *   nl:import:<id>:lock         whoever is working on it now
 *   nl:imports:busy:<sid>       the import a store is running, while it runs
 *   nl:imports:list:<sid>       the store's last imports, newest first
 *   nl:imports:active           imports with work left, for the job
 *
 * Everything but the list of a store's last imports is let go two weeks
 * after the import began.
 *
 * Moving from ClickFunnels (added 17 October 2026) is the same three imports
 * of contacts, products and past buyers, read the way ClickFunnels' exports
 * are written (lib/clickfunnels-csv.ts), with two differences: a contact
 * without recorded consent comes in as a contact the creator cannot email
 * rather than being left out, and an opt-out there is kept here. Before any
 * import, previewImport is its dry run: every row checked here the way the
 * import will check it, against the store as it is, and nothing written.
 */
import { DataRoomError } from "@/lib/store-data";
import { windowId } from "@/lib/allowance-window";
import { randomBytes } from "node:crypto";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { LockBusyError, releaseLock, takeLock } from "@/lib/redis-lock";
import {
  type DraftProduct,
  type Store,
  MAX_PRODUCTS,
  MAX_SUMMARY_LENGTH,
  MAX_TITLE_LENGTH,
  addDraftProducts,
  ensureListId,
  ensureStatsId,
  setPastBuyers,
  storeForId,
  storeRef,
} from "@/lib/store";
import { readAllListings, readListings, readTitles } from "@/lib/catalog";
import { priceInRange, rangeWords, readMoney } from "@/lib/money";
import { LINK_PROBLEMS, type LinkProblem, readLink } from "@/lib/product-link";
import { MAX_ABOUT_LENGTH, cleanAbout, writeAbout } from "@/lib/product-about";
import { type ContactOutcome, type ImportedContact, MAX_CONTACT_NAME, importContactRows, previewContactRows, readTags } from "@/lib/contacts";
import { csvLine, readConsent } from "@/lib/csv";
import { grantImported, importedFor } from "@/lib/imported-purchases";
import { deliverableItems } from "@/lib/bundle-rules";
import { NIMBUS_FROM, isSenderConfigured, sendBatch } from "@/lib/email";
import { giveBackToMonth, monthlyAllowance, releaseDay, reserveDay, takeFromMonth } from "@/lib/mail";
import { IMPORT_MIN_ROWS_PER_UPLOAD, IMPORT_ROW_BYTES, importAllowanceFor, importRowsFor } from "@/lib/import-limits";
import { costsPaused } from "@/lib/plan-standing";
import { healthTags, noteSent, pausedFor, rampBack, rampRoom, startRamp } from "@/lib/mail-health";
import { isPaidUp } from "@/lib/billing";
import { storeBase } from "@/lib/purchase-email";
import { canSell, canSellProduct } from "@/lib/store-checkout";
import { inviteEmail, inviteMembers, keptAlready, noteKept, dueReminders, remindLater, reminderEmail, readInvite } from "@/lib/move-members";
import { type DateOrder, MAX_AHEAD_DAYS, MAX_MOVED_MEMBERS, readRenewal } from "@/lib/move-rules";
import { type ContactConsent, consentFrom, readClickFunnelsStatus, readOrderStatus } from "@/lib/clickfunnels-csv";

export type ImportKind = "contacts" | "products" | "purchases" | "members";
/** Where the file came from: any platform's spreadsheet, or ClickFunnels' own exports (lib/clickfunnels-csv.ts). */
export type ImportSource = "csv" | "clickfunnels";

/** The most rows one import may bring, by kind. */
export const IMPORT_LIMITS: Record<ImportKind, number> = { contacts: 50_000, products: 500, purchases: 20_000, members: MAX_MOVED_MEMBERS };
/** Rows one upload request may carry. */
export const BATCH_ROWS = 1_000;
/** The most an upload request may weigh. */
export const BATCH_BYTES = 1_000_000;
/** Rows kept for the report of what was not brought in; the count goes on past it. */
export const MAX_REPORT_ROWS = 5_000;

/** The columns each kind's rows carry, after the row number. */
export const COLUMNS: Record<ImportKind, string[]> = {
  contacts: ["email", "name", "tags", "consent"],
  products: ["title", "price", "description", "type", "link"],
  purchases: ["email", "product", "status"],
  members: ["email", "product", "renews", "option"],
};

/** How long a cell may be as it arrives; one longer is kept to this plus one, to be refused. */
const CELL_CAPS: Record<ImportKind, number[]> = {
  contacts: [MAX_EMAIL_LENGTH, MAX_CONTACT_NAME, 400, 40],
  products: [MAX_TITLE_LENGTH, 30, MAX_ABOUT_LENGTH * 2, 20, 2_000],
  purchases: [MAX_EMAIL_LENGTH, 200, 60],
  members: [MAX_EMAIL_LENGTH, 200, 60, 120],
};

/** Rows applied in one step, by kind: small enough that a step is a few seconds at most. */
const CHUNK: Record<ImportKind, number> = { contacts: 1_000, products: 50, purchases: 250, members: 250 };
/** Buyers emailed in one step. */
const MAIL_CHUNK = 100;
/**
 * The emails to buyers and members brought over, and what limits them. The
 * addresses are the creator's word alone, and the email goes out from our
 * sender, so a store cannot turn imports into a mailing list.
 *
 * Until 17 October 2026 every store had 20,000 of them in thirty days, on
 * top of its plan, which no plan's price covered ($18 a month at the most an
 * email costs, tests/plan-cost-registry.ts). Since then a plan with monthly
 * emails (Studio, Scale and their free trial) sends them out of those
 * (lib/mail.ts, takeFromMonth), and a plan without them (Store, and a store
 * with no plan) has IMPORT_ALLOWANCES.creator.movedEmails a calendar month.
 */
const movedKey = (sid: string, month: string) => `nl:imports:moved:${sid}:${month}`;
/** The store's window (lib/allowance-window.ts): its billing month when it pays, the calendar month otherwise; null when unknown. */
const utcMonth = (store: Store, now: number) => windowId(store, now);

/** Takes up to `n` for the store's emails to people brought over; answers how many it may send now. */
export async function reserveMoved(store: Store, n: number, now = Date.now()): Promise<number> {
  if (!Number.isSafeInteger(n) || n <= 0 || !store.sid) return 0;
  if (monthlyAllowance(store) > 0) return takeFromMonth(store, n);
  const cap = importAllowanceFor(store, now / 1000).movedEmails;
  if (cap <= 0) return 0;
  const window = utcMonth(store, now);
  if (!window) return 0;
  const key = movedKey(store.sid, window);
  const [, total] = await redisPipeline([
    ["SET", key, "0", "NX", "EX", 32 * 86_400],
    ["INCRBY", key, n],
  ]);
  const counted = Number(total);
  if (!Number.isSafeInteger(counted)) return 0;
  const over = Math.min(n, Math.max(0, counted - cap));
  if (over > 0) await redisPipeline([["DECRBY", key, over]]);
  return n - over;
}

/** Gives back what reserveMoved took for emails that did not go. */
export async function releaseMoved(store: Store, n: number, now = Date.now()): Promise<void> {
  if (!Number.isSafeInteger(n) || n <= 0 || !store.sid) return;
  if (monthlyAllowance(store) > 0) return giveBackToMonth(store, n);
  const window = utcMonth(store, now);
  if (window) await redisPipeline([["DECRBY", movedKey(store.sid, window), n]]);
}

/**
 * Takes `n` rows from the store's calendar month of imported rows
 * (lib/import-limits.ts), as an upload arrives. All or nothing: a batch
 * that does not fit is refused whole, and nothing is taken for it.
 */
export async function takeImportRows(store: Store, n: number, now = Date.now(), bytes = 0): Promise<{ ok: true; counted: number } | { ok: false; reason: "rows_month" | "unavailable"; limit: number }> {
  // The plan's own rows even while its costs are paused: no import starts
  // then (app/api/store/import), so these are the rows of an upload already
  // under way, which is queued rather than lost (232 [CA1] unit 4b2).
  const limit = importRowsFor(store, now / 1000);
  if (!Number.isSafeInteger(n) || n <= 0) return { ok: true, counted: 0 };
  // A small upload still costs a request: each counts at least this many
  // rows; and a heavy one what it keeps until it is applied, a row for every
  // IMPORT_ROW_BYTES (lib/import-limits.ts).
  n = Math.max(n, IMPORT_MIN_ROWS_PER_UPLOAD, Number.isFinite(bytes) && bytes > 0 ? Math.ceil(bytes / IMPORT_ROW_BYTES) : 0);
  const window = utcMonth(store, now);
  if (!store.sid || !isRedisConfigured() || !window) return { ok: false, reason: "unavailable", limit };
  const key = `nl:imports:rows:${store.sid}:${window}`;
  try {
    const [, total] = await redisPipeline([
      ["SET", key, "0", "NX", "EX", 32 * 86_400],
      ["INCRBY", key, n],
    ]);
    const counted = Number(total);
    if (!Number.isSafeInteger(counted)) return { ok: false, reason: "unavailable", limit };
    if (counted <= limit) return { ok: true, counted: n };
    await redisPipeline([["DECRBY", key, n]]);
    return { ok: false, reason: "rows_month", limit };
  } catch {
    return { ok: false, reason: "unavailable", limit };
  }
}

/**
 * Gives back rows takeImportRows counted (`counted`, what it answered) for
 * an import that then wrote nothing (lib/hubspot-import.ts), in the same
 * month's figure. Never throws.
 */
export async function giveImportRows(store: Store, counted: number, now = Date.now()): Promise<void> {
  const window = utcMonth(store, now);
  if (!Number.isSafeInteger(counted) || counted <= 0 || !store.sid || !isRedisConfigured() || !window) return;
  await redisPipeline([["DECRBY", `nl:imports:rows:${store.sid}:${window}`, counted]]).catch(() => undefined);
}
const KEEP_SECONDS = 14 * 86_400;
/**
 * How long the rows themselves are kept while they wait to be brought in
 * (since 18 October 2026): what they weigh is counted in the database's
 * figure for that long (tests/store-data-registry.ts). An import still not
 * done by then stops, and says to start it again.
 */
export const RAW_DAYS = 3;
/** An upload that stops before its last batch is given up after this long. */
const RECEIVING_MS = 2 * 60 * 60 * 1000;
const LOCK_SECONDS = 70;
const LIST_SIZE = 10;

export const IMPORT_ID_PATTERN = /^[0-9a-f]{24}$/;

export type ImportState = "receiving" | "queued" | "running" | "mailing" | "done" | "canceled" | "failed";

export type ImportJob = {
  id: string;
  kind: ImportKind;
  /** The store's own id. */
  sid: string;
  /** Who started it. */
  by: string;
  /** When it began, in milliseconds. */
  at: number;
  state: ImportState;
  /** The file's name, for the list of imports. */
  file: string;
  /** Rows the browser said it would send. */
  expected: number;
  /** Rows received. */
  total: number;
  /** Rows looked at. */
  done: number;
  /** Where the next step starts: which batch, and which row in it. */
  cursor: { batch: number; row: number };
  counts: {
    /** Brought in: added to the list, made as a draft, given to a buyer. */
    added: number;
    /** Already there: on the list as agreeing, or already given that product. */
    already: number;
    /** Left out on purpose: no consent, unsubscribed, a repeated row. */
    skipped: number;
    /** Could not be brought in: see the report. */
    errors: number;
    /** Buyers emailed, and emails the sender refused. */
    mailed: number;
    unmailed: number;
    /** Contacts: brought in as contacts who may not be emailed. Absent on imports made before it existed. */
    contacts?: number;
    /** Contacts: could be emailed until now, and left where the file came from, so no longer here. */
    stopped?: number;
  };
  options: {
    /** Contacts: the creator confirmed these people agreed to hear from them. */
    agreed: boolean;
    /** Contacts: the file has a column saying, row by row, whether each did. */
    consentColumn: boolean;
    /** Contacts: labels given to everyone this file brings. */
    tags: string[];
    /** Purchases: one email to each buyer given something. Members: always, their link. */
    email: boolean;
    /**
     * Members: how the file writes a date that is all numbers, as the creator
     * chose it from a list for the whole file; "" when they did not need to.
     */
    dateOrder?: DateOrder | "";
    /** Where the file came from; absent on imports made before ClickFunnels files were read. */
    source?: ImportSource;
  };
  finishedAt: number;
};

const jobKey = (id: string) => `nl:import:${id}`;
const rowsKey = (id: string) => `nl:import:${id}:rows`;
const seenKey = (id: string) => `nl:import:${id}:seen`;
const errorsKey = (id: string) => `nl:import:${id}:errors`;
const mailKey = (id: string) => `nl:import:${id}:mail`;
const lockKey = (id: string) => `nl:import:${id}:lock`;
const busyKey = (sid: string) => `nl:imports:busy:${sid}`;
const listKey = (sid: string) => `nl:imports:list:${sid}`;
const ACTIVE_KEY = "nl:imports:active";

type Command = (string | number)[];

function parseJob(raw: unknown): ImportJob | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as ImportJob;
    return value && typeof value.id === "string" && IMPORT_ID_PATTERN.test(value.id) ? value : null;
  } catch {
    return null;
  }
}

export async function readJob(id: string): Promise<ImportJob | null> {
  if (!IMPORT_ID_PATTERN.test(id) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", jobKey(id)]]);
  return parseJob(raw);
}

/** One import of this store, or null when it is not this store's. */
export async function jobOf(store: Store, id: string): Promise<ImportJob | null> {
  const job = await readJob(id);
  return job && store.sid && job.sid === store.sid ? job : null;
}

function saveJob(job: ImportJob): Command {
  return ["SET", jobKey(job.id), JSON.stringify(job), "EX", KEEP_SECONDS];
}

/** The store's last imports, newest first, and the one running now if any. */
export async function storeImports(store: Store): Promise<ImportJob[]> {
  if (!store.sid || !isRedisConfigured()) return [];
  const [ids] = await redisPipeline([["LRANGE", listKey(store.sid), 0, LIST_SIZE - 1]]);
  const list = Array.isArray(ids) ? ids.map(String).filter((id) => IMPORT_ID_PATTERN.test(id)) : [];
  if (!list.length) return [];
  const raws = await redisPipeline(list.map((id) => ["GET", jobKey(id)]));
  return raws.map(parseJob).filter((job): job is ImportJob => job !== null && job.sid === store.sid);
}

export type StartProblem = "busy" | "too_many" | "consent" | "email" | "list" | "store" | "unavailable" | "stripe" | "stopped";

/** What an import is started with, as the studio sends it. */
export type StartInput = {
  expected: number;
  file: string;
  agreed?: boolean;
  consentColumn?: boolean;
  tags?: string[];
  email?: boolean;
  stopped?: boolean;
  dateOrder?: string;
  source?: ImportSource;
};

/**
 * Why an import of this kind cannot start on this store as it stands, or
 * null when it can. The same checks for the dry run as for the import, so a
 * dry run never says yes to what the import would refuse; changes nothing.
 */
export function startProblem(store: Store, kind: ImportKind, input: StartInput): { reason: StartProblem; limit?: number } | null {
  if (!isRedisConfigured()) return { reason: "unavailable" };
  if (!store.sid) return { reason: "store" };
  const expected = Math.floor(Number(input.expected));
  if (!Number.isFinite(expected) || expected < 1 || expected > IMPORT_LIMITS[kind]) return { reason: "too_many", limit: IMPORT_LIMITS[kind] };
  // Contacts come in as people the creator may email only when the creator
  // says, in so many words, that these people agreed to hear from them. A
  // per-row consent column narrows that; it never replaces it. A ClickFunnels
  // file without that word brings everyone in as a contact who may not be
  // emailed, so it needs no confirmation to start.
  if (kind === "contacts" && input.agreed !== true && input.source !== "clickfunnels") return { reason: "consent" };
  if (kind === "products" && store.catalog.items.length >= MAX_PRODUCTS) return { reason: "too_many", limit: MAX_PRODUCTS };
  // The one email to past buyers is sent from the store's name by our sender:
  // only for a store in good standing, where email can go out at all.
  if (kind === "purchases" && input.email === true && (!isSenderConfigured() || !isPaidUp(store))) return { reason: "email" };
  // Members are always emailed their link, and keeping it is a checkout on
  // the creator's Stripe account: both have to be possible before anyone is invited.
  if (kind === "members" && (!isSenderConfigured() || !isPaidUp(store))) return { reason: "email" };
  if (kind === "members" && !canSell(store)) return { reason: "stripe" };
  // And only once the creator says they will stop the old renewals, so nobody pays twice.
  if (kind === "members" && input.stopped !== true) return { reason: "stopped" };
  return null;
}

/**
 * Begins an import: the browser has read the file and says how many rows it
 * will send. A store runs one import at a time, so a second waits for the
 * first to finish or be cancelled.
 */
export async function startImport(
  store: Store,
  by: string,
  kind: ImportKind,
  input: StartInput,
): Promise<{ ok: true; job: ImportJob } | { ok: false; reason: StartProblem; limit?: number }> {
  const problem = startProblem(store, kind, input);
  if (problem) return { ok: false, ...problem };
  const expected = Math.floor(Number(input.expected));
  const ref = storeRef(store);
  if (kind === "contacts" && !store.listId && !(await ensureListId(ref))?.listId) return { ok: false, reason: "list" };
  if ((kind === "purchases" || kind === "products" || kind === "members") && !store.statsId) await ensureStatsId(ref);

  const id = randomBytes(12).toString("hex");
  const [claimed] = await redisPipeline([["SET", busyKey(store.sid), id, "NX", "EX", KEEP_SECONDS]]);
  if (claimed === null) {
    // A slot held by an import that has since finished, or was given up, is freed.
    const [holder] = await redisPipeline([["GET", busyKey(store.sid)]]);
    const other = typeof holder === "string" ? await readJob(holder) : null;
    if (other && !finished(other.state) && !(other.state === "receiving" && Date.now() - other.at > RECEIVING_MS)) {
      return { ok: false, reason: "busy" };
    }
    if (other && other.state === "receiving") await cancelJob(other);
    await redisPipeline([["SET", busyKey(store.sid), id, "EX", KEEP_SECONDS]]);
  }
  const job: ImportJob = {
    id,
    kind,
    sid: store.sid,
    by,
    at: Date.now(),
    state: "receiving",
    file: String(input.file ?? "").replace(/[\r\n]/g, " ").slice(0, 120),
    expected,
    total: 0,
    done: 0,
    cursor: { batch: 0, row: 0 },
    counts: { added: 0, already: 0, skipped: 0, errors: 0, mailed: 0, unmailed: 0, contacts: 0, stopped: 0 },
    options: {
      agreed: kind === "contacts" && input.agreed === true,
      consentColumn: kind === "contacts" && input.consentColumn === true,
      tags: kind === "contacts" ? readTags(input.tags ?? []) : [],
      email: (kind === "purchases" && input.email === true) || kind === "members",
      dateOrder: kind === "members" && (input.dateOrder === "mdy" || input.dateOrder === "dmy") ? input.dateOrder : "",
      source: input.source === "clickfunnels" && kind !== "members" ? "clickfunnels" : "csv",
    },
    finishedAt: 0,
  };
  await redisPipeline([saveJob(job), ["LPUSH", listKey(store.sid), id], ["LTRIM", listKey(store.sid), 0, LIST_SIZE - 1]]);
  return { ok: true, job };
}

function finished(state: ImportState): boolean {
  return state === "done" || state === "canceled" || state === "failed";
}

/** Rows as they arrive: arrays of strings, the row number first, each cell capped. */
export function readBatch(kind: ImportKind, raw: unknown): string[][] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > BATCH_ROWS) return null;
  const caps = CELL_CAPS[kind];
  const out: string[][] = [];
  for (const entry of raw) {
    // A page loaded before a kind gained a column sends one cell fewer: the missing ones read as empty.
    if (!Array.isArray(entry) || entry.length < 2 || entry.length > caps.length + 1) return null;
    const line = Number(entry[0]);
    if (!Number.isInteger(line) || line < 1 || line > 10_000_000) return null;
    const cells: string[] = [String(line)];
    for (let i = 0; i < caps.length; i += 1) {
      const cell = entry[i + 1];
      if (cell !== null && typeof cell !== "string") return null;
      // One past the cap is kept, so a cell that was too long is said to be.
      cells.push(typeof cell === "string" ? cell.slice(0, caps[i] + 1) : "");
    }
    out.push(cells);
  }
  return out;
}

export type RowsProblem = "unknown" | "state" | "too_many";

/** Adds one batch of rows to an import that is still receiving them. */
export async function addRows(store: Store, id: string, rows: string[][]): Promise<{ ok: true; job: ImportJob } | { ok: false; reason: RowsProblem }> {
  const job = await jobOf(store, id);
  if (!job) return { ok: false, reason: "unknown" };
  if (job.state !== "receiving") return { ok: false, reason: "state" };
  if (job.total + rows.length > Math.min(job.expected, IMPORT_LIMITS[job.kind])) return { ok: false, reason: "too_many" };
  job.total += rows.length;
  await redisPipeline([
    ["RPUSH", rowsKey(id), JSON.stringify(rows)],
    ["EXPIRE", rowsKey(id), RAW_DAYS * 86_400],
    saveJob(job),
  ]);
  return { ok: true, job };
}

/** Every row is here: the import is queued, for the page and the job to work through. */
export async function finishUpload(store: Store, id: string): Promise<{ ok: true; job: ImportJob } | { ok: false; reason: RowsProblem }> {
  const job = await jobOf(store, id);
  if (!job) return { ok: false, reason: "unknown" };
  if (job.state !== "receiving") return { ok: false, reason: "state" };
  job.state = job.total > 0 ? "queued" : "done";
  if (job.state === "done") job.finishedAt = Date.now();
  await redisPipeline([saveJob(job), ...(job.state === "queued" ? [["SADD", ACTIVE_KEY, id]] : [])]);
  if (job.state === "done") await releaseBusy(job);
  // Past buyers are looked for on the list of purchases from now on.
  if (job.kind === "purchases" && job.state === "queued" && !store.pastBuyers) await setPastBuyers(storeRef(store));
  return { ok: true, job };
}

async function cancelJob(job: ImportJob): Promise<ImportJob> {
  if (finished(job.state)) return job;
  job.state = "canceled";
  job.finishedAt = Date.now();
  await redisPipeline([saveJob(job), ["SREM", ACTIVE_KEY, job.id], ["DEL", rowsKey(job.id), seenKey(job.id), mailKey(job.id)]]);
  await releaseBusy(job);
  return job;
}

/** Lets go of the store's slot, when it is this import's: a newer import's hold is kept. */
async function releaseBusy(job: ImportJob): Promise<void> {
  const [holder] = await redisPipeline([["GET", busyKey(job.sid)]]);
  if (holder === job.id) await redisPipeline([["DEL", busyKey(job.sid)]]);
}

/**
 * Stops an import. What was brought in already stays: contacts on the list,
 * drafts in the store, buyers given their products. Nothing more is done.
 */
export async function cancelImport(store: Store, id: string): Promise<ImportJob | null> {
  const job = await jobOf(store, id);
  if (!job) return null;
  let held;
  try {
    held = await takeLock(lockKey(id), LOCK_SECONDS, 10_000);
  } catch (error) {
    if (error instanceof LockBusyError) return job;
    throw error;
  }
  try {
    const fresh = (await readJob(id)) ?? job;
    return await cancelJob(fresh);
  } finally {
    await releaseLock(held);
  }
}

// ---- Doing the work --------------------------------------------------------

type Problem = { line: number; column: string; problem: string; value: string };

async function note(job: ImportJob, problems: Problem[], kind: "errors" | "skipped"): Promise<void> {
  if (!problems.length) return;
  job.counts[kind] += problems.length;
  const [length] = await redisPipeline([["LLEN", errorsKey(job.id)]]);
  const room = Math.max(0, MAX_REPORT_ROWS - (Number(length) || 0));
  const kept = problems.slice(0, room).map((p) => JSON.stringify([p.line, p.column, `${kind === "skipped" ? "Left out: " : ""}${p.problem}`, p.value.slice(0, 300)]));
  if (kept.length) await redisPipeline([["RPUSH", errorsKey(job.id), ...kept], ["EXPIRE", errorsKey(job.id), KEEP_SECONDS]]);
}

/**
 * Notes each key as seen on its row; answers, for each, the earlier row it
 * was seen on, or null when this is the first. Seeing the same row again
 * (a step repeated after a failure) is not a repeat.
 */
async function firstSeen(job: ImportJob, keys: { key: string; line: number }[]): Promise<(number | null)[]> {
  if (!keys.length) return [];
  const answers = await redisPipeline([
    ...keys.map(({ key, line }) => ["HSETNX", seenKey(job.id), key, String(line)]),
    ["EXPIRE", seenKey(job.id), KEEP_SECONDS],
  ]);
  const again = keys.map((_, i) => Number(answers[i]) !== 1);
  const lines = again.some(Boolean)
    ? ((await redisPipeline([["HMGET", seenKey(job.id), ...keys.map((k) => k.key)]]))[0] as unknown[])
    : [];
  return keys.map(({ line }, i) => {
    if (!again[i]) return null;
    const earlier = Number(Array.isArray(lines) ? lines[i] : NaN);
    return Number.isFinite(earlier) && earlier !== line ? earlier : null;
  });
}

const isEmail = (email: string) => email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email);

/** What a row of contacts holds once it is read, and what it says about consent. */
type ContactRow = { line: number; email: string; name: string; tags: string[]; consent: ContactConsent; note: string };

/**
 * Reads a chunk of contacts the way the import and its dry run both read it:
 * which rows are addresses that can come in, with what they say about
 * consent, which are left out on purpose, and which cannot be read.
 */
function classifyContacts(options: ImportJob["options"], rows: string[][]): { valid: ContactRow[]; problems: Problem[]; skipped: Problem[] } {
  const problems: Problem[] = [];
  const skipped: Problem[] = [];
  const valid: ContactRow[] = [];
  const fromClickFunnels = options.source === "clickfunnels";
  for (const [lineText, rawEmail, name, tags, consent] of rows) {
    const line = Number(lineText);
    const email = normaliseEmail(rawEmail);
    if (!email) {
      problems.push({ line, column: "email", problem: "No email address", value: "" });
      continue;
    }
    if (!isEmail(email)) {
      problems.push({ line, column: "email", problem: "Not an email address", value: rawEmail });
      continue;
    }
    let said: ContactConsent = "agreed";
    let note = "";
    if (fromClickFunnels) {
      // Every row comes in; what the status says decides only whether it may be emailed.
      const status = options.consentColumn ? readClickFunnelsStatus(consent) : "none";
      said = consentFrom(status, options.agreed);
      note =
        status === "unknown"
          ? "The status is not Subscribed, Unsubscribed or Undeliverable, so this contact cannot be emailed"
          : status === "subscribed" && !options.agreed
            ? "Subscribed there, but you did not confirm these people agreed, so this contact cannot be emailed"
            : "";
    } else if (options.consentColumn) {
      const answer = readConsent(consent);
      if (answer === "no") {
        skipped.push({ line, column: "consent", problem: "The consent column does not say they agreed", value: consent });
        continue;
      }
      if (answer === "unknown") {
        problems.push({ line, column: "consent", problem: "Not a yes or a no, so they were not added", value: consent });
        continue;
      }
    }
    valid.push({ line, email, name: name.trim().slice(0, MAX_CONTACT_NAME), tags: readTags([...readTags(tags), ...options.tags]), consent: said, note });
  }
  return { valid, problems, skipped };
}

const asImported = (row: ContactRow): ImportedContact => ({ email: row.email, name: row.name, tags: row.tags, consent: row.consent });

async function contactsStep(job: ImportJob, store: Store, rows: string[][]): Promise<void> {
  const listId = store.listId;
  if (!listId) throw new Error("the store has no list");
  const { valid, problems, skipped } = classifyContacts(job.options, rows);
  const seen = await firstSeen(job, valid.map((v) => ({ key: `e:${v.email}`, line: v.line })));
  const fresh = valid.filter((v, i) => {
    if (seen[i] === null) return true;
    skipped.push({ line: v.line, column: "email", problem: `The same address as row ${seen[i]}`, value: v.email });
    return false;
  });
  const outcomes = await importContactRows(listId, fresh.map(asImported), store);
  outcomes.forEach((outcome, i) => {
    const row = fresh[i];
    if (outcome === "added") job.counts.added += 1;
    else if (outcome === "already") job.counts.already += 1;
    else if (outcome === "contact") job.counts.contacts = (job.counts.contacts ?? 0) + 1;
    else if (outcome === "stopped") job.counts.stopped = (job.counts.stopped ?? 0) + 1;
    else if (outcome === "left") skipped.push({ line: row.line, column: "email", problem: "Unsubscribed from your list before, so left alone", value: row.email });
    else problems.push({ line: row.line, column: "email", problem: "Your list is full", value: row.email });
  });
  await note(job, skipped, "skipped");
  await note(job, problems, "errors");
}

/** A price as another platform may write it: its currency's sign or code in front is dropped. */
function priceText(raw: string): string {
  return raw.trim().replace(/^(?:[A-Za-z]{1,3}\s?)?[$€£¥₹]?\s*/, "").replace(/\s*(?:[A-Za-z]{3})$/, "");
}

/** A description as another platform may export it, HTML and all, as plain text. */
function plainText(raw: string): string {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };
  return raw
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|li|h[1-6])\s*>/gi, "\n\n")
    .replace(/<\s*li[^>]*>/gi, "- ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, name: string) => entities[name] ?? "");
}

/** The first sentences of a long description that fit the card, cut at a word. */
function summaryOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_SUMMARY_LENGTH) return flat;
  const cut = flat.slice(0, MAX_SUMMARY_LENGTH - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > MAX_SUMMARY_LENGTH / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

type ProductRow = { line: number; draft: DraftProduct; about: string };

/** Reads a chunk of products the way the import and its dry run both read it, each checked as the product editor checks it. */
function classifyProducts(store: Store, rows: string[][]): { valid: ProductRow[]; problems: Problem[] } {
  const problems: Problem[] = [];
  const valid: ProductRow[] = [];
  for (const [lineText, rawTitle, rawPrice, rawDescription, rawType, rawLink] of rows) {
    const line = Number(lineText);
    const title = rawTitle.replace(/\s+/g, " ").trim();
    if (!title) {
      problems.push({ line, column: "title", problem: "No title", value: "" });
      continue;
    }
    if (title.length > MAX_TITLE_LENGTH) {
      problems.push({ line, column: "title", problem: `Longer than ${MAX_TITLE_LENGTH} characters`, value: title });
      continue;
    }
    const type = rawType.trim().toLowerCase();
    if (type && type !== "free" && type !== "paid") {
      problems.push({ line, column: "type", problem: "Type must be free or paid", value: rawType });
      continue;
    }
    const price = priceText(rawPrice);
    let priceCents = 0;
    if (type === "free" || (!type && (price === "" || /^0+([.,]0+)?$/.test(price)))) {
      if (price !== "" && !/^0+([.,]0+)?$/.test(price)) {
        problems.push({ line, column: "price", problem: "Marked free, but it has a price", value: rawPrice });
        continue;
      }
    } else {
      const amount = readMoney(price, store.currency);
      if (amount === null || amount === 0 || !priceInRange(amount, store.currency)) {
        problems.push({
          line,
          column: "price",
          problem: `A price is a plain amount ${rangeWords(store.currency)}, like 19 or 19.50`,
          value: rawPrice,
        });
        continue;
      }
      priceCents = amount;
    }
    const description = cleanAbout(plainText(rawDescription).slice(0, MAX_ABOUT_LENGTH * 2));
    if (plainText(rawDescription).trim().length > MAX_ABOUT_LENGTH) {
      problems.push({ line, column: "description", problem: `Longer than ${MAX_ABOUT_LENGTH.toLocaleString("en-US")} characters`, value: rawDescription.slice(0, 80) });
      continue;
    }
    let link: string | null = null;
    if (rawLink.trim()) {
      const read = readLink(rawLink);
      if (!read.ok) {
        problems.push({ line, column: "link", problem: LINK_PROBLEMS[read.reason as LinkProblem], value: rawLink });
        continue;
      }
      link = read.url;
    }
    const summary = summaryOf(description);
    // The whole description goes on the product's own page when the card cannot hold it.
    const about = description.length > MAX_SUMMARY_LENGTH || description.includes("\n") ? description : "";
    valid.push({ line, draft: { title, summary, priceCents, link }, about });
  }
  return { valid, problems };
}

/** How a product's title is compared with the store's: case, and runs of space, do not count. */
const titleKey = (title: string) => title.replace(/\s+/g, " ").trim().toLowerCase();

/** The titles of every product the store has now, drafts included: one read of the store's product names. */
async function storeTitles(store: Store): Promise<Set<string>> {
  return new Set([...(await readTitles(store)).values()].map(titleKey));
}

/**
 * The listings a chunk of past buyers names, by id or by title, and what the
 * bundles among them hold: one read of the names, then only those products,
 * rather than every product of the store for every chunk.
 */
async function listingsNamed(store: Store, rows: string[][]): Promise<Awaited<ReturnType<typeof readListings>>> {
  const asked = new Set(rows.map((row) => (row[2] ?? "").replace(/\s+/g, " ").trim()).filter(Boolean));
  const askedTitles = new Set([...asked].map(titleKey));
  const ids = new Set<string>();
  for (const [id, title] of await readTitles(store)) if (asked.has(id) || askedTitles.has(titleKey(title))) ids.add(id);
  if (!ids.size) return [];
  const first = await readListings(store, ids);
  const inside = [...new Set(first.flatMap((p) => p.bundle ?? []))].filter((id) => !ids.has(id));
  return inside.length ? [...first, ...(await readListings(store, inside))] : first;
}

async function productsStep(job: ImportJob, store: Store, rows: string[][]): Promise<void> {
  const { valid: drafts, problems } = classifyProducts(store, rows);
  const skipped: Problem[] = [];
  const seen = await firstSeen(job, drafts.map((d) => ({ key: `t:${titleKey(d.draft.title)}`, line: d.line })));
  const unseen = drafts.filter((d, i) => {
    if (seen[i] === null) return true;
    skipped.push({ line: d.line, column: "title", problem: `The same title as row ${seen[i]}`, value: d.draft.title });
    return false;
  });
  // Rows a run already made a product of, before it stopped short of saving
  // its place: made once, never twice.
  const madeBefore = unseen.length
    ? ((await redisPipeline([["HMGET", seenKey(job.id), ...unseen.map((d) => `m:${d.line}`)]]))[0] as unknown[])
    : [];
  const notMade = unseen.filter((_, i) => !(Array.isArray(madeBefore) && madeBefore[i]));
  // A product the store already has, by its title, is already there: importing
  // the same file again, or a second export of the same products, makes no copies.
  const titles = notMade.length ? await storeTitles(store) : new Set<string>();
  const fresh = notMade.filter((d) => {
    if (!titles.has(titleKey(d.draft.title))) return true;
    job.counts.already += 1;
    return false;
  });
  if (fresh.length) {
    let made = await addDraftProducts(storeRef(store), fresh.map((d) => ({ ...d.draft, about: d.about !== "" })));
    let taking = fresh;
    if (!made.ok && made.reason === "too_many") {
      // As many as there is room for, and the rest said plainly.
      taking = fresh.slice(0, made.room);
      for (const d of fresh.slice(made.room)) {
        problems.push({ line: d.line, column: "title", problem: `Your store is full (${MAX_PRODUCTS.toLocaleString("en-US")} products)`, value: d.draft.title });
      }
      made = taking.length ? await addDraftProducts(storeRef(store), taking.map((d) => ({ ...d.draft, about: d.about !== "" }))) : { ok: true, store, ids: [] };
    }
    if (!made.ok) throw new Error(`adding imported products failed: ${made.reason}`);
    if (made.ids.length) {
      await redisPipeline([
        ["HSET", seenKey(job.id), ...taking.slice(0, made.ids.length).flatMap((d) => [`m:${d.line}`, "1"])],
        ["EXPIRE", seenKey(job.id), KEEP_SECONDS],
      ]);
    }
    const statsId = made.store.statsId;
    for (let i = 0; i < made.ids.length; i += 1) {
      if (taking[i].about && statsId) await writeAbout(statsId, made.ids[i], taking[i].about, made.store);
    }
    job.counts.added += made.ids.length;
  }
  await note(job, skipped, "skipped");
  await note(job, problems, "errors");
}

type PurchaseRow = { line: number; email: string; productId: string; bundle: string[] | null };

/** Reads a chunk of past buyers the way the import and its dry run both read it, against the store's products. */
function classifyPurchases(listings: Awaited<ReturnType<typeof readListings>>, rows: string[][]): { valid: PurchaseRow[]; problems: Problem[]; skipped: Problem[] } {
  const problems: Problem[] = [];
  const skipped: Problem[] = [];
  const byId = new Map(listings.map((p) => [p.id, p]));
  const byTitle = new Map<string, typeof listings>();
  for (const p of listings) {
    const key = titleKey(p.title);
    byTitle.set(key, [...(byTitle.get(key) ?? []), p]);
  }
  const valid: PurchaseRow[] = [];
  for (const [lineText, rawEmail, rawProduct, rawStatus = ""] of rows) {
    const line = Number(lineText);
    const email = normaliseEmail(rawEmail);
    if (!isEmail(email)) {
      problems.push({ line, column: "email", problem: email ? "Not an email address" : "No email address", value: rawEmail });
      continue;
    }
    // Only a paid order gives anything: a refunded, failed or canceled one never does.
    const status = readOrderStatus(rawStatus);
    if (status === "unpaid") {
      skipped.push({ line, column: "status", problem: "Not a paid order, so nothing is given", value: rawStatus });
      continue;
    }
    if (status === "unknown") {
      problems.push({ line, column: "status", problem: "Not a status that can be read: only paid orders are given", value: rawStatus });
      continue;
    }
    const asked = rawProduct.replace(/\s+/g, " ").trim();
    const named = byId.get(asked) ? [byId.get(asked)!] : byTitle.get(asked.toLowerCase()) ?? [];
    if (named.length === 0) {
      problems.push({ line, column: "product", problem: "No product in your store has this name or id", value: rawProduct });
      continue;
    }
    if (named.length > 1) {
      problems.push({ line, column: "product", problem: `${named.length} products have this name: use the product's id instead`, value: rawProduct });
      continue;
    }
    const product = named[0];
    if (product.recurring) {
      problems.push({ line, column: "product", problem: "A membership runs on a subscription and cannot be given this way", value: rawProduct });
      continue;
    }
    if (product.call) {
      problems.push({ line, column: "product", problem: "A call is booked for a time and cannot be given this way", value: rawProduct });
      continue;
    }
    // A course or podcast at several prices still opens one thing: itself.
    if (product.options.length > 0 && !product.course && !product.podcast) {
      problems.push({ line, column: "product", problem: "It has several prices, so there is no one thing to give", value: rawProduct });
      continue;
    }
    // A bundle gives what it holds now, kept with the buyer as a checkout keeps it.
    const items = product.bundle ? deliverableItems(product, listings).map((p) => p.id) : null;
    if (!(product.course || product.file || product.link || (items && items.length > 0))) {
      problems.push({ line, column: "product", problem: "It has nothing to hand over yet: add its file, link or lessons, then import again", value: rawProduct });
      continue;
    }
    valid.push({ line, email, productId: product.id, bundle: items });
  }
  return { valid, problems, skipped };
}

async function purchasesStep(job: ImportJob, store: Store, rows: string[][]): Promise<void> {
  const statsId = store.statsId;
  if (!statsId) throw new Error("the store has no statsId");
  const listings = await listingsNamed(store, rows);
  const { valid, problems, skipped } = classifyPurchases(listings, rows);
  const seen = await firstSeen(job, valid.map((v) => ({ key: `p:${v.email}|${v.productId}`, line: v.line })));
  const fresh = valid.filter((v, i) => {
    if (seen[i] === null) return true;
    skipped.push({ line: v.line, column: "email", problem: `The same buyer and product as row ${seen[i]}`, value: v.email });
    return false;
  });
  const given = await grantImported(statsId, job.id, fresh.map((v) => ({ email: v.email, productId: v.productId, items: v.bundle })), undefined, store.sid, store);
  const toMail: string[] = [];
  given.forEach((isNew, i) => {
    if (isNew) {
      job.counts.added += 1;
      toMail.push(fresh[i].email);
    } else job.counts.already += 1;
  });
  if (job.options.email && toMail.length) {
    await redisPipeline([["SADD", mailKey(job.id), ...new Set(toMail)], ["EXPIRE", mailKey(job.id), KEEP_SECONDS]]);
  }
  await note(job, skipped, "skipped");
  await note(job, problems, "errors");
}

// ---- The dry run -------------------------------------------------------------

/** What one row would become: the same words the import's counts use. */
export type PreviewOutcome = "added" | "contact" | "already" | "stopped" | "left" | "skipped" | "error";

/**
 * One row of a dry run: its row number, what it would become, the column and
 * the reason when there is one, the cell, the key that tells a repeated row
 * (the same address, title or buyer and product), and 1 when it would take
 * new room on the list or in the store.
 */
export type PreviewRow = [line: number, outcome: PreviewOutcome, column: string, note: string, value: string, key: string, fresh: 0 | 1];

export type PreviewResult =
  | { ok: true; rows: PreviewRow[]; room: number | null }
  | { ok: false; reason: StartProblem | "kind"; limit?: number };

/** Kinds a dry run is offered for: those a move from ClickFunnels brings. */
export const PREVIEW_KINDS: readonly ImportKind[] = ["contacts", "products", "purchases"];

/**
 * The dry run of one batch of an import: every row read and checked here
 * exactly as the import will, against the store as it stands, and nothing
 * written anywhere — no contact, no draft, no purchase, no email, and not the
 * import's own records. The page sends the file a batch at a time and adds
 * the answers up; a row repeated in another batch is told by its key.
 *
 * It refuses what the import would refuse to start (startProblem), so it
 * never says yes past a plan's limit, and the import checks every row again
 * when it runs: what changed in between is what the import goes by.
 */
export async function previewImport(store: Store, kind: ImportKind, input: StartInput, raw: string[][]): Promise<PreviewResult> {
  if (!PREVIEW_KINDS.includes(kind)) return { ok: false, reason: "kind" };
  const problem = startProblem(store, kind, input);
  if (problem) return { ok: false, ...problem };
  const options: ImportJob["options"] = {
    agreed: kind === "contacts" && input.agreed === true,
    consentColumn: kind === "contacts" && input.consentColumn === true,
    tags: kind === "contacts" ? readTags(input.tags ?? []) : [],
    email: kind === "purchases" && input.email === true,
    dateOrder: "",
    source: input.source === "clickfunnels" ? "clickfunnels" : "csv",
  };
  const out: PreviewRow[] = [];
  const told = (list: Problem[], outcome: PreviewOutcome) => {
    for (const p of list) out.push([p.line, outcome, p.column, p.problem, p.value.slice(0, 300), "", 0]);
  };
  // Only the batch's own repeats are found here; the page finds those across batches by key.
  const repeated = <T extends { line: number }>(rows: T[], keyOf: (row: T) => string, column: string, valueOf: (row: T) => string, words: string): T[] => {
    const first = new Map<string, number>();
    return rows.filter((row) => {
      const key = keyOf(row);
      const earlier = first.get(key);
      if (earlier === undefined) {
        first.set(key, row.line);
        return true;
      }
      out.push([row.line, "skipped", column, `${words} ${earlier}`, valueOf(row), key, 0]);
      return false;
    });
  };

  if (kind === "contacts") {
    const { valid, problems, skipped } = classifyContacts(options, raw);
    told(problems, "error");
    told(skipped, "skipped");
    const fresh = repeated(valid, (v) => `e:${v.email}`, "email", (v) => v.email, "The same address as row");
    const { outcomes, room } = await previewContactRows(store.listId, fresh.map(asImported));
    fresh.forEach((row, i) => {
      const { outcome, fresh: isNew } = outcomes[i];
      const words: Record<Exclude<ContactOutcome, "full">, string> = {
        added: "Added as someone you may email",
        contact: row.consent === "unsubscribed"
          ? "Unsubscribed there: added as a contact you cannot email, kept as unsubscribed"
          : row.consent === "undeliverable"
            ? "Undeliverable there: added as a contact you cannot email"
            : row.note || "Added as a contact you cannot email: no recorded consent",
        already: row.consent === "unsubscribed" || row.consent === "undeliverable"
          ? "Already on your list, not emailed; now kept as unsubscribed"
          : "Already on your list: kept as it is, with this file's name and tags added",
        stopped: row.consent === "undeliverable"
          ? "On your list and emailed until now: undeliverable there, so no longer emailed"
          : "On your list and emailed until now: unsubscribed there, so no longer emailed",
        left: "Unsubscribed from your list here before, so left alone",
      };
      out.push([row.line, outcome === "left" ? "left" : outcome, "email", words[outcome], row.email, `e:${row.email}`, isNew ? 1 : 0]);
    });
    return { ok: true, rows: out.sort((a, b) => a[0] - b[0]), room };
  }

  if (kind === "products") {
    const { valid, problems } = classifyProducts(store, raw);
    told(problems, "error");
    const fresh = repeated(valid, (d) => `t:${titleKey(d.draft.title)}`, "title", (d) => d.draft.title, "The same title as row");
    const titles = fresh.length ? await storeTitles(store) : new Set<string>();
    for (const d of fresh) {
      const key = `t:${titleKey(d.draft.title)}`;
      if (titles.has(titleKey(d.draft.title))) out.push([d.line, "already", "title", "A product with this title is already in your store: no copy is made", d.draft.title, key, 0]);
      else out.push([d.line, "added", "title", d.draft.priceCents === 0 ? "Made as a free draft" : "Made as a paid draft", d.draft.title, key, 1]);
    }
    return { ok: true, rows: out.sort((a, b) => a[0] - b[0]), room: Math.max(0, MAX_PRODUCTS - store.catalog.items.length) };
  }

  const listings = await listingsNamed(store, raw);
  const { valid, problems, skipped } = classifyPurchases(listings, raw);
  told(problems, "error");
  told(skipped, "skipped");
  const fresh = repeated(valid, (v) => `p:${v.email}|${v.productId}`, "email", (v) => v.email, "The same buyer and product as row");
  const titles = new Map(listings.map((p) => [p.id, p.title]));
  for (const v of fresh) {
    out.push([v.line, "added", "product", `Given ${titles.get(v.productId) ?? "the product"}, unless they already have it`, v.email, `p:${v.email}|${v.productId}`, 0]);
  }
  return { ok: true, rows: out.sort((a, b) => a[0] - b[0]), room: null };
}

async function membersStep(job: ImportJob, store: Store, rows: string[][], now = Date.now()): Promise<void> {
  const problems: Problem[] = [];
  const skipped: Problem[] = [];
  const listings = await readAllListings(store);
  const byId = new Map(listings.map((p) => [p.id, p]));
  const byTitle = new Map<string, typeof listings>();
  for (const p of listings) {
    const key = p.title.replace(/\s+/g, " ").trim().toLowerCase();
    byTitle.set(key, [...(byTitle.get(key) ?? []), p]);
  }
  const today = Math.floor(now / 1000);
  const valid: { line: number; email: string; productId: string; option: string; renews: number }[] = [];
  for (const [lineText, rawEmail, rawProduct, rawRenews, rawOption] of rows) {
    const line = Number(lineText);
    const email = normaliseEmail(rawEmail);
    if (!isEmail(email)) {
      problems.push({ line, column: "email", problem: email ? "Not an email address" : "No email address", value: rawEmail });
      continue;
    }
    const asked = rawProduct.replace(/\s+/g, " ").trim();
    const named = byId.get(asked) ? [byId.get(asked)!] : byTitle.get(asked.toLowerCase()) ?? [];
    if (named.length === 0) {
      problems.push({ line, column: "product", problem: "No membership in your store has this name or id", value: rawProduct });
      continue;
    }
    if (named.length > 1) {
      problems.push({ line, column: "product", problem: `${named.length} products have this name: use the product's id instead`, value: rawProduct });
      continue;
    }
    const product = named[0];
    if (!product.recurring) {
      problems.push({ line, column: "product", problem: "Not a membership: past buyers of other products are brought over under Your past buyers", value: rawProduct });
      continue;
    }
    if (product.recurring.payments > 0) {
      problems.push({ line, column: "product", problem: "This membership ends after a set number of payments, and how many each member has left is not known, so it cannot be moved", value: rawProduct });
      continue;
    }
    if (!canSellProduct(store, product)) {
      problems.push({ line, column: "product", problem: "Not on sale in your store now: publish it first", value: rawProduct });
      continue;
    }
    let option = "";
    const askedOption = rawOption.replace(/\s+/g, " ").trim();
    if (product.options.length) {
      const found = product.options.find((o) => o.id === askedOption || o.label.replace(/\s+/g, " ").trim().toLowerCase() === askedOption.toLowerCase());
      if (!found) {
        problems.push({ line, column: "option", problem: askedOption ? "This membership has no price with this name" : "This membership has several prices: say which one in the price column", value: rawOption });
        continue;
      }
      option = found.id;
    } else if (askedOption && askedOption.toLowerCase() !== product.title.replace(/\s+/g, " ").trim().toLowerCase()) {
      problems.push({ line, column: "option", problem: "This membership has one price: leave the price column out, or empty", value: rawOption });
      continue;
    }
    const renews = readRenewal(rawRenews, job.options.dateOrder ?? "");
    if (!renews.ok) {
      problems.push({
        line,
        column: "renews",
        problem:
          renews.reason === "empty"
            ? "No renewal date: the day the membership would next renew is needed"
            : renews.reason === "ambiguous"
              ? "This date can be read two ways: choose how your file writes dates, or write the month in letters, like Nov 3, 2026"
              : renews.reason === "order"
                ? "This date does not fit how you said the file writes dates: write the month in letters, like Nov 3, 2026"
                : "Not a date that can be read: write the month in letters, like Nov 3, 2026",
        value: rawRenews,
      });
      continue;
    }
    if (renews.at > today + MAX_AHEAD_DAYS * 86_400) {
      problems.push({ line, column: "renews", problem: `More than ${MAX_AHEAD_DAYS} days away`, value: rawRenews });
      continue;
    }
    if (renews.at < today - 31 * 86_400) {
      problems.push({ line, column: "renews", problem: "Passed more than a month ago, so this membership has most likely ended", value: rawRenews });
      continue;
    }
    valid.push({ line, email, productId: product.id, option, renews: renews.at });
  }
  const seen = await firstSeen(job, valid.map((v) => ({ key: `m:${v.email}|${v.productId}`, line: v.line })));
  const fresh = valid.filter((v, i) => {
    if (seen[i] === null) return true;
    skipped.push({ line: v.line, column: "email", problem: `The same member and membership as row ${seen[i]}`, value: v.email });
    return false;
  });
  const fields = await inviteMembers(store, job.id, fresh, now);
  const toMail: string[] = [];
  fields.forEach((field) => {
    if (field) {
      job.counts.added += 1;
      toMail.push(field);
    } else job.counts.already += 1;
  });
  if (toMail.length) await redisPipeline([["SADD", mailKey(job.id), ...toMail], ["EXPIRE", mailKey(job.id), KEEP_SECONDS]]);
  await note(job, skipped, "skipped");
  await note(job, problems, "errors");
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function displayName(name: string): string {
  return name.replace(/["\\<>\r\n]/g, "").trim().slice(0, 60) || "A store";
}

function senderAddress(): string {
  const match = NIMBUS_FROM.match(/<([^>]+)>/);
  return (match ? match[1] : NIMBUS_FROM).trim();
}

/** The one email a past buyer gets, when the creator ticked it: what moved, and how to open it. */
export async function movedEmail(store: Store, job: ImportJob, email: string): Promise<{ subject: string; text: string } | null> {
  const given = (await importedFor(store, email)).filter((p) => p.job === job.id);
  if (!given.length) return null;
  const products = await readListings(store, given.map((p) => p.productId));
  if (!products.length) return null;
  const base = storeBase(store);
  const lines = products.map((p) => (p.course ? `- ${p.title}: ${base}/course/${p.id}` : `- ${p.title}`));
  const subject = products.length === 1 ? `${products[0].title} has moved to ${store.name}` : `What you bought from ${store.name} has moved`;
  const text = [
    `${store.name} has moved to a new store, and what you bought before comes with you. Nothing was charged, and you do not need to buy it again.`,
    "",
    products.length === 1 ? "Yours there:" : "Yours there:",
    ...lines,
    "",
    `To open ${products.length === 1 ? "it" : "any of it"}, go to ${base}/orders and type ${email}. A link to everything you have there arrives within a minute. There is no password to make.`,
    "",
    `You are getting this one email because ${store.name} moved your purchases. Nothing more is sent because of it.`,
    `Sent by Marktmorgen on behalf of ${store.name}.`,
  ].join("\n");
  return { subject: subject.slice(0, 200), text };
}

async function mailStep(job: ImportJob, store: Store): Promise<"more" | "done" | "retry"> {
  const [waiting] = await redisPipeline([["SCARD", mailKey(job.id)]]);
  if (!(Number(waiting) > 0)) return "done";
  // These addresses are the creator's word alone. Once too many of them have
  // bounced, or been answered with a spam report, the rest are not written
  // to (lib/mail-health.ts): they are counted as not emailed, and the report
  // says so.
  const paused = await pausedFor(job.sid);
  // And until then they go out in portions that double, a hundred buyers
  // first, so that a file of dead addresses is found while few have been
  // written to. A portion not yet open is waited for; nobody is dropped.
  const portion = paused ? MAIL_CHUNK : await rampRoom(job.sid, Math.min(MAIL_CHUNK, Number(waiting)));
  if (portion <= 0) return "retry";
  const [popped] = await redisPipeline([["SPOP", mailKey(job.id), portion]]);
  const emails = (Array.isArray(popped) ? popped : typeof popped === "string" ? [popped] : []).map(String);
  if (emails.length === 0) return "done";
  if (paused) {
    job.counts.unmailed += emails.length;
    return "more";
  }
  /** What was taken from the portion and did not go is given back to it. */
  const unsent = (n: number) => rampBack(job.sid, n);
  const tags = healthTags(store, false);
  const messages = [];
  for (const email of emails) {
    // For members, what waits is the invitation's field; the address is in it.
    const letter = job.kind === "members" ? await inviteEmail(store, email) : await movedEmail(store, job, email);
    if (!letter) continue;
    messages.push({
      from: `"${displayName(store.name)} via Marktmorgen" <${senderAddress()}>`,
      to: (letter as { to?: string }).to ?? email,
      subject: letter.subject,
      text: letter.text,
      html: `<div style="font-family:system-ui,sans-serif;line-height:1.5">${letter.text
        .split("\n\n")
        .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
        .join("")}</div>`,
      replyTo: store.email,
      tags,
    });
  }
  if (messages.length === 0) {
    await unsent(portion);
    return "more";
  }
  // The company's day first: over it, the same buyers wait for tomorrow.
  if (!(await reserveDay(messages.length))) {
    await redisPipeline([["SADD", mailKey(job.id), ...emails]]);
    await unsent(portion);
    return "retry";
  }
  // Then the store's month (its plan's emails, or Store's own figure): past it, the rest are not emailed.
  const room = await reserveMoved(store, messages.length);
  const sending = messages.slice(0, room);
  if (sending.length < messages.length) await releaseDay(messages.length - sending.length);
  if (sending.length === 0) {
    job.counts.unmailed += messages.length;
    await unsent(portion);
    return "more";
  }
  const sent = await sendBatch(sending, `nimbus-import:${job.id}:${emails.slice().sort()[0]}:${emails.length}`, { by: "monthly" });
  if (sent === "retry") {
    await redisPipeline([["SADD", mailKey(job.id), ...emails]]);
    await releaseMoved(store, sending.length);
    await releaseDay(sending.length);
    await unsent(portion);
    return "retry";
  }
  job.counts.unmailed += messages.length - sending.length;
  if (sent === "sent") {
    // What a bounce or a complaint is later measured against.
    await noteSent(job.sid, sending.length);
    await unsent(portion - sending.length);
    job.counts.mailed += sending.length;
  } else {
    await unsent(portion);
    job.counts.unmailed += sending.length;
  }
  return "more";
}

/**
 * Works on one import until `deadline` or until it is finished: its rows a
 * chunk at a time, then, for past buyers when the creator asked, the emails.
 * Returns the import as it stands. An import someone else is working on is
 * left to them.
 */
export async function runImport(id: string, deadline: number): Promise<ImportJob | null> {
  let held;
  try {
    held = await takeLock(lockKey(id), LOCK_SECONDS, 0);
  } catch (error) {
    if (error instanceof LockBusyError) return readJob(id);
    throw error;
  }
  const job = await readJob(id);
  try {
    if (!job) return null;
    if (job.state === "receiving" && Date.now() - job.at > RECEIVING_MS) return await cancelJob(job);
    if (job.state !== "queued" && job.state !== "running" && job.state !== "mailing") return job;
    const store = await storeForId(job.sid);
    if (!store) {
      job.state = "failed";
      job.finishedAt = Date.now();
      await redisPipeline([saveJob(job), ["SREM", ACTIVE_KEY, id], ["DEL", rowsKey(id)]]);
      return job;
    }
    // While the plan's renewal is unpaid or a payment for it is disputed
    // (lib/plan-standing.ts costsPaused, 232 [CA1] unit 4b2), the work an
    // import costs us waits: nothing is applied, nothing is emailed, and the
    // job stays as it is, so it goes on where it stopped once that is settled.
    // Rows not yet brought in are kept RAW_DAYS from their upload, as always;
    // the job and the addresses still to be emailed are kept alive meanwhile
    // (one write each, every five minutes), so a long pause loses neither.
    if (costsPaused(store, Date.now() / 1000)) {
      const [, , , holder] = await redisPipeline([saveJob(job), ["EXPIRE", mailKey(id), KEEP_SECONDS], ["EXPIRE", errorsKey(id), KEEP_SECONDS], ["GET", busyKey(job.sid)]]);
      // The store's one-import slot only while this import holds it.
      if (holder === id) await redisPipeline([["EXPIRE", busyKey(job.sid), KEEP_SECONDS]]);
      return job;
    }
    const [batches] = await redisPipeline([["LLEN", rowsKey(id)]]);
    const count = Number(batches) || 0;
    while (Date.now() < deadline) {
      if (job.state === "queued") job.state = "running";
      if (job.state === "running") {
        if (job.cursor.batch >= count) {
          // Rows let go before they were brought in (RAW_DAYS): say so, rather than call it done.
          if (job.done < job.total) {
            await note(job, [{ line: 0, column: "", problem: `The rows waited more than ${RAW_DAYS} days to be brought in, so the rest were let go. Start the import again with the rows not brought in yet.`, value: "" }], "errors");
            job.state = "failed";
            job.finishedAt = Date.now();
            await redisPipeline([saveJob(job), ["SREM", ACTIVE_KEY, id], ["DEL", rowsKey(id), mailKey(id)]]);
            await releaseBusy(job);
            return job;
          }
          job.state = job.options.email ? "mailing" : "done";
          // Addresses brought in from elsewhere are of unknown age: the
          // store's next emails to them go out in portions that double
          // (lib/mail-health.ts). A file of contacts by how many it added;
          // past buyers, when they are to be emailed, by how many those are.
          if (job.kind === "contacts") await startRamp(job.sid, job.counts.added);
          else if (job.options.email) {
            const [toMail] = await redisPipeline([["SCARD", mailKey(job.id)]]);
            await startRamp(job.sid, Number(toMail) || 0);
          }
          await redisPipeline([saveJob(job)]);
          continue;
        }
        const [raw] = await redisPipeline([["LINDEX", rowsKey(id), job.cursor.batch]]);
        let batch: string[][] = [];
        try {
          batch = typeof raw === "string" ? (JSON.parse(raw) as string[][]) : [];
        } catch {
          batch = [];
        }
        const rows = batch.slice(job.cursor.row, job.cursor.row + CHUNK[job.kind]);
        if (rows.length) {
          // The store as it is now: a chunk of products changes it.
          const current = (await storeForId(job.sid)) ?? store;
          try {
            if (job.kind === "contacts") await contactsStep(job, current, rows);
            else if (job.kind === "products") await productsStep(job, current, rows);
            else if (job.kind === "members") await membersStep(job, current, rows);
            else await purchasesStep(job, current, rows);
          } catch (error) {
            // The store's data room is full (lib/store-data.ts): what was
            // brought in stays, nothing more is, and the import says why
            // rather than trying the same rows again every few minutes.
            if (!(error instanceof DataRoomError)) throw error;
            await note(job, [{ line: 0, column: "", problem: error.message, value: "" }], "errors");
            job.state = "failed";
            job.finishedAt = Date.now();
            await redisPipeline([saveJob(job), ["SREM", ACTIVE_KEY, id], ["DEL", rowsKey(id), mailKey(id)]]);
            await releaseBusy(job);
            return job;
          }
          job.done += rows.length;
        }
        const next = job.cursor.row + CHUNK[job.kind];
        job.cursor = next >= batch.length ? { batch: job.cursor.batch + 1, row: 0 } : { batch: job.cursor.batch, row: next };
        await redisPipeline([saveJob(job)]);
        continue;
      }
      if (job.state === "mailing") {
        const step = await mailStep(job, store);
        await redisPipeline([saveJob(job)]);
        if (step === "retry") break;
        if (step === "done") job.state = "done";
        continue;
      }
      break;
    }
    if (job.state === "done") {
      job.finishedAt = Date.now();
      await redisPipeline([saveJob(job), ["SREM", ACTIVE_KEY, id], ["DEL", rowsKey(id), mailKey(id)]]);
      await releaseBusy(job);
    }
    return job;
  } catch (error) {
    console.error("an import step failed", error);
    // Left as it was: the next step starts again from the last saved place.
    return job;
  } finally {
    await releaseLock(held);
  }
}

/**
 * The job's pass: every import with work left, oldest first, until the
 * deadline. Uploads given up halfway are cancelled here too.
 */
export async function advanceImports(deadline: number): Promise<{ worked: number; finished: number }> {
  const counts = { worked: 0, finished: 0 };
  if (!isRedisConfigured()) return counts;
  const [members] = await redisPipeline([["SMEMBERS", ACTIVE_KEY]]);
  const ids = (Array.isArray(members) ? members.map(String) : []).filter((id) => IMPORT_ID_PATTERN.test(id));
  const jobs = (await Promise.all(ids.map(readJob))).filter((job): job is ImportJob => job !== null).sort((a, b) => a.at - b.at);
  for (const id of ids) {
    if (!jobs.some((job) => job.id === id)) await redisPipeline([["SREM", ACTIVE_KEY, id]]);
  }
  for (const job of jobs) {
    if (Date.now() >= deadline) break;
    const after = await runImport(job.id, deadline);
    counts.worked += 1;
    if (after && finished(after.state)) counts.finished += 1;
  }
  return counts;
}

/** The rows that were not brought in, as a spreadsheet: row, column, what was wrong, what it held. */
export async function reportCsv(job: ImportJob): Promise<string> {
  const [rows] = await redisPipeline([["LRANGE", errorsKey(job.id), 0, MAX_REPORT_ROWS - 1]]);
  const lines = [csvLine(["row", "column", "problem", "value"])];
  for (const raw of Array.isArray(rows) ? rows : []) {
    try {
      const [line, column, problem, value] = JSON.parse(String(raw)) as [number, string, string, string];
      lines.push(csvLine([line, column, problem, value]));
    } catch {
      // A line that cannot be read is left out of the report, not the import.
    }
  }
  const missing = job.counts.errors + job.counts.skipped - (lines.length - 1);
  if (missing > 0) lines.push(csvLine(["", "", `And ${missing.toLocaleString("en-US")} more rows like these, not listed`, ""]));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}


/**
 * The one reminder to members who have not kept their membership yet,
 * a few days before it renews (lib/move-rules.ts, REMIND_DAYS_BEFORE): asked
 * of the creator's Stripe account first, so somebody who already kept it
 * hears nothing. Sent under the same limits as the first emails: the
 * company's day, the store's month (reserveMoved), and nothing to a store whose
 * moved addresses have bounced too often.
 */
export async function sendMoveReminders(deadline: number, now = Date.now()): Promise<{ sent: number; kept: number }> {
  const counts = { sent: 0, kept: 0 };
  if (!isRedisConfigured() || !isSenderConfigured()) return counts;
  for (const { sid, field } of await dueReminders(now)) {
    if (Date.now() >= deadline) {
      await remindLater(sid, field, now - 3_600 * 1000);
      continue;
    }
    try {
      const store = await storeForId(sid);
      if (!store?.statsId || !isPaidUp(store) || (await pausedFor(sid))) continue;
      const invite = await readInvite(store.statsId, field);
      if (!invite || invite.kept) continue;
      if (await keptAlready(store, invite.e, invite.p)) {
        await noteKept(store, invite.e, invite.p, now);
        counts.kept += 1;
        continue;
      }
      const letter = await reminderEmail(store, field, now);
      if (!letter) continue;
      if (!(await reserveDay(1))) {
        await remindLater(sid, field, now);
        continue;
      }
      if ((await reserveMoved(store, 1)) < 1) {
        await releaseDay(1);
        continue;
      }
      const sent = await sendBatch(
        [
          {
            from: `"${displayName(store.name)} via Marktmorgen" <${senderAddress()}>`,
            to: letter.to,
            subject: letter.subject,
            text: letter.text,
            html: `<div style="font-family:system-ui,sans-serif;line-height:1.5">${letter.text
              .split("\n\n")
              .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
              .join("")}</div>`,
            replyTo: store.email,
            tags: healthTags(store, false),
          },
        ],
        `nimbus-move-remind:${store.statsId}:${field}`, { by: "monthly" },
      );
      if (sent === "sent") {
        await noteSent(sid, 1);
        counts.sent += 1;
      } else if (sent === "retry") {
        await releaseMoved(store, 1);
        await releaseDay(1);
        await remindLater(sid, field, now);
      }
    } catch (error) {
      console.error("sending a moved member's reminder failed", error);
      await remindLater(sid, field, now);
    }
  }
  return counts;
}
