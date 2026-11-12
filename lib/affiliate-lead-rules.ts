/**
 * Pay per lead (added 18 October 2026; HighLevel audit H29): the terms a
 * creator sets for a fixed commission on each confirmed lead an affiliate
 * brings, and how each lead stands, worked out from what was recorded.
 *
 * Kept apart from lib/affiliate-leads.ts, which writes and reads the leads,
 * so the store record, the studio and the affiliate's page can know the terms
 * and a lead's status without importing anything that talks to Redis.
 *
 * What counts as a lead is the creator's choice, one of three, each confirmed
 * before it is recorded at all:
 *
 *   "signup"   an address that joined the creator's list by pressing the
 *              button in the email it was sent (double opt-in), and was not
 *              on the list before;
 *   "free"     a free product claimed from the emailed link, the first time
 *              that address got that product;
 *   "booking"  a call booked and paid for, which only counts once the call's
 *              time has passed, it was not refunded, and the creator says it
 *              took place.
 *
 * The money is the creator's, paid by the creator, exactly as a sale's
 * commission is (lib/affiliates.ts). What stops it being gamed:
 *
 *   - one lead per person per program: an address, written however it is
 *     written (lib/affiliates.ts canonicalEmail), is a lead once, ever;
 *   - nobody is their own lead, and the creator is nobody's;
 *   - confirmation first: nothing is recorded for an address that never
 *     pressed its emailed button, or a call that never happened;
 *   - velocity: only so many leads earn per affiliate per UTC day, and an
 *     hour holds a quarter of that; past them a lead is recorded and shown,
 *     and earns nothing;
 *   - a monthly budget for the whole program, which no lead passes;
 *   - a hold of at least MIN_LEAD_HOLD_DAYS, and then the creator's approval,
 *     before a lead can be paid; the creator can reverse any lead as not
 *     genuine, and the affiliate sees that, with the reason (one already paid
 *     then comes off what is owed, as a refunded sale does).
 *
 * Each lead is judged by the terms in force when it was confirmed (its own
 * amount, hold, daily cap and the month's budget then), so changing them later
 * rewrites nobody's lead, as changing a share never reaches back into a sale.
 */

/**
 * Where a program's leads are kept, under the store's own stats id so they
 * move with the store (lib/affiliate-leads.ts writes it, lib/affiliates.ts
 * reads it into the book): lead id -> the lead. The id is a one-way
 * fingerprint of the person's address in this program, which is what makes a
 * person one lead, ever.
 */
export const leadsKey = (statsId: string) => `nl:aff:${statsId}:leads`;

export type LeadKind = "signup" | "free" | "booking";
export const LEAD_KINDS: readonly LeadKind[] = ["signup", "free", "booking"];

export type LeadSetting = {
  /** What counts as a lead; "none" pays no lead commission, which is every program before this. */
  kind: LeadKind | "none";
  /** The fixed commission on each lead, in the store's currency's smallest unit. */
  cents: number;
  /** Days after it is confirmed (a booking: after its call) before a lead can be approved. */
  hold: number;
  /** Leads that earn per affiliate per UTC day; an hour holds a quarter of it (hourlyLeads). */
  daily: number;
  /** The most all leads of one UTC calendar month earn together, in the smallest unit. */
  budget: number;
};

/** 0.50 to 100.00 in the store's currency. */
export const MIN_LEAD_CENTS = 50;
export const MAX_LEAD_CENTS = 10_000;
/** A lead waits at least a week, so a fake one has time to show. */
export const MIN_LEAD_HOLD_DAYS = 7;
export const MAX_LEAD_HOLD_DAYS = 90;
/** Leads that may earn per affiliate in one UTC day, at the most a creator may set. */
export const MAX_LEAD_CAP = 500;
/** 5.00 to 100,000.00 a month. */
export const MIN_LEAD_BUDGET_CENTS = 500;
export const MAX_LEAD_BUDGET_CENTS = 10_000_000;

export const NO_LEADS: LeadSetting = { kind: "none", cents: 500, hold: 30, daily: 10, budget: 50_000 };

const whole = (value: unknown, min: number, max: number): number | null => {
  const n = typeof value === "string" && value.trim() ? Number(value.trim()) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max ? n : null;
};

/** The terms as kept, made safe to use; anything unreadable is none, with the defaults. */
export function parseLeadSetting(raw: unknown): LeadSetting {
  if (!raw || typeof raw !== "object") return { ...NO_LEADS };
  const value = raw as Record<string, unknown>;
  const kind = (LEAD_KINDS as readonly string[]).includes(String(value.kind)) ? (value.kind as LeadKind) : "none";
  const cents = whole(value.cents, MIN_LEAD_CENTS, MAX_LEAD_CENTS) ?? NO_LEADS.cents;
  const budget = whole(value.budget, MIN_LEAD_BUDGET_CENTS, MAX_LEAD_BUDGET_CENTS) ?? NO_LEADS.budget;
  return {
    kind,
    cents,
    hold: whole(value.hold, MIN_LEAD_HOLD_DAYS, MAX_LEAD_HOLD_DAYS) ?? NO_LEADS.hold,
    daily: whole(value.daily, 1, MAX_LEAD_CAP) ?? NO_LEADS.daily,
    // Never a month too small for one lead.
    budget: Math.max(budget, cents),
  };
}

/** Why terms sent from the studio are refused, or null: out-of-range numbers are never quietly replaced. */
export function leadProblem(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== "object") return "lead_kind";
  const value = raw as Record<string, unknown>;
  if (value.kind !== "none" && !(LEAD_KINDS as readonly string[]).includes(String(value.kind))) return "lead_kind";
  if (whole(value.cents, MIN_LEAD_CENTS, MAX_LEAD_CENTS) === null) return "lead_amount";
  if (whole(value.hold, MIN_LEAD_HOLD_DAYS, MAX_LEAD_HOLD_DAYS) === null) return "lead_hold";
  if (whole(value.daily, 1, MAX_LEAD_CAP) === null) return "lead_daily";
  const budget = whole(value.budget, MIN_LEAD_BUDGET_CENTS, MAX_LEAD_BUDGET_CENTS);
  if (budget === null || budget < Number(value.cents)) return "lead_budget";
  return null;
}

/** Leads that may earn per affiliate in one UTC hour: a quarter of the day's, at least one. */
export function hourlyLeads(daily: number): number {
  return Math.max(1, Math.ceil(daily / 4));
}

/** A reason the creator gives for reversing a lead, which the affiliate sees. */
export type LeadReason = "fake" | "duplicate" | "no-show" | "other";
export const LEAD_REASONS: readonly LeadReason[] = ["fake", "duplicate", "no-show", "other"];

/** One lead as it is kept (lib/affiliate-leads.ts). Times in seconds. */
export type LeadRecord = {
  /** The person's one-way fingerprint in this program (lib/affiliate-leads.ts leadId): one lead per person. */
  id: string;
  aff: string;
  kind: LeadKind;
  /** When it was confirmed: the button pressed, the free product taken, the call booked. */
  at: number;
  /** A booking's call's end as booked, in seconds; 0 otherwise. A move is read when the lead is shown. */
  end: number;
  /** A booking's checkout session, or the free product's id. */
  ref: string;
  /** A booking's payment, which is what a refund is made against. */
  pi: string;
  /** What a booking paid in all, so a refund in full reverses it. */
  paid: number;
  /** The product's name for a free product or a call; empty for a sign-up. */
  title: string;
  /** The person's address, for the creator to check; empty once they asked to be deleted. */
  email: string;
  /** The terms when it was confirmed. */
  cents: number;
  currency: string;
  hold: number;
  daily: number;
  budget: number;
  /** "open" until the creator approves or reverses it. */
  state: "open" | "approved" | "reversed";
  /** When the creator decided, in seconds; 0 while open. */
  d: number;
  /** Why it was reversed; empty otherwise. */
  why: LeadReason | "";
};

export type LeadStatus =
  | "waiting for the call"
  | "in hold"
  | "needs approval"
  | "approved"
  | "not genuine"
  | "refunded"
  | "over daily cap"
  | "over hourly limit"
  | "over monthly budget";

/** The statuses that earn the lead's amount; only "approved" can be paid. */
export const EARNING_LEAD: readonly LeadStatus[] = ["waiting for the call", "in hold", "needs approval", "approved"];

export type SettledLead = {
  lead: LeadRecord;
  status: LeadStatus;
  /** What it earns now, in the smallest unit: its amount, or 0. */
  commission: number;
  /** When it can be approved, in seconds: the hold counted from confirmation, or from a call's end. */
  readyAt: number;
};

function readCurrency(raw: unknown): string {
  return typeof raw === "string" && /^[a-z]{3}$/.test(raw) ? raw : "usd";
}

/** A kept lead, or null when it does not read. */
export function parseLead(raw: unknown): LeadRecord | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Partial<LeadRecord>;
    if (typeof v.id !== "string" || !/^[0-9a-f]{16,40}$/.test(v.id)) return null;
    if (typeof v.aff !== "string" || !/^[0-9a-f]{12}$/.test(v.aff)) return null;
    if (!(LEAD_KINDS as readonly string[]).includes(String(v.kind))) return null;
    const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);
    const s = (x: unknown, max: number) => (typeof x === "string" ? x.slice(0, max) : "");
    return {
      id: v.id,
      aff: v.aff,
      kind: v.kind as LeadKind,
      at: n(v.at),
      end: n(v.end),
      ref: s(v.ref, 220),
      pi: s(v.pi, 120),
      paid: n(v.paid),
      title: s(v.title, 200),
      email: s(v.email, 254),
      cents: n(v.cents),
      currency: readCurrency(v.currency),
      hold: n(v.hold),
      daily: Math.max(1, n(v.daily)),
      budget: n(v.budget),
      state: v.state === "approved" || v.state === "reversed" ? v.state : "open",
      d: n(v.d),
      why: (LEAD_REASONS as readonly string[]).includes(String(v.why)) ? (v.why as LeadReason) : "",
    };
  } catch {
    return null;
  }
}

/**
 * A kept lead read exactly, or null (CX-123 rule 24): every field in the type recordLead and decideLeads write it
 * with, so nothing that settles the caps, the budget or a booking's readiness (its time, amount, currency, terms,
 * state, call's end, payment) and nothing a person's copy reads (the address) is ever filled in with a default.
 * parseLead fills a field of another type with 0, "usd" or "open", which can take a lead out of the month's budget
 * or the day's cap; it is what the book shows, never what a decision, a credit or a deletion is made from.
 */
export function parseLeadExact(raw: unknown): LeadRecord | null {
  const lead = parseLead(raw);
  if (!lead) return null;
  // parseLead read it as a JSON object with its id, affiliate and kind: what is left is every other field's type.
  const v = JSON.parse(raw as string) as Record<string, unknown>;
  const whole = (x: unknown) => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
  if (!(["at", "end", "paid", "cents", "hold", "daily", "budget", "d"] as const).every((k) => whole(v[k]))) return null;
  if (!(["ref", "pi", "title", "email"] as const).every((k) => typeof v[k] === "string")) return null;
  if (typeof v.currency !== "string" || !/^[a-z]{3}$/.test(v.currency)) return null;
  if (v.state !== "open" && v.state !== "approved" && v.state !== "reversed") return null;
  if (v.why !== "" && !(LEAD_REASONS as readonly unknown[]).includes(v.why)) return null;
  return lead;
}

/**
 * Every lead as it stands now, in the order they were confirmed.
 *
 * `refunded` is what Stripe says was given back on a payment (bookings only);
 * `ends` is a booking's call's end, in seconds, where its buyer moved it.
 * Leads are taken in the order they came (ties by id), and each one that is
 * not reversed or refunded uses a place of its affiliate's day and hour and
 * its amount of the month's budget, judged by the cap and budget of its own
 * day. A lead past either is shown and earns nothing; a lead reversed later
 * frees its place, and a lead already approved keeps what it earns.
 */
export function settleLeads(
  leads: LeadRecord[],
  now: number,
  refunded: (pi: string) => number = () => 0,
  ends: Map<string, number> = new Map(),
): SettledLead[] {
  const ordered = [...leads].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const days = new Map<string, number>();
  const hours = new Map<string, number>();
  const months = new Map<string, number>();
  const out: SettledLead[] = [];
  for (const lead of ordered) {
    const end = lead.kind === "booking" ? ends.get(lead.ref) ?? lead.end : 0;
    const from = lead.kind === "booking" ? Math.max(end, lead.at) : lead.at;
    const readyAt = from + lead.hold * 86_400;
    const settled = (status: LeadStatus): SettledLead => ({ lead, status, commission: EARNING_LEAD.includes(status) ? lead.cents : 0, readyAt });
    if (lead.state === "reversed") {
      out.push(settled("not genuine"));
      continue;
    }
    if (lead.kind === "booking" && lead.pi && lead.paid > 0 && refunded(lead.pi) >= lead.paid) {
      out.push(settled("refunded"));
      continue;
    }
    const day = `${lead.aff}|${Math.floor(lead.at / 86_400)}`;
    const hour = `${lead.aff}|${Math.floor(lead.at / 3_600)}`;
    const month = `${lead.currency}|${new Date(lead.at * 1000).toISOString().slice(0, 7)}`;
    const spent = months.get(month) ?? 0;
    if (lead.state !== "approved") {
      if ((days.get(day) ?? 0) >= lead.daily) {
        out.push(settled("over daily cap"));
        continue;
      }
      if ((hours.get(hour) ?? 0) >= hourlyLeads(lead.daily)) {
        out.push(settled("over hourly limit"));
        continue;
      }
      if (spent + lead.cents > lead.budget) {
        out.push(settled("over monthly budget"));
        continue;
      }
    }
    days.set(day, (days.get(day) ?? 0) + 1);
    hours.set(hour, (hours.get(hour) ?? 0) + 1);
    months.set(month, spent + lead.cents);
    if (lead.state === "approved") out.push(settled("approved"));
    else if (lead.kind === "booking" && now < end) out.push(settled("waiting for the call"));
    else out.push(settled(now < readyAt ? "in hold" : "needs approval"));
  }
  return out;
}

/** An address as an affiliate is shown it: its first letter and its domain. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return email ? "•••" : "";
  return `${email[0]}•••${email.slice(at)}`;
}
