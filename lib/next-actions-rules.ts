/**
 * "Do this next": the store's next best actions (complement WG of 484 [IT1], 5 November 2026, "Próximas ações da
 * loja com números reais"; unit 1, Claude 1, 10 November 2026). The rules only, pure and browser-safe: from counts
 * the store already keeps, choose one to three actions, each with the count, where the count comes from and when it
 * was counted. No model is called here; a later unit may ask one to word a draft, inside its own cost ceiling, and
 * only when the creator asks.
 *
 *   - Only facts already recorded, never a forecast: no "you could earn", no percentage, no estimate. The money a
 *     line shows is money that is recorded (what failed, what members pay now, what former members paid), never a
 *     gain to come.
 *   - A count that could not be read is "unknown", never zero: no action is built on it, and the view says which
 *     numbers are missing, so it never says there is nothing to do while one is.
 *   - A count of zero proposes nothing. With nothing read above zero and nothing missing, nothing is invented.
 *   - Shown only to a role that may see the numbers and prepare what the action prepares (lib/team-roles.ts).
 *   - Order: money already owed first (a failed payment is money a buyer agreed to pay, lost if left), then by the
 *     recorded money in the store's currency, highest first; money not known, or in another currency, is never
 *     ranked as if it were less or more than a known amount: those come after, by count. Ties keep a fixed order.
 *   - Preparing never sends, switches on or charges: a draft, or an automation made paused, shown before anything.
 *
 * The counts are read by the studio in the next unit, each from the reading named in its `source` (lib/dunning-rules.ts,
 * lib/yearly-switch-rules.ts, lib/winback.ts, the course progress and the list's welcome sequence), counting only
 * people the store may write to (a marketing email needs the person's yes; that is the reading's job, not this file's).
 */
import { formatMoney, isCurrency } from "@/lib/money";
import type { Permission } from "@/lib/team-roles";

/** The most actions shown at once. */
export const NEXT_ACTIONS_MAX = 3;

/** How far ahead of now a count's time may be (clock skew) before the time is taken as not known. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

export type NextActionId = "failed_payments" | "yearly_switch" | "winback" | "course_next" | "welcome";

/** An amount as Stripe gives it: the currency's smallest unit, and its three-letter code. */
export type MoneyFact = { amount: number; currency: string };

/**
 * What the store read, one entry per action. An entry left out (undefined) is one this screen does not read: it is
 * neither proposed nor said to be missing. `count` null is a count that could not be read. `at` is when the count was
 * made (milliseconds), null when not known.
 */
export type NextFacts = {
  /** Card payments for memberships that failed in the last seven days and are still unpaid, with what they come to. */
  failedPayments?: { count: number | null; owed?: MoneyFact | null; at: number | null };
  /** Members paying monthly for a product that also has a yearly price, with what they pay together each month. */
  monthlyMembers?: { count: number | null; monthly?: MoneyFact | null; at: number | null };
  /** Former members who never got a come-back offer and may be written to, with what they paid together each month. */
  formerMembers?: { count: number | null; monthly?: MoneyFact | null; at: number | null };
  /** Students who finished one course and do not have the next one, both named by their titles. */
  courseNext?: { count: number | null; from: string; to: string; at: number | null };
  /** People who joined the list and never got a welcome email. */
  noWelcome?: { count: number | null; at: number | null };
};

/** What preparing does: a draft email, or an automation made paused. Neither sends anything. */
export type Prepare = "draft" | "paused_automation";

export type NextAction = {
  id: NextActionId;
  /** The action in one sentence, with its count. */
  words: string;
  /** Recorded money that goes with the count, in words, or null when there is none or it is not known. */
  money: string | null;
  /** Where the count comes from, in plain words. */
  source: string;
  /** When it was counted: "Counted November 10, 2026." or that the time is not known. */
  asOf: string;
  prepare: Prepare;
  /** What the button says; it prepares, it never sends. */
  button: string;
  /** Every permission the role needs to see this action. */
  needs: Permission[];
};

export type NextView =
  | { kind: "actions"; actions: NextAction[]; unknown: NextActionId[]; note: string | null }
  | { kind: "unknown"; unknown: NextActionId[]; words: string }
  | { kind: "nothing"; words: string };

/** What each action needs: the numbers ("stats"), and the right to make what it prepares. */
export const NEXT_ACTION_NEEDS: Record<NextActionId, Permission[]> = {
  failed_payments: ["stats", "draft"],
  yearly_switch: ["stats", "draft"],
  winback: ["stats", "draft"],
  course_next: ["stats", "draft"],
  // A sequence is made with "send" (lib/team-roles.ts), even paused.
  welcome: ["stats", "send"],
};

/** The fixed order for ties, and for actions whose money is not known. */
export const NEXT_ACTION_ORDER: NextActionId[] = ["failed_payments", "yearly_switch", "winback", "course_next", "welcome"];

const PREPARE: Record<NextActionId, Prepare> = {
  failed_payments: "draft",
  yearly_switch: "draft",
  winback: "draft",
  course_next: "draft",
  welcome: "paused_automation",
};

const SOURCE: Record<NextActionId, string> = {
  failed_payments: "From your failed membership payments in Stripe.",
  yearly_switch: "From your members' current plans.",
  winback: "From your former members and the offers already sent.",
  course_next: "From your students' course progress.",
  welcome: "From your email list and its welcome emails.",
};

/** What the unknown part of the view names, one per action. */
export const NEXT_ACTION_NAMES: Record<NextActionId, string> = {
  failed_payments: "failed payments",
  yearly_switch: "monthly members",
  winback: "former members",
  course_next: "course progress",
  welcome: "welcome emails",
};

export const NOTHING_NEXT = "Nothing to suggest right now. New suggestions appear here when your store's numbers change.";

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** A count read exactly: a whole number from zero up, or null. */
function countOf(raw: unknown): number | null {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
}

/** Recorded money read exactly, or null: a whole amount from zero up in a known currency. */
function moneyOf(raw: unknown): MoneyFact | null {
  if (!raw || typeof raw !== "object") return null;
  const { amount, currency } = raw as Record<string, unknown>;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0 || typeof currency !== "string") return null;
  const code = currency.toLowerCase();
  return isCurrency(code) ? { amount, currency: code } : null;
}

/** A short title, as text: trimmed, one line, at most 80 characters; null when there is none. */
function titleOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const one = raw.replace(/\s+/g, " ").trim();
  if (!one) return null;
  return one.length > 80 ? `${one.slice(0, 79)}…` : one;
}

/** When it was counted, in words; a time not known, not a number or in the future is said so. */
export function asOfWords(at: unknown, now: number): string {
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0 || at > now + FUTURE_SKEW_MS) return "When this was counted is not known.";
  const day = new Date(at).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  return `Counted ${day} (UTC).`;
}

type Candidate = { action: NextAction; owed: boolean; cents: number | null; count: number };

function candidate(id: NextActionId, facts: NextFacts, currency: string, now: number): Candidate | "unknown" | null {
  const fact = (
    {
      failed_payments: facts.failedPayments,
      yearly_switch: facts.monthlyMembers,
      winback: facts.formerMembers,
      course_next: facts.courseNext,
      welcome: facts.noWelcome,
    } as Record<NextActionId, { count: unknown; at: unknown } | undefined>
  )[id];
  if (fact === undefined) return null;
  if (!fact || typeof fact !== "object") return "unknown";
  const count = countOf(fact.count);
  if (count === null) return "unknown";
  if (count === 0) return null;

  let words: string;
  let money: MoneyFact | null = null;
  let moneyWords: string | null = null;
  let button: string;
  switch (id) {
    case "failed_payments": {
      money = moneyOf((fact as NonNullable<NextFacts["failedPayments"]>).owed);
      words = `${plural(count, "card payment", "card payments")} for memberships failed this week and ${count === 1 ? "is" : "are"} still unpaid.`;
      moneyWords = money ? `${formatMoney(money.amount, money.currency)} unpaid.` : null;
      button = "Prepare a reminder email";
      break;
    }
    case "yearly_switch": {
      money = moneyOf((fact as NonNullable<NextFacts["monthlyMembers"]>).monthly);
      words = `${plural(count, "member pays", "members pay")} monthly for a product that also has a yearly price.`;
      moneyWords = money ? `${count === 1 ? "They pay" : "Together they pay"} ${formatMoney(money.amount, money.currency)} a month now.` : null;
      button = "Prepare an email about the yearly price";
      break;
    }
    case "winback": {
      money = moneyOf((fact as NonNullable<NextFacts["formerMembers"]>).monthly);
      words = `${plural(count, "former member", "former members")} never got a come-back offer.`;
      moneyWords = money ? `${count === 1 ? "They paid" : "Together they paid"} ${formatMoney(money.amount, money.currency)} a month before leaving.` : null;
      button = "Prepare a come-back email";
      break;
    }
    case "course_next": {
      const course = fact as NonNullable<NextFacts["courseNext"]>;
      const from = titleOf(course.from);
      const to = titleOf(course.to);
      // Without both titles the action cannot say what it is about: not read, never guessed.
      if (!from || !to || from === to) return "unknown";
      words = `${plural(count, "student", "students")} finished "${from}" and ${count === 1 ? "does" : "do"} not have "${to}".`;
      button = `Prepare an email about "${to}"`;
      break;
    }
    case "welcome": {
      words = `${plural(count, "person", "people")} joined your list and never got a welcome email.`;
      button = "Prepare a welcome email, paused";
      break;
    }
  }
  return {
    action: { id, words, money: moneyWords, source: SOURCE[id], asOf: asOfWords(fact.at, now), prepare: PREPARE[id], button, needs: NEXT_ACTION_NEEDS[id] },
    owed: id === "failed_payments",
    // Only money in the store's own currency is compared; any other is known in words but not ranked.
    cents: money && money.currency === currency.toLowerCase() ? money.amount : null,
    count,
  };
}

/** Earlier first: money owed now, then known money (highest first), then not known (by count), then the fixed order. */
function before(a: Candidate, b: Candidate): number {
  if (a.owed !== b.owed) return a.owed ? -1 : 1;
  if ((a.cents === null) !== (b.cents === null)) return a.cents === null ? 1 : -1;
  if (a.cents !== null && b.cents !== null && a.cents !== b.cents) return b.cents - a.cents;
  if (a.count !== b.count) return b.count - a.count;
  return NEXT_ACTION_ORDER.indexOf(a.action.id) - NEXT_ACTION_ORDER.indexOf(b.action.id);
}

/** The words for the numbers that could not be read, naming each. */
export function unknownWords(unknown: NextActionId[]): string {
  const names = unknown.map((id) => NEXT_ACTION_NAMES[id]);
  const list = names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Some numbers could not be read just now (${list}), so these suggestions may not be complete. Reload the page in a moment.`;
}

/**
 * The next one to three actions for this role, from the store's recorded counts. `may` says whether the role holds a
 * permission; `currency` is the store's own, the only one money is ranked in; `now` is the time of the reading.
 */
export function nextActions(facts: NextFacts, options: { may: (permission: Permission) => boolean; currency: string; now: number }): NextView {
  const found: Candidate[] = [];
  const unknown: NextActionId[] = [];
  for (const id of NEXT_ACTION_ORDER) {
    // A role that may not act on it is not told about it, nor that its number is missing.
    if (!NEXT_ACTION_NEEDS[id].every((permission) => options.may(permission))) continue;
    const got = candidate(id, facts, options.currency, options.now);
    if (got === "unknown") unknown.push(id);
    else if (got) found.push(got);
  }
  found.sort(before);
  const actions = found.slice(0, NEXT_ACTIONS_MAX).map((c) => c.action);
  if (actions.length) return { kind: "actions", actions, unknown, note: unknown.length ? unknownWords(unknown) : null };
  if (unknown.length) return { kind: "unknown", unknown, words: unknownWords(unknown) };
  return { kind: "nothing", words: NOTHING_NEXT };
}
