/**
 * What a store's deals are worth by the channel their person first came
 * from: 639 [GL7](9), unit 1 (owner's HighLevel audit, 2 November 2026).
 * Pure and browser-safe; the CRM screen reads it next.
 *
 * Nothing new is recorded about anybody. A deal already names its person by
 * email (lib/crm-rules.ts, Deal), and the store already knows where each of
 * its buyers first came from: the channel on their earliest checkout, kept in
 * the buyers' ledger (lib/segments.ts, buyerLedger). This joins the two:
 *
 *   - a deal whose person has bought here counts under that person's first
 *     channel ("Newsletter", "Instagram", "Direct or unknown"…);
 *   - a deal whose person has not bought yet counts under "Has not bought
 *     yet", never under a channel guessed for them, and only when every sale
 *     was read: with a partial ledger, one not found counts under "Not known
 *     yet", as absence there proves nothing (Codex J, #1952);
 *   - a deal with nobody named counts under "Nobody named on the deal".
 *
 * Each row adds up open, won and lost deals by their stage's kind, the count
 * and the value the creator gave each one (in the store's currency). A deal
 * on a stage its pipeline no longer has is left out and counted, so the
 * totals never hide one. When the ledger could not read every sale (partial),
 * the result says so: a buyer's channel may then be missing.
 */
import { channelName } from "@/lib/channel-names";
import type { Deal, Stage } from "@/lib/crm-rules";

/**
 * What a row is: a buyer's first channel, or one of the rows that are not a
 * channel. Kept apart from the channel's own text, so a campaign that happens
 * to be called like one of them never shares its row (Codex J, #1952).
 */
export type RowKind = "channel" | "not_a_buyer" | "not_known" | "no_person";

export type DealTally = { deals: number; cents: number };
/** `channel` is the buyer's first channel for a channel row, "" for the others; `key` is unique among the rows. */
export type ChannelDeals = { key: string; kind: RowKind; channel: string; name: string; open: DealTally; won: DealTally; lost: DealTally };
export type DealChannels = { rows: ChannelDeals[]; unplaced: number; partial: boolean };

const zero = (): DealTally => ({ deals: 0, cents: 0 });

/** The name a row is shown under, in plain US English. */
export function dealChannelName(kind: RowKind, channel = ""): string {
  if (kind === "not_a_buyer") return "Has not bought yet";
  if (kind === "not_known") return "Not known yet";
  if (kind === "no_person") return "Nobody named on the deal";
  return channelName(channel);
}

/**
 * The deals of one pipeline by channel. `channelOf` answers a buyer's first
 * channel by their address, lower case, or null when they have not bought.
 * Rows come with the most won first, then the most open, then by name.
 */
export function dealsByChannel(
  deals: readonly Deal[],
  stages: readonly Stage[],
  channelOf: (email: string) => string | null,
  partial = false,
): DealChannels {
  const kinds = new Map(stages.map((stage) => [stage.id, stage.kind]));
  const rows = new Map<string, ChannelDeals>();
  let unplaced = 0;
  for (const deal of deals) {
    const kind = kinds.get(deal.stage);
    if (!kind) {
      unplaced += 1;
      continue;
    }
    const email = deal.email.trim().toLowerCase();
    const first = email ? channelOf(email) : null;
    // Not found in a ledger that could not read every sale: not known, never "has not bought".
    const rowKind: RowKind = !email ? "no_person" : first === null ? (partial ? "not_known" : "not_a_buyer") : "channel";
    const channel = rowKind === "channel" ? first || "direct" : "";
    const key = rowKind === "channel" ? `channel:${channel}` : rowKind;
    const row = rows.get(key) ?? { key, kind: rowKind, channel, name: dealChannelName(rowKind, channel), open: zero(), won: zero(), lost: zero() };
    const cents = Number.isSafeInteger(deal.cents) && deal.cents > 0 ? deal.cents : 0;
    row[kind].deals += 1;
    row[kind].cents += cents;
    rows.set(key, row);
  }
  const sorted = [...rows.values()].sort((a, b) => b.won.cents - a.won.cents || b.open.cents - a.open.cents || a.name.localeCompare(b.name));
  return { rows: sorted, unplaced, partial };
}

/** The totals of every row, for the line under the table. */
export function dealTotals(result: DealChannels): { open: DealTally; won: DealTally; lost: DealTally } {
  const total = { open: zero(), won: zero(), lost: zero() };
  for (const row of result.rows) {
    for (const kind of ["open", "won", "lost"] as const) {
      total[kind].deals += row[kind].deals;
      total[kind].cents += row[kind].cents;
    }
  }
  return total;
}
