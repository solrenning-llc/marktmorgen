/**
 * 569 [NC1], unit 5 (second part): reading the paid invoices of the last 48
 * hours from Marktmorgen's own Stripe account, whole, for the daily charge
 * check (lib/charge-check.ts decides each one).
 *
 * Read from Stripe's pages on 30–31 Oct 2026 ("List all invoices": newest
 * first, `status=paid`, `created[gte]`, `limit` 1 to 100, `starting_after`,
 * the page's example sending `Stripe-Version: 2026-10-28.endive`; "The Invoice
 * object": `lines` is a list with `has_more` and its own `url`,
 * `/v1/invoices/<id>/lines`). See docs/billing-correctness.md, "Design of
 * units 5 and 6".
 *
 * Rules this file keeps:
 * - One fixed API version, CHARGE_CHECK_VERSION: the fields the decision
 *   reads moved in 2025, so nothing here reads the account's default shape.
 * - An invoice is handed on only when it was read WHOLE: every line, every
 *   page of lines. One whose lines could not be read is "unread", never
 *   handed on as if it had fewer lines, and never blocks the others.
 * - Bounded: a time budget (`until`, checked before every call), a cap on
 *   list pages and on line pages per invoice. Where it stopped is a cursor
 *   (the window it was reading and the last invoice id), so the next run
 *   carries on in the same window instead of starting over.
 * - A list page Stripe did not answer, or answered in a shape this file does
 *   not know, stops the run at the same cursor: nothing is guessed. After
 *   MAX_LIST_FAILURES runs in a row there, or once a window is
 *   CURSOR_MAX_AGE_SECONDS old, it is abandoned and reported (`abandoned`),
 *   so one bad page never holds every later run.
 * - Newest first: while a window is being resumed, invoices created after it
 *   began are above the cursor; the next fresh window starts no later than
 *   that window's first run (`readUpTo`), so they are read then. An invoice
 *   can be handed on more than once: the caller decides each invoice id once.
 *
 * Known limit, for the unit that calls it: windows filter on `created`, so
 * an invoice created more than 48 hours before it was paid (a renewal paid
 * on a late retry, for instance) is not in any window; the caller must also
 * read the invoices of the subscriptions it already holds (by
 * `subscription=`) or check by payment date. Not done here.
 *
 * It calls only the `get` it is handed, so it is tested against a fake
 * Stripe; `platformGet` is the real one. Nothing runs it yet: the cron and
 * the records it decides against come with the next units.
 */
import { onPlatformAt } from "@/lib/billing";

export const CHARGE_CHECK_VERSION = "2026-10-28.endive";

/** How far back each run looks: the item's 48 hours. */
export const WINDOW_SECONDS = 48 * 60 * 60;
/**
 * A window is resumed until it is this old; after that it is abandoned (and
 * the result says so), so a backlog can never hold every new charge back
 * forever. Measured from the window's first run (`ranAt`).
 */
export const CURSOR_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
/** How far our clock may be ahead of Stripe's: `readUpTo` is kept that much earlier. */
export const CLOCK_MARGIN_SECONDS = 5 * 60;
/** List errors in a row at one cursor before that window is abandoned, reported. */
export const MAX_LIST_FAILURES = 3;
/** Requests per run, whatever the clock says. */
export const MAX_CALLS = 300;
/** Invoices per list page (Stripe's maximum). */
export const PAGE_LIMIT = 100;
/** List pages per run. */
export const MAX_LIST_PAGES = 20;
/** Line pages per invoice (100 lines each) before it is set aside as unread. */
export const MAX_LINE_PAGES = 5;

export type ChargeReadCursor = {
  /** `created[gte]` of the window being read, in seconds. */
  windowStart: number;
  /** The last invoice id read in that window. */
  after: string;
  /** When this window was first read, in seconds: every invoice created before it is in the window. */
  ranAt: number;
  /** List errors in a row at this cursor. */
  failures?: number;
};

export type ChargeReadResult = {
  /** Paid invoices read whole, with every line in `lines.data`. */
  invoices: Record<string, unknown>[];
  /**
   * Paid invoices that could not be read whole. The list cursor moves past
   * them, so the caller must store these ids and try each again on a later
   * run with `readPaidInvoice`; they are never decided before.
   */
  unread: { id: string; reason: string }[];
  /** A window given up on (too old, or its list kept failing), to be reported; null otherwise. */
  abandoned: (ChargeReadCursor & { why: "too_old" | "list_failing" }) | null;
  /** Where to carry on next run; null when the window was read to its end. */
  cursor: ChargeReadCursor | null;
  /**
   * When the window was read to its end: every paid invoice created before
   * this time has been handed on or set aside as unread. The caller passes it
   * back as `readUpTo`, so the next fresh window starts no later than it and
   * nothing created while a window was being resumed falls between windows.
   * Also set when a window is abandoned (it is reported in `abandoned`).
   * Null otherwise: keep the one you had. Kept CLOCK_MARGIN_SECONDS earlier
   * than the window's first run.
   */
  readUpTo: number | null;
  /** A stretch the next window could not reach back to (older than CURSOR_MAX_AGE_SECONDS), to be reported; null otherwise. */
  gap: { from: number; to: number } | null;
  stopped: "done" | "budget" | "page_cap" | "call_cap" | "list_error";
  /** Requests made, for the run's own cap and report. */
  calls: number;
};

export type StripeGet = (path: string) => Promise<Record<string, unknown>>;

/** The real reader: our own account, at the pinned version. */
export const platformGet: StripeGet = (path) => onPlatformAt(CHARGE_CHECK_VERSION, "GET", path);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const INVOICE_ID = /^in_[A-Za-z0-9]+$/;

/** A Stripe list as the pages describe it, or null. */
function list(value: unknown): { data: unknown[]; hasMore: boolean } | null {
  const v = record(value);
  if (!v || v.object !== "list" || !Array.isArray(v.data) || typeof v.has_more !== "boolean") return null;
  return { data: v.data, hasMore: v.has_more };
}

function lineId(line: unknown): string | null {
  const id = record(line)?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Every line of one invoice, or the reason it could not be read whole.
 * The lines already in the invoice are the first page.
 */
async function wholeLines(
  invoice: Record<string, unknown>,
  id: string,
  get: StripeGet,
  hasTime: () => boolean,
  count: () => void,
): Promise<{ lines: unknown[] } | { reason: string }> {
  const first = list(invoice.lines);
  if (!first) return { reason: "lines_unreadable" };
  const lines = [...first.data];
  if (!first.hasMore) return { lines };
  const url = record(invoice.lines)?.url;
  if (url !== `/v1/invoices/${id}/lines`) return { reason: "lines_url_unexpected" };
  let more = true;
  for (let page = 0; more; page++) {
    if (page >= MAX_LINE_PAGES) return { reason: "too_many_lines" };
    if (!hasTime()) return { reason: "budget" };
    const last = lineId(lines[lines.length - 1]);
    if (!last) return { reason: "line_without_id" };
    let next: { data: unknown[]; hasMore: boolean } | null;
    try {
      count();
      next = list(await get(`/invoices/${id}/lines?${new URLSearchParams({ limit: String(PAGE_LIMIT), starting_after: last })}`));
    } catch {
      return { reason: "lines_not_answered" };
    }
    if (!next) return { reason: "lines_unreadable" };
    if (next.hasMore && next.data.length === 0) return { reason: "lines_unreadable" };
    lines.push(...next.data);
    more = next.hasMore;
  }
  return { lines };
}

/**
 * Reads the paid invoices of the window, newest first, from where the last
 * run stopped. `now` in seconds; `until` is the time (ms, Date.now() scale)
 * after which no further request is started; `clock` defaults to Date.now.
 */
export async function readPaidInvoices(options: {
  get: StripeGet;
  now: number;
  until: number;
  cursor?: ChargeReadCursor | null;
  /** The `readUpTo` of the last window read to its end, if any. */
  readUpTo?: number | null;
  clock?: () => number;
}): Promise<ChargeReadResult> {
  const { get, now, until } = options;
  const clock = options.clock ?? Date.now;
  const given = options.cursor;
  const wellFormed =
    !!given && Number.isSafeInteger(given.windowStart) && Number.isSafeInteger(given.ranAt) && INVOICE_ID.test(given.after);
  const failures = wellFormed && Number.isSafeInteger(given!.failures) ? Math.max(0, given!.failures!) : 0;
  let abandoned: ChargeReadResult["abandoned"] = null;
  const base = wellFormed ? { windowStart: given!.windowStart, after: given!.after, ranAt: given!.ranAt } : null;
  if (base && now - base.ranAt >= CURSOR_MAX_AGE_SECONDS) {
    abandoned = { ...base, why: "too_old" };
  } else if (base && failures >= MAX_LIST_FAILURES) {
    abandoned = { ...base, why: "list_failing" };
  }
  const resume = base && !abandoned ? base : null;
  // A fresh window reaches back to the last time everything was read, but
  // never further than CURSOR_MAX_AGE_SECONDS; what is older is reported.
  const floor = now - CURSOR_MAX_AGE_SECONDS;
  const upTo = Number.isSafeInteger(options.readUpTo) ? (options.readUpTo as number) : null;
  let gap: ChargeReadResult["gap"] = null;
  let freshStart = now - WINDOW_SECONDS;
  if (!resume && upTo !== null && upTo < freshStart) {
    freshStart = Math.max(upTo, floor);
    if (upTo < floor) gap = { from: upTo, to: floor };
  }
  const windowStart = resume ? resume.windowStart : freshStart;
  const ranAt = resume ? resume.ranAt : now;
  let after = resume ? resume.after : null;

  // An abandoned window is reported, so it counts as read up to its first
  // run: a page that keeps failing is not reached again by every later window.
  const out: ChargeReadResult = {
    invoices: [],
    unread: [],
    abandoned,
    cursor: resume,
    readUpTo: abandoned ? abandoned.ranAt - CLOCK_MARGIN_SECONDS : null,
    gap,
    stopped: "done",
    calls: 0,
  };
  const hasTime = () => out.calls < MAX_CALLS && clock() < until;
  const why = () => (out.calls >= MAX_CALLS ? "call_cap" : "budget");
  const count = () => {
    out.calls += 1;
  };

  for (let page = 0; ; page++) {
    if (page >= MAX_LIST_PAGES) {
      out.stopped = "page_cap";
      return out;
    }
    if (!hasTime()) {
      out.stopped = why();
      return out;
    }
    const query = new URLSearchParams({ status: "paid", "created[gte]": String(windowStart), limit: String(PAGE_LIMIT) });
    if (after) query.set("starting_after", after);
    let got: { data: unknown[]; hasMore: boolean } | null;
    try {
      count();
      got = list(await get(`/invoices?${query}`));
    } catch {
      return listError(out, windowStart, ranAt, after, failures);
    }
    if (!got || (got.hasMore && got.data.length === 0)) {
      return listError(out, windowStart, ranAt, after, failures);
    }
    for (const item of got.data) {
      const invoice = record(item);
      const id = invoice?.id;
      if (!invoice || typeof id !== "string" || !INVOICE_ID.test(id)) {
        // An entry with no id cannot be resumed after or decided: the page is
        // not what the pages describe, so nothing after it is taken.
        return listError(out, windowStart, ranAt, after, failures);
      }
      if (invoice.status !== "paid") {
        out.unread.push({ id, reason: "not_paid" });
      } else {
        const read = await wholeLines(invoice, id, get, hasTime, count);
        if ("reason" in read) {
          if (read.reason === "budget") {
            // Out of time on this invoice: carry on from just before it.
            out.stopped = why();
            return out;
          }
          out.unread.push({ id, reason: read.reason });
        } else {
          out.invoices.push({ ...invoice, lines: { ...record(invoice.lines), data: read.lines, has_more: false } });
        }
      }
      after = id;
      out.cursor = { windowStart, after, ranAt };
    }
    if (!got.hasMore) {
      out.cursor = null;
      out.readUpTo = ranAt - CLOCK_MARGIN_SECONDS;
      out.stopped = "done";
      return out;
    }
  }
}

/**
 * A list page Stripe did not answer, or answered in a shape not on its page:
 * the run stops where it was, and the cursor counts the failure, so a page
 * that keeps failing is given up after MAX_LIST_FAILURES runs (reported)
 * instead of holding every run at the same place.
 */
function listError(out: ChargeReadResult, windowStart: number, ranAt: number, after: string | null, failures: number): ChargeReadResult {
  out.stopped = "list_error";
  // A failure on a fresh window's first page leaves nothing to resume: the
  // next run starts the window again. Invoices read earlier in this run moved
  // the cursor, so the count starts again from there.
  const progressed = out.invoices.length + out.unread.length > 0;
  out.cursor = after ? { windowStart, after, ranAt, failures: progressed ? 1 : failures + 1 } : null;
  return out;
}

/**
 * One paid invoice by id, whole, for an id a run set aside as unread
 * (`GET /v1/invoices/<id>`, then its lines as above). `final` says the id can
 * never be read as a paid invoice of ours (not found, not paid, another id):
 * the caller reports it and stops trying. Otherwise it is tried on a later
 * run and never decided before. `maxCalls` is what is left of the run's own
 * MAX_CALLS, so retries share the run's cap.
 */
export async function readPaidInvoice(options: {
  get: StripeGet;
  id: string;
  until: number;
  maxCalls: number;
  clock?: () => number;
}): Promise<{ invoice: Record<string, unknown>; calls: number } | { reason: string; final: boolean; calls: number }> {
  const { get, id, until } = options;
  if (!INVOICE_ID.test(id)) return { reason: "bad_id", final: true, calls: 0 };
  const clock = options.clock ?? Date.now;
  let calls = 0;
  const cap = Math.max(0, Math.min(options.maxCalls, MAX_LINE_PAGES + 1));
  const hasTime = () => calls < cap && clock() < until;
  if (!hasTime()) return { reason: "budget", final: false, calls };
  let invoice: Record<string, unknown> | null;
  try {
    calls += 1;
    invoice = record(await get(`/invoices/${id}`));
  } catch (error) {
    const status = (error as { status?: unknown } | null | undefined)?.status;
    return status === 404 ? { reason: "not_found", final: true, calls } : { reason: "not_answered", final: false, calls };
  }
  if (!invoice) return { reason: "unexpected", final: false, calls };
  if (invoice.id !== id) return { reason: "another_invoice", final: true, calls };
  if (invoice.status !== "paid") return { reason: "not_paid", final: true, calls };
  const read = await wholeLines(invoice, id, get, hasTime, () => {
    calls += 1;
  });
  if ("reason" in read) return { reason: read.reason, final: read.reason === "too_many_lines", calls };
  return { invoice: { ...invoice, lines: { ...record(invoice.lines), data: read.lines, has_more: false } }, calls };
}
