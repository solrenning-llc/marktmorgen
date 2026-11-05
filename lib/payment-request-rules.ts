/**
 * Payment requests and invoices (HighLevel audit H26, H27; added 18 October
 * 2026): the rules, browser-safe.
 *
 * A creator asks one person they already deal with (a coaching client, a
 * brand, a student who paid half) to pay a custom amount: one or more lines
 * of what it is for, an optional due date, and an email with a link. The
 * buyer opens a page of the store's that says who is asking, for what and
 * how much, and pays on Stripe's page on the creator's own Stripe account,
 * through the same checkout every sale here goes through
 * (lib/payment-requests.ts): the plan's share of the sale, the month's
 * order figure, sales tax and Stripe's invoice where the creator switched
 * them on, refunds and disputes on the creator's Stripe as for any sale.
 *
 * What it is not, on purpose:
 *
 *   - no late fee, no interest and nothing added for paying by link: the
 *     buyer pays the lines they were shown (and sales tax where the creator
 *     collects it), and the page says so;
 *   - no countdown and no "last chance": a due date is said as a date, and
 *     the link simply stops working when the request expires;
 *   - no reminder after the request is paid, withdrawn or expired, at most
 *     MAX_SENDS emails in all for one request, never two within a day, and
 *     each one taken from the store's own emails for the month
 *     (lib/store-allowance-rules.ts, "email") before it goes;
 *   - not marketing: it goes only to someone the creator says agreed to pay
 *     them for what it lists, and it adds nobody to any list.
 *
 * Every figure is enforced in code: open requests and requests kept per
 * store (REQUEST_LIMITS, by plan), requests kept per person
 * (MAX_PER_PERSON), the amount (a product's own price bounds,
 * lib/money.ts), the lines, the words and the days.
 */
import { type Currency, currencyRule, readMoney } from "@/lib/money";
import type { Tier } from "@/lib/plan";
import { type PlanFields, type Standing, standingOf } from "@/lib/plan-standing";

export type RequestLine = {
  /** What it is for, in the creator's words. */
  text: string;
  quantity: number;
  /** Each, in the store currency's smallest unit. */
  cents: number;
};

/** What a request is, as kept. "expired" is not kept: it is an open request whose time ran out (statusOf). */
export type RequestState = "open" | "paid" | "canceled" | "refunded";
export type RequestStatus = RequestState | "expired";

export type PaymentRequest = {
  /** 32 hex characters: the request's name, and the secret in its link. */
  id: string;
  /** The store's id (lib/store.ts sid). */
  sid: string;
  email: string;
  /** The buyer's name, as the creator typed it; "" for none. */
  name: string;
  lines: RequestLine[];
  /** A note under the lines; "" for none. */
  note: string;
  currency: Currency;
  /** The lines' total, before any sales tax Stripe adds. */
  total: number;
  createdAt: number;
  /** "2026-10-31", or "" for no due date. Said as a date, nothing more. */
  dueDate: string;
  /** When its link stops taking payment, in milliseconds. */
  expiresAt: number;
  state: RequestState;
  /** Reminders the creator asked to be sent by themselves, 0 to MAX_AUTO_REMINDERS. */
  autoReminders: number;
  /** When the request and each reminder were emailed, in milliseconds; the first is the request itself. */
  sent: number[];
  /** Why the last email did not go ("" when it did). */
  failed: string;
  /** The last checkout opened for it on Stripe, so a second one is never opened beside it. */
  session: string;
  sessionAt: number;
  paidAt: number;
  /** What Stripe took, tax included. */
  amountPaid: number;
  /** The payment on the creator's Stripe (pi_…). */
  payment: string;
  /** What was refunded of it, as Stripe says. */
  refunded: number;
  closedAt: number;
  /**
   * Paid outside Stripe, as the creator marked it (639 [GL7](30)): how, and
   * a note of theirs. Absent for every request paid through its checkout.
   */
  outside?: { method: OutsideMethod; note: string };
};

/** How a request was paid outside Stripe. */
export type OutsideMethod = "cash" | "transfer" | "other";
export const OUTSIDE_METHODS: readonly OutsideMethod[] = ["cash", "transfer", "other"];
export const MAX_OUTSIDE_NOTE = 200;
/** How each is said in the studio, in US English. */
export const OUTSIDE_WORDS: Record<OutsideMethod, string> = { cash: "Cash", transfer: "Bank transfer", other: "Another way" };

/** A mark of payment outside Stripe as sent or kept, or null when it does not read whole. */
export function readOutside(raw: unknown): { method: OutsideMethod; note: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const method = OUTSIDE_METHODS.find((m) => m === v.method);
  if (!method) return null;
  const note = typeof v.note === "string" ? v.note.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_OUTSIDE_NOTE) : "";
  return { method, note };
}

/** Open requests a store may have at once, and requests it keeps in all (open or not), by plan. */
export const REQUEST_LIMITS: Record<Tier, { open: number; kept: number }> = {
  creator: { open: 20, kept: 200 },
  pro: { open: 100, kept: 1_000 },
  scale: { open: 300, kept: 3_000 },
};

/** The same for a store that pays nothing: a free trial may try it; no plan or an ended one cannot take money at all. */
export const NON_PAYING_REQUEST_LIMITS: Record<Exclude<Standing, "paid">, { open: number; kept: number }> = {
  trial: { open: 5, kept: 20 },
  none: { open: 0, kept: 0 },
  ended: { open: 0, kept: 0 },
};

/** Requests kept for one person in one store at a time: a year of monthly invoices and more. */
export const MAX_PER_PERSON = 24;
export const MAX_LINES = 10;
export const MAX_LINE_TEXT = 120;
export const MAX_QUANTITY = 100;
export const MAX_NOTE = 1_000;
export const MAX_NAME = 80;
/** How long a request's link takes payment. */
export const OPEN_DAYS = 45;
/** How long a request is kept for the creator's list, from the day it was made; the payment itself stays on their Stripe. */
export const KEEP_DAYS = 400;
/** Reminders a request may send by itself. */
export const MAX_AUTO_REMINDERS = 3;
/** Days between the request and each reminder sent by itself. */
export const REMIND_EVERY_DAYS = 7;
/** Emails one request may send in all: the request and three more, whether sent by hand or by themselves. */
export const MAX_SENDS = 1 + MAX_AUTO_REMINDERS;
/** The least time between two emails about the same request. */
export const MIN_HOURS_BETWEEN_SENDS = 24;

const DAY = 86_400_000;
export const ID_PATTERN = /^[0-9a-f]{32}$/;
const EMAIL = /^[^\s@<>()",;:]{1,64}@[^\s@<>()",;:]{1,190}\.[^\s@<>()",;:]{2,63}$/;

/** What a store's plan gives it, now. */
export function requestLimitsFor(store: PlanFields & { tier?: Tier }, nowSeconds = Date.now() / 1000): { open: number; kept: number } {
  const standing = standingOf(store, nowSeconds);
  if (standing === "paid") return REQUEST_LIMITS[store.tier ?? "creator"] ?? REQUEST_LIMITS.creator;
  return NON_PAYING_REQUEST_LIMITS[standing];
}

/** Where a request stands now: an open one whose time ran out has expired. */
export function statusOf(request: Pick<PaymentRequest, "state" | "expiresAt">, now = Date.now()): RequestStatus {
  if (request.state !== "open") return request.state;
  return now >= request.expiresAt ? "expired" : "open";
}

/** The lines' total, or null when it is not a whole number of cents. */
export function linesTotal(lines: RequestLine[]): number | null {
  let total = 0;
  for (const line of lines) total += line.cents * line.quantity;
  return Number.isSafeInteger(total) ? total : null;
}

/** The least and the most one request may ask for: a product's own price bounds in that currency (lib/money.ts). */
export function requestBounds(currency: Currency): { min: number; max: number } {
  const rule = currencyRule(currency);
  return { min: rule.minPrice, max: rule.maxPrice };
}

export function totalInRange(total: number, currency: Currency): boolean {
  const { min, max } = requestBounds(currency);
  return Number.isSafeInteger(total) && total >= min && total <= max;
}

/** "2026-10-31" as a real day, or null. */
export function readDay(raw: unknown): string | null {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const at = Date.parse(`${raw}T00:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === raw ? raw : null;
}

/** The days a due date may be: from today to the last day the link takes payment (UTC). */
export function dueRange(now = Date.now()): { first: string; last: string } {
  return { first: new Date(now).toISOString().slice(0, 10), last: new Date(now + OPEN_DAYS * DAY).toISOString().slice(0, 10) };
}

const clean = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");

export type RequestDraft = Pick<PaymentRequest, "email" | "name" | "lines" | "note" | "dueDate" | "autoReminders" | "total">;

export type DraftProblem = "email" | "name" | "lines" | "line" | "amount" | "total" | "note" | "due" | "reminders" | "consent";

/** Words for each problem, for the studio. */
export const DRAFT_PROBLEMS: Record<DraftProblem, string> = {
  email: "Type the email address of the person who is paying.",
  name: `Keep the name within ${MAX_NAME} characters.`,
  lines: `Add at least one line, and no more than ${MAX_LINES}.`,
  line: `Each line needs what it is for (up to ${MAX_LINE_TEXT} characters) and a quantity from 1 to ${MAX_QUANTITY}.`,
  amount: "Type each line's amount as a plain number, like 120 or 120.50.",
  total: "The total is outside what one request may ask for in your store's currency.",
  note: `Keep the note within ${MAX_NOTE} characters.`,
  due: `Choose a due date from today to ${OPEN_DAYS} days from now, or none.`,
  reminders: `Choose from 0 to ${MAX_AUTO_REMINDERS} reminders.`,
  consent: "Check the box to confirm this person agreed to pay you for this.",
};

/**
 * What the studio sent, read and held to every rule here: the address, the
 * name, up to MAX_LINES lines (what each is for, how many, each amount as
 * typed: "120", "120.50" or "120,50"), the note, the due date, the
 * reminders and the creator's word that this person agreed to pay for it.
 */
export function readDraft(body: Record<string, unknown>, currency: Currency, now = Date.now()): { ok: true; draft: RequestDraft } | { ok: false; problem: DraftProblem; line?: number } {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL.test(email) || email.length > 254) return { ok: false, problem: "email" };
  if (typeof body.name === "string" && body.name.trim().length > MAX_NAME) return { ok: false, problem: "name" };
  const name = clean(body.name, MAX_NAME);
  const raw = Array.isArray(body.lines) ? body.lines : [];
  if (raw.length < 1 || raw.length > MAX_LINES) return { ok: false, problem: "lines" };
  const lines: RequestLine[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const row = raw[i] && typeof raw[i] === "object" ? (raw[i] as Record<string, unknown>) : {};
    const text = clean(row.text, MAX_LINE_TEXT + 1);
    const quantity = typeof row.quantity === "number" ? row.quantity : Number(typeof row.quantity === "string" ? row.quantity.trim() : NaN);
    if (!text || text.length > MAX_LINE_TEXT || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) return { ok: false, problem: "line", line: i };
    const typed = typeof row.amount === "string" ? row.amount.trim().replace(/^(\d+),(\d{1,2})$/, "$1.$2") : "";
    const cents = readMoney(typed, currency);
    if (cents === null || cents < 1 || cents > currencyRule(currency).maxPrice) return { ok: false, problem: "amount", line: i };
    lines.push({ text, quantity, cents });
  }
  const total = linesTotal(lines);
  if (total === null || !totalInRange(total, currency)) return { ok: false, problem: "total" };
  if (typeof body.note === "string" && body.note.trim().length > MAX_NOTE) return { ok: false, problem: "note" };
  const note = typeof body.note === "string" ? body.note.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_NOTE) : "";
  let dueDate = "";
  if (typeof body.dueDate === "string" && body.dueDate) {
    const day = readDay(body.dueDate);
    const { first, last } = dueRange(now);
    if (!day || day < first || day > last) return { ok: false, problem: "due" };
    dueDate = day;
  }
  const autoReminders = typeof body.autoReminders === "number" ? body.autoReminders : Number(body.autoReminders ?? 0);
  if (!Number.isSafeInteger(autoReminders) || autoReminders < 0 || autoReminders > MAX_AUTO_REMINDERS) return { ok: false, problem: "reminders" };
  if (body.consent !== true) return { ok: false, problem: "consent" };
  return { ok: true, draft: { email, name, lines, note, dueDate, autoReminders, total } };
}

/**
 * When the next reminder sent by itself is due, or null for none: the k-th
 * is REMIND_EVERY_DAYS × k after the request was first sent, only while it
 * is open, before it expires, within MAX_SENDS and at least
 * MIN_HOURS_BETWEEN_SENDS after the last email about it.
 */
export function nextReminderAt(request: Pick<PaymentRequest, "state" | "expiresAt" | "autoReminders" | "sent">, now = Date.now()): number | null {
  if (statusOf(request, now) !== "open" || request.sent.length === 0 || request.sent.length >= MAX_SENDS) return null;
  // Reminders already sent, by hand or by themselves, count toward the ones asked for.
  const done = request.sent.length - 1;
  if (done >= request.autoReminders) return null;
  const planned = request.sent[0] + (done + 1) * REMIND_EVERY_DAYS * DAY;
  const at = Math.max(planned, request.sent[request.sent.length - 1] + MIN_HOURS_BETWEEN_SENDS * 3_600_000);
  return at < request.expiresAt ? at : null;
}

/** Whether the creator may send one more email about it by hand now, and if not, why. */
export function canSendAgain(request: Pick<PaymentRequest, "state" | "expiresAt" | "sent">, now = Date.now()): { ok: true } | { ok: false; why: string } {
  if (statusOf(request, now) !== "open") return { ok: false, why: "Only an open request can be sent again." };
  if (request.sent.length >= MAX_SENDS) return { ok: false, why: `A request is emailed at most ${MAX_SENDS} times, reminders included.` };
  const last = request.sent[request.sent.length - 1] ?? 0;
  if (now - last < MIN_HOURS_BETWEEN_SENDS * 3_600_000) return { ok: false, why: `The last email about it went less than ${MIN_HOURS_BETWEEN_SENDS} hours ago.` };
  return { ok: true };
}

/** "Open", "Paid"…: what the studio calls each status. */
export const STATUS_WORDS: Record<RequestStatus, string> = {
  open: "Open",
  paid: "Paid",
  canceled: "Canceled",
  expired: "Expired",
  refunded: "Refunded",
};

/** Whatever came back from storage, made safe to use; null when it is not a request. */
export function parseRequest(raw: unknown): PaymentRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const str = (x: unknown, max = 300) => (typeof x === "string" ? x.slice(0, max) : "");
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  if (typeof v.id !== "string" || !ID_PATTERN.test(v.id) || typeof v.sid !== "string" || !v.sid) return null;
  const lines = Array.isArray(v.lines)
    ? v.lines.flatMap((l): RequestLine[] => {
        const row = l && typeof l === "object" ? (l as Record<string, unknown>) : null;
        return row && typeof row.text === "string" && Number.isSafeInteger(row.quantity) && Number.isSafeInteger(row.cents)
          ? [{ text: row.text.slice(0, MAX_LINE_TEXT), quantity: row.quantity as number, cents: row.cents as number }]
          : [];
      }).slice(0, MAX_LINES)
    : [];
  const state = v.state === "paid" || v.state === "canceled" || v.state === "refunded" ? v.state : "open";
  return {
    id: v.id,
    sid: str(v.sid, 64),
    email: str(v.email, 254),
    name: str(v.name, MAX_NAME),
    lines,
    note: str(v.note, MAX_NOTE),
    currency: str(v.currency, 3) as Currency,
    total: num(v.total),
    createdAt: num(v.createdAt),
    dueDate: readDay(v.dueDate) ?? "",
    expiresAt: num(v.expiresAt),
    state,
    autoReminders: Math.min(MAX_AUTO_REMINDERS, Math.max(0, Math.floor(num(v.autoReminders)))),
    sent: Array.isArray(v.sent) ? v.sent.filter((t): t is number => typeof t === "number" && Number.isFinite(t)).slice(0, MAX_SENDS) : [],
    failed: str(v.failed, 200),
    session: str(v.session, 255),
    sessionAt: num(v.sessionAt),
    paidAt: num(v.paidAt),
    amountPaid: num(v.amountPaid),
    payment: str(v.payment, 255),
    refunded: num(v.refunded),
    closedAt: num(v.closedAt),
    ...(() => {
      // Only a paid request carries it.
      const outside = state === "paid" ? readOutside(v.outside) : null;
      return outside ? { outside } : {};
    })(),
  };
}

/** A new request's id: 128 random bits, which is also what keeps its link private. */
export function newRequestId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
