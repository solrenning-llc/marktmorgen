/**
 * All of an account's stores, added up (639 [GL7](38)): visits, checkouts,
 * sales and members, read from the same figures each store's own studio
 * shows (lib/stats-report.ts readNumbers, lib/membership-numbers.ts), never
 * a second count. Money is added up only within one currency: a store that
 * sells in euros and one that sells in dollars give two lines, never one sum
 * at an exchange rate nobody chose.
 *
 * Only what the person may see: a store where their role cannot read the
 * numbers is named, with nothing read. Each store read is one studio page of
 * that store's own allowance, so the page cannot read past a plan's limits.
 */
import type { StatsData } from "@/lib/stats";
import type { Numbers } from "@/lib/membership-numbers";
import { paidFiguresComplete } from "@/lib/paid-coverage";
import { formatMoney } from "@/lib/money";

export const TOTAL_WINDOWS = ["d7", "d30", "d90"] as const;
export type TotalWindow = (typeof TOTAL_WINDOWS)[number];

/**
 * A store's members: its figures, null when it has no memberships, or "unread" when they could not be read (Stripe
 * could not be reached, or the day's readings are used): named on the page, never added in as none (sweep app5,
 * finding 3).
 */
export type StoreMembers = { currency: string; paying: number; trialing: number; mrr: number } | null | "unread";

export type StoreRead =
  | { state: "ok"; data: StatsData | null; members: StoreMembers }
  /** Their role in that store does not include the numbers. */
  | { state: "no_access" }
  /** That store's studio allowance for the month is used up. */
  | { state: "paused" }
  /** None of its numbers is kept and its readings for the UTC day are used (lib/store-readings.ts, ReadingsUsed). */
  | { state: "used" }
  | { state: "error" };

export type StoreFigures = { sid: string; name: string; handle: string; read: StoreRead };

export type Money = { currency: string; cents: number };

export type WindowSum = {
  visitors: number;
  checkouts: number;
  sales: number;
  /** One line per currency, largest first. */
  revenue: Money[];
};

export type AccountTotals = {
  windows: Record<TotalWindow, WindowSum>;
  /** `unread` names the stores whose members could not be read: the member figures leave them out. */
  members: { paying: number; trialing: number; mrr: Money[]; unread: string[] };
  /** Stores whose figures are in the sums. */
  counted: number;
  /** Stores named but not in the sums, and why. */
  left: { name: string; why: Exclude<StoreRead["state"], "ok"> | "no_numbers" }[];
  /** Every sale figure in the sums was read whole (no store's sales missing or cut short). */
  salesWhole: boolean;
};

function addMoney(lines: Map<string, number>, currency: string, cents: number) {
  if (!Number.isFinite(cents) || cents === 0) return;
  const code = (currency || "").toUpperCase();
  lines.set(code, (lines.get(code) ?? 0) + Math.round(cents));
}

const sorted = (lines: Map<string, number>): Money[] =>
  [...lines].map(([currency, cents]) => ({ currency, cents })).sort((a, b) => b.cents - a.cents || a.currency.localeCompare(b.currency));

/** The sums, from each store's own figures. */
export function sumStores(stores: readonly StoreFigures[]): AccountTotals {
  const counts = Object.fromEntries(TOTAL_WINDOWS.map((w) => [w, { visitors: 0, checkouts: 0, sales: 0, money: new Map<string, number>() }])) as Record<
    TotalWindow,
    { visitors: number; checkouts: number; sales: number; money: Map<string, number> }
  >;
  const mrr = new Map<string, number>();
  let paying = 0;
  let trialing = 0;
  let counted = 0;
  let salesWhole = true;
  const left: AccountTotals["left"] = [];
  const unread: string[] = [];
  for (const store of stores) {
    const read = store.read;
    if (read.state !== "ok") {
      left.push({ name: store.name, why: read.state });
      continue;
    }
    if (!read.data) {
      left.push({ name: store.name, why: "no_numbers" });
      continue;
    }
    counted += 1;
    const data = read.data;
    if (data.sales !== "none" && !paidFiguresComplete(data)) salesWhole = false;
    for (const w of TOTAL_WINDOWS) {
      const t = data.totals[w];
      counts[w].visitors += t.visitors;
      counts[w].checkouts += t.checkouts;
      counts[w].sales += t.sales;
      addMoney(counts[w].money, data.currency, t.cents);
    }
    const club = read.members;
    if (club === "unread") unread.push(store.name);
    else if (club) {
      paying += club.paying;
      trialing += club.trialing;
      addMoney(mrr, club.currency, club.mrr);
    }
  }
  const windows = Object.fromEntries(
    TOTAL_WINDOWS.map((w) => [w, { visitors: counts[w].visitors, checkouts: counts[w].checkouts, sales: counts[w].sales, revenue: sorted(counts[w].money) }]),
  ) as Record<TotalWindow, WindowSum>;
  return { windows, members: { paying, trialing, mrr: sorted(mrr), unread }, counted, left, salesWhole };
}

/** A store's members, read: a read that fails is "unread", never "no members" (sweep app5, finding 3). */
export async function membersOf(read: Promise<Numbers | null>): Promise<StoreMembers> {
  try {
    const club = await read;
    return club ? { currency: club.currency, paying: club.paying, trialing: club.trialing, mrr: club.mrr } : null;
  } catch (error) {
    console.error("reading one store's members for the totals failed", error);
    return "unread";
  }
}

/** Money in each currency, joined; none is $0.00. */
export const moneyWords = (lines: Money[]) => (lines.length ? lines.map((m) => formatMoney(m.cents, m.currency)).join(" + ") : formatMoney(0, "USD"));

const names = (list: string[]) => (list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}` : list[0] ?? "");

/**
 * The member figures as the page shows them. With a store's members unread, they are never shown as the whole: each
 * says "At least", or "Not known" when nothing was read, and the note names the stores left out (sweep app5, finding 3).
 */
export function memberLines(totals: AccountTotals): { paying: string; trialing: string; mrr: string; note: string | null } {
  const { paying, trialing, mrr, unread } = totals.members;
  const count = (n: number) => n.toLocaleString("en-US");
  if (!unread.length) return { paying: count(paying), trialing: count(trialing), mrr: moneyWords(mrr), note: null };
  if (!paying && !trialing && !mrr.length) {
    return {
      paying: "Not known",
      trialing: "Not known",
      mrr: "Not known",
      note: `Members could not be read just now for ${names(unread)}, so the member numbers are not shown.`,
    };
  }
  return {
    paying: `At least ${count(paying)}`,
    trialing: `At least ${count(trialing)}`,
    mrr: `At least ${moneyWords(mrr)}`,
    note: `Members could not be read just now for ${names(unread)}, so the member numbers below leave ${unread.length === 1 ? "it" : "them"} out and may be lower than they are.`,
  };
}

/** Why a store is not in the sums, in a few plain words. */
export const LEFT_WORDS: Record<AccountTotals["left"][number]["why"], string> = {
  no_access: "your role there does not include its numbers",
  paused: "its studio is paused for the rest of the month",
  error: "its numbers could not be read just now",
  // The page adds when, at 00:00 UTC and on the reader's own clock (inbox C4-33 (3)).
  used: "its numbers were read as often as a day allows; they update again at 00:00 UTC",
  no_numbers: "it has no numbers yet",
};
