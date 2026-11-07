/**
 * Challenges for affiliates (384 [TB10], unit 1): the pure rules.
 *
 * A creator sets a period, a goal or a number of winning places, and a prize
 * of their own (a product, access or a coupon). The standings are worked out
 * from the affiliate book the affiliates page already reads
 * (lib/affiliates.ts readBook), so a challenge adds no read, no write and no
 * call of its own:
 *
 *   - only a paid sale an affiliate brought counts (a click, a code, a buyer
 *     who stays theirs, a buyer who was their lead), inside the dates, of a listed
 *     product when the creator lists some. A renewal, a partner's share, a
 *     bonus, the second tier and a lead are not new sales;
 *   - the book already counts refunds and disputes from the creator's Stripe
 *     account, so a refunded or disputed sale is off, and a refund that comes
 *     after the end takes the sale off too. A book whose refunds could not be
 *     checked gives no standings at all, never a guess;
 *   - the affiliate's own purchase never counts; an affiliate who is not
 *     approved, who is held for the creator to look at (a shared address,
 *     paid search clicks) or whom the creator left out is not placed;
 *   - on the same number of sales, who got there first is ahead; the same
 *     number at the same second shares the place, and a shared winning
 *     place wins for everybody on it;
 *   - another affiliate is shown by the name they chose for the board, only
 *     when they chose one, and never by their address.
 *
 * Marktmorgen holds no money and pays no prize: the prize is the creator's,
 * given by them. Nothing here changes a commission, a rate or a payout.
 */
import type { Book, Credit, LineStatus, Row } from "@/lib/affiliates";

/** The longest title, in characters. */
export const CHALLENGE_MAX_TITLE = 80;
/** The shortest challenge is a day; the longest is about three months. */
export const CHALLENGE_MIN_DAYS = 1;
export const CHALLENGE_MAX_DAYS = 92;
/** How far ahead a challenge may start, in days. */
export const CHALLENGE_MAX_LEAD_DAYS = 365;
/**
 * Days after the end to wait before handing out prizes. Most refund windows
 * are 30 days or less; a refund or a chargeback after that still takes a
 * sale off, and the page says so.
 */
export const CHALLENGE_SETTLE_DAYS = 30;
/** The most winning places, and the highest goal. */
export const CHALLENGE_MAX_PLACES = 10;
export const CHALLENGE_MAX_GOAL = 10_000;
/** The most products a challenge can be limited to. */
export const CHALLENGE_MAX_PRODUCTS = 50;
/** The longest prize description, in characters. */
export const CHALLENGE_MAX_PRIZE = 120;
/** How many rows the board shows by default. */
export const CHALLENGE_BOARD_ROWS = 10;

const DAY = 86_400;
/** Seconds since 1970 stay below this until the year 5138; milliseconds never do. */
const SECONDS_CEILING = 100_000_000_000;

/** What the prize is: always the creator's own. There is no cash kind: Marktmorgen pays no prize. */
export type PrizeKind = "product" | "access" | "coupon";
const PRIZE_KINDS: readonly PrizeKind[] = ["product", "access", "coupon"];

export type ChallengePrize = { kind: PrizeKind; label: string };

export type Challenge = {
  title: string;
  /** First second it counts, and the second it stops (not counted), in seconds. */
  start: number;
  end: number;
  /** Sales that win on their own; 0 for none. */
  goal: number;
  /** How many top places win; 0 for none. */
  places: number;
  /** Product ids whose sales count; empty for every product. */
  products: string[];
  prize: ChallengePrize;
  /** Affiliates the creator left out of this challenge. */
  excluded?: string[];
};

export type ChallengeProblem = "title" | "dates" | "winners" | "prize" | "products";

export type ChallengePhase = "upcoming" | "running" | "settling" | "over";

export type Standing = {
  aff: string;
  sales: number;
  /** When they reached their count: the time of their last counted sale, in seconds. */
  reachedAt: number;
  place: number;
  wins: boolean;
};

export type BoardRow = { place: number; label: string; sales: number; you: boolean; wins: boolean };

/** The sales an affiliate brought, as the book credits them. */
const BROUGHT_NEW: readonly Credit[] = ["click", "code", "buyer", "contact"];
/** Book states of a sale that was paid and kept, in whole or in part. */
const KEPT: readonly LineStatus[] = ["earned", "partly refunded"];

const LINK = /https?:|:\/\/|www\./i;
const PRODUCT_ID = /^[A-Za-z0-9_-]{1,64}$/;

const tidy = (raw: unknown): string => (typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "");
const whole = (raw: unknown, min: number, max: number): number | null =>
  typeof raw === "number" && Number.isSafeInteger(raw) && raw >= min && raw <= max ? raw : null;

/** A challenge as the creator typed it, checked; anything unknown is refused, never guessed. */
export function readChallenge(raw: unknown, nowMs: number): { ok: true; challenge: Challenge } | { ok: false; problem: ChallengeProblem } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, problem: "title" };
  const value = raw as Record<string, unknown>;

  const title = tidy(value.title);
  if (!title || title.length > CHALLENGE_MAX_TITLE) return { ok: false, problem: "title" };

  const now = Math.floor(nowMs / 1000);
  const start = whole(value.start, 1, SECONDS_CEILING);
  const end = whole(value.end, 1, SECONDS_CEILING);
  if (
    start === null ||
    end === null ||
    end - start < CHALLENGE_MIN_DAYS * DAY ||
    end - start > CHALLENGE_MAX_DAYS * DAY ||
    end <= now ||
    start > now + CHALLENGE_MAX_LEAD_DAYS * DAY
  ) {
    return { ok: false, problem: "dates" };
  }

  const goal = value.goal === undefined || value.goal === null ? 0 : whole(value.goal, 0, CHALLENGE_MAX_GOAL);
  const places = value.places === undefined || value.places === null ? 0 : whole(value.places, 0, CHALLENGE_MAX_PLACES);
  if (goal === null || places === null || (goal === 0 && places === 0)) return { ok: false, problem: "winners" };

  const prizeRaw = value.prize;
  if (!prizeRaw || typeof prizeRaw !== "object" || Array.isArray(prizeRaw)) return { ok: false, problem: "prize" };
  const kind = (prizeRaw as Record<string, unknown>).kind;
  const label = tidy((prizeRaw as Record<string, unknown>).label);
  if (
    typeof kind !== "string" ||
    !(PRIZE_KINDS as readonly string[]).includes(kind) ||
    !label ||
    label.length > CHALLENGE_MAX_PRIZE ||
    LINK.test(label) ||
    /[<>]/.test(label)
  ) {
    return { ok: false, problem: "prize" };
  }

  let products: string[] = [];
  if (value.products !== undefined && value.products !== null) {
    if (!Array.isArray(value.products) || value.products.length > CHALLENGE_MAX_PRODUCTS) return { ok: false, problem: "products" };
    if (!value.products.every((p) => typeof p === "string" && PRODUCT_ID.test(p))) return { ok: false, problem: "products" };
    products = [...new Set(value.products as string[])];
  }

  return { ok: true, challenge: { title, start, end, goal, places, products, prize: { kind: kind as PrizeKind, label } } };
}

/** Where a challenge is in time. */
export function challengePhase(c: Pick<Challenge, "start" | "end">, nowMs: number): ChallengePhase {
  const now = Math.floor(nowMs / 1000);
  if (now < c.start) return "upcoming";
  if (now < c.end) return "running";
  if (now < c.end + CHALLENGE_SETTLE_DAYS * DAY) return "settling";
  return "over";
}

/**
 * The standings, from the book as it reads today. `review` lists the
 * approved affiliates who would be placed but are held for the creator to
 * look at, so the creator can see why they are missing.
 */
export function challengeStandings(
  c: Challenge,
  book: Pick<Book, "lines" | "rows" | "refundsChecked">,
): { ok: true; standings: Standing[]; review: string[] } | { ok: false; problem: "refunds" } {
  if (book.refundsChecked !== true) return { ok: false, problem: "refunds" };
  const approved = new Map<string, Row>();
  for (const r of book.rows) if (r.affiliate.status === "approved") approved.set(r.affiliate.id, r);
  const excluded = new Set(c.excluded ?? []);
  const products = new Set(c.products);

  // One payment is one sale, however many times it shows on the book.
  const seen = new Set<string>();
  const sold = new Map<string, { sales: number; reachedAt: number }>();
  for (const line of book.lines) {
    if (!BROUGHT_NEW.includes(line.how) || line.self || !KEPT.includes(line.status)) continue;
    if (!(line.base - line.refunded > 0)) continue;
    if (!(line.at >= c.start && line.at < c.end)) continue;
    if (products.size && !products.has(line.product)) continue;
    if (!approved.has(line.aff) || excluded.has(line.aff)) continue;
    if (seen.has(line.ref)) continue;
    seen.add(line.ref);
    const so = sold.get(line.aff);
    sold.set(line.aff, { sales: (so?.sales ?? 0) + 1, reachedAt: Math.max(so?.reachedAt ?? 0, line.at) });
  }

  const review: string[] = [];
  const counted: Omit<Standing, "place" | "wins">[] = [];
  for (const [aff, so] of sold) {
    if ((approved.get(aff)?.flags.length ?? 0) > 0) {
      review.push(aff);
      continue;
    }
    counted.push({ aff, ...so });
  }
  counted.sort((a, b) => b.sales - a.sales || a.reachedAt - b.reachedAt || (a.aff < b.aff ? -1 : a.aff > b.aff ? 1 : 0));

  const standings: Standing[] = [];
  counted.forEach((s, i) => {
    const before = standings[i - 1];
    const place = before && before.sales === s.sales && before.reachedAt === s.reachedAt ? before.place : i + 1;
    const wins = (c.places > 0 && place <= c.places) || (c.goal > 0 && s.sales >= c.goal);
    standings.push({ ...s, place, wins });
  });
  return { ok: true, standings, review: review.sort() };
}

/**
 * The board one affiliate sees: the top rows, their own row as "You", others
 * by the name they chose for the board (`names`), or "An affiliate". Their
 * own place is given even when it is below the rows shown.
 */
export function challengeBoard(
  standings: Standing[],
  viewer: string,
  names: Record<string, unknown>,
  top = CHALLENGE_BOARD_ROWS,
): { rows: BoardRow[]; mine: { place: number | null; sales: number } } {
  const label = (aff: string): string => {
    if (aff === viewer) return "You";
    const chosen = Object.prototype.hasOwnProperty.call(names, aff) ? readBoardName(names[aff]) : null;
    return chosen ?? "An affiliate";
  };
  const rows = standings.slice(0, Math.max(0, top)).map((s) => ({ place: s.place, label: label(s.aff), sales: s.sales, you: s.aff === viewer, wins: s.wins }));
  const own = standings.find((s) => s.aff === viewer);
  return { rows, mine: own ? { place: own.place, sales: own.sales } : { place: null, sales: 0 } };
}

/** A name an affiliate chose for the board: letters, numbers, spaces and . ' _ -; never an address or a link. */
export function readBoardName(raw: unknown): string | null {
  const name = tidy(raw);
  if (name.length < 2 || name.length > 30) return null;
  if (!/^[\p{L}\p{N}][\p{L}\p{N} .'_-]*$/u.test(name)) return null;
  if (LINK.test(name) || /\.[a-z]{2,}/i.test(name)) return null;
  return name;
}

const day = (seconds: number): string =>
  new Date(seconds * 1000).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });

/** What the creator's page says about a challenge, in plain words. Dates are in Coordinated Universal Time (UTC). */
export function challengeNotes(c: Challenge, nowMs: number): string[] {
  const notes = [
    `The prize comes from you: ${c.prize.label}. You give it yourself. Marktmorgen does not pay or hold prizes.`,
    "Only paid sales your affiliates bring count. Their own purchases, refunded sales and chargebacks do not count.",
  ];
  const lastDay = day(c.end - 1);
  switch (challengePhase(c, nowMs)) {
    case "upcoming":
      notes.push(`It starts on ${day(c.start)} and ends on ${lastDay} (Coordinated Universal Time, UTC).`);
      break;
    case "running":
      notes.push(`It ends on ${lastDay} (Coordinated Universal Time, UTC).`);
      break;
    case "settling":
      notes.push(
        `It ended on ${lastDay}. Places can still change if a sale is refunded or disputed, so wait until ${day(c.end + CHALLENGE_SETTLE_DAYS * DAY)} before you hand out prizes.`,
      );
      break;
    case "over":
      notes.push(`It ended on ${lastDay}. A refund or a chargeback can still take a sale off.`);
      break;
  }
  return notes;
}
