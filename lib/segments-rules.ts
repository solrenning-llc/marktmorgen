/**
 * The rules of saved groups and of the three ways to narrow an email by
 * money (lib/segments.ts), with nothing that reads a database or a secret,
 * so the studio's composer can import them to draw its choices.
 */
import { readMoney, type Currency } from "@/lib/money";
import type { Who } from "@/lib/contacts";
import { RFM_GROUPS, type RfmGroup } from "@/lib/rfm-rules";

/**
 * Spent at least, in the smallest unit of the store's currency; first found
 * the store through; has not bought in this many days; and, only when chosen,
 * one group of the store's buyers by how recently and how often they bought
 * (lib/rfm-rules.ts, 270 [GR1], unit 3b), absent otherwise, as on every
 * email, draft and group saved before it.
 */
export type Narrow = {
  minSpent: number;
  channel: string;
  quietDays: number;
  group?: RfmGroup;
  /**
   * Bought here in the last this many days (one of ACTIVE_DAYS; 461 [EL5],
   * unit 1): the buyers still active, from the same buyers' ledger as the
   * others. Absent otherwise, as on every email, draft and group saved before.
   */
  activeDays?: number;
};

export const NO_NARROW: Narrow = { minSpent: 0, channel: "", quietDays: 0 };
/** The choices offered for "has not bought in the last…", in days. */
export const QUIET_DAYS = [30, 60, 90, 180, 365] as const;
/** The choices offered for "bought in the last…", in days. */
export const ACTIVE_DAYS = [30, 60, 90, 180] as const;
export const MAX_SEGMENTS = 20;
export const MAX_SEGMENT_NAME = 60;
export const MAX_SPENT = 100_000_000;
const CHANNEL = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/** A saved group: a name over the composer's choices. */
/** `label`: only people who carry it (99 [E2-TAG-BROADCAST]); empty for none, as on every group saved before it. */
export type Segment = { id: string; name: string; who: Who; productId: string; notProductId: string; label: string } & Narrow;

/** The three narrowings from what a request sent; anything that is not one of them is left out. */
export function readNarrow(raw: unknown): Narrow {
  if (!raw || typeof raw !== "object") return { ...NO_NARROW };
  const value = raw as Record<string, unknown>;
  const spent = Math.round(Number(value.minSpent));
  const quiet = Math.round(Number(value.quietDays));
  const channel = typeof value.channel === "string" ? value.channel.trim().toLowerCase() : "";
  const group = RFM_GROUPS.find((g) => g.id === value.group)?.id;
  const active = Math.round(Number(value.activeDays));
  return {
    minSpent: Number.isFinite(spent) && spent > 0 ? Math.min(spent, MAX_SPENT) : 0,
    channel: CHANNEL.test(channel) ? channel : "",
    quietDays: (QUIET_DAYS as readonly number[]).includes(quiet) ? quiet : 0,
    ...(group ? { group } : {}),
    ...((ACTIVE_DAYS as readonly number[]).includes(active) ? { activeDays: active } : {}),
  };
}

export function isNarrowed(narrow: Narrow | null | undefined): narrow is Narrow {
  return Boolean(narrow && (narrow.minSpent > 0 || narrow.channel || narrow.quietDays > 0 || narrow.group || narrow.activeDays));
}

const NARROW_KEYS = new Set(["minSpent", "channel", "quietDays", "group", "activeDays"]);

/**
 * Whether a narrowing sent or kept is exactly the one read from it: a field
 * that would be dropped or changed, or one this version does not know, is
 * never read as a broader group. So a record written by a later version with
 * a new way to narrow is refused here rather than sent to more people.
 */
export function sameNarrow(raw: Record<string, unknown>, narrow: Narrow): boolean {
  if (!Object.keys(raw).every((key) => NARROW_KEYS.has(key))) return false;
  return raw.minSpent === narrow.minSpent && raw.channel === narrow.channel && raw.quietDays === narrow.quietDays && (raw.group ?? undefined) === narrow.group && (raw.activeDays ?? undefined) === narrow.activeDays;
}

/** Empty/zero means no minimum; malformed or out-of-range text must not broaden an audience. */
export function readSegmentSpend(raw: string, currency: Currency): number | null {
  if (!raw.trim()) return 0;
  const amount = readMoney(raw, currency);
  return amount !== null && amount <= MAX_SPENT ? amount : null;
}
