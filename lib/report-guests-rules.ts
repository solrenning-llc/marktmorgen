/**
 * The numbers email to addresses outside the team (405 [HX1], unit 1): the
 * rules, pure, kept apart so the studio, the routes and the job read the same
 * ones. Nothing here stores, signs or sends.
 *
 * The weekly and monthly numbers email already goes to the creator and to
 * up to MAX_WEEKLY_TEAM team members (lib/stats-report.ts). This is for a
 * partner, an investor or someone keeping the books who is not on the team. Unlike the
 * team's copy it carries only the figures the creator chose, none by default,
 * and only to an address that said yes to it first, through its own link:
 *
 *   - at most MAX_REPORT_GUESTS addresses, never one on the team (the team
 *     has its own list) and never the owner's own (it gets the email already);
 *   - an address is "invited" until it confirms, and an invitation lapses
 *     after INVITE_DAYS; an invited address gets no figure, ever;
 *   - a confirmed address can leave at any time ("left"); added again, it is
 *     invited again and confirms again, never confirmed by itself;
 *   - whether an address may get the email is checked again just before each
 *     send (mayGet), with the team and the owner as they are then;
 *   - a figure not known in full is said "unknown", never zero, and a total
 *     of affiliates' sales goes only when at least AFFILIATE_MIN_SELLERS
 *     affiliates made sales, so no one affiliate's sales can be read from it;
 *   - no buyer's name, address or order and no affiliate's identity is ever a
 *     figure here.
 *
 * Still to come (later units): where the choice and the addresses are kept,
 * the invitation and its link, the confirmation and the one-click leave, the
 * studio screen, and the send in the existing weekly and monthly jobs, each
 * email counted on the store's service emails before it goes.
 */
import { formatMoney } from "@/lib/money";

/** Addresses outside the team a store may send its numbers to. */
export const MAX_REPORT_GUESTS = 3;
/** Days an invitation stays open before the address has to be invited again. */
export const INVITE_DAYS = 14;
/** Fewest affiliates with sales for their total to go out (as 398 [SL2] keeps a place under three members hidden). */
export const AFFILIATE_MIN_SELLERS = 3;

/** The figures that may go, in the order they are shown. */
export const REPORT_FIGURES = ["sales", "revenue", "visits", "subscribers", "affiliates"] as const;
export type ReportFigure = (typeof REPORT_FIGURES)[number];

/** How each figure is named in the email and in the studio. */
export const FIGURE_WORDS: Record<ReportFigure, string> = {
  sales: "Sales",
  revenue: "Money in, after refunds",
  visits: "Visits",
  subscribers: "New subscribers",
  affiliates: "Sales through affiliates",
};

export const REPORT_EVERY = ["week", "month"] as const;
export type ReportEvery = (typeof REPORT_EVERY)[number];

export type Guest = {
  /** Lower case, as guestAddress keeps it. */
  address: string;
  state: "invited" | "confirmed" | "left";
  /** When the current invitation went out, in milliseconds. */
  invitedAt: number;
};

/** The figures chosen, each once, in REPORT_FIGURES order; null when anything else was sent. An empty choice is a choice: nothing goes. */
export function readFigures(raw: unknown): ReportFigure[] | null {
  if (!Array.isArray(raw)) return null;
  if (!raw.every((figure) => typeof figure === "string" && (REPORT_FIGURES as readonly string[]).includes(figure))) return null;
  return REPORT_FIGURES.filter((figure) => raw.includes(figure));
}

export function readEvery(raw: unknown): ReportEvery | null {
  return typeof raw === "string" && (REPORT_EVERY as readonly string[]).includes(raw) ? (raw as ReportEvery) : null;
}

/**
 * One plain address, trimmed and in lower case, or null: one "@", a name
 * before it, a domain with a dot after it, no space, comma, quote or angle
 * bracket, and no longer than an address can be (254, 64 before the "@").
 */
export function guestAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const address = raw.trim().toLowerCase();
  if (address.length > 254 || /[\s,;"'<>()[\]\\]/.test(address)) return null;
  const parts = address.split("@");
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (!local || local.length > 64) return null;
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((label) => !label || label.startsWith("-") || label.endsWith("-"))) return null;
  return address;
}

export type GuestPlan =
  | { ok: true; keep: Guest[]; invite: string[]; drop: string[] }
  | { ok: false; why: "too_many" | "not_an_address" | "on_the_team" | "own_address" | "twice"; address?: string };

/**
 * What saving a list of typed addresses does to the current guests: who
 * stays as they are, who is invited, who is dropped. All or nothing: one
 * address that cannot be taken refuses the list, naming why. Blank lines are
 * skipped. An address that left is invited again.
 */
export function planGuests(typed: unknown[], current: Guest[], { team, owner }: { team: string[]; owner: string }): GuestPlan {
  const teamSet = new Set(team.map((address) => address.trim().toLowerCase()));
  const ownAddress = owner.trim().toLowerCase();
  const wanted: string[] = [];
  for (const raw of typed) {
    if (typeof raw === "string" && !raw.trim()) continue;
    const address = guestAddress(raw);
    if (!address) return { ok: false, why: "not_an_address" };
    if (wanted.includes(address)) return { ok: false, why: "twice", address };
    if (teamSet.has(address)) return { ok: false, why: "on_the_team", address };
    if (address === ownAddress) return { ok: false, why: "own_address", address };
    wanted.push(address);
  }
  if (wanted.length > MAX_REPORT_GUESTS) return { ok: false, why: "too_many" };
  const byAddress = new Map(current.map((guest) => [guest.address, guest]));
  const keep = wanted.flatMap((address) => {
    const known = byAddress.get(address);
    return known && known.state !== "left" ? [known] : [];
  });
  const invite = wanted.filter((address) => !keep.some((guest) => guest.address === address));
  const drop = current.filter((guest) => !wanted.includes(guest.address)).map((guest) => guest.address);
  return { ok: true, keep, invite, drop };
}

/** Whether an invitation can still be confirmed: invited, with a readable time, less than INVITE_DAYS ago. */
export function inviteOpen(guest: Guest, now: number): boolean {
  if (guest.state !== "invited" || !Number.isFinite(guest.invitedAt) || guest.invitedAt > now) return false;
  return now - guest.invitedAt < INVITE_DAYS * 86_400_000;
}

/**
 * Whether this address may get the numbers now, checked just before each
 * send: confirmed, something chosen, and not on the team or the owner's own
 * address as they are at that moment (those get the team's email instead).
 */
export function mayGet(guest: Guest, share: { figures: ReportFigure[]; every: ReportEvery }, { team, owner }: { team: string[]; owner: string }): boolean {
  if (guest.state !== "confirmed" || share.figures.length === 0 || !readEvery(share.every)) return false;
  const address = guestAddress(guest.address);
  if (!address || address === owner.trim().toLowerCase()) return false;
  return !team.some((member) => member.trim().toLowerCase() === address);
}

/** What the store's numbers were for the period, as read; null or missing is not known in full. */
export type GuestFigures = {
  sales?: number | null;
  /** In the smallest unit of `currency`, after refunds. */
  revenue?: number | null;
  visits?: number | null;
  subscribers?: number | null;
  affiliates?: { sellers: number | null; sales: number | null } | null;
  currency: string;
};

const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The email's lines, one per chosen figure, in REPORT_FIGURES order. */
export function guestLines(figures: ReportFigure[], values: GuestFigures): string[] {
  return REPORT_FIGURES.filter((figure) => figures.includes(figure)).map((figure) => {
    const name = FIGURE_WORDS[figure];
    if (figure === "affiliates") {
      const group = values.affiliates;
      if (!group || !whole(group.sellers) || !whole(group.sales)) return `${name}: unknown`;
      if (group.sellers < AFFILIATE_MIN_SELLERS) return `${name}: not shown, because fewer than ${AFFILIATE_MIN_SELLERS} affiliates made sales`;
      return `${name}, all together: ${group.sales.toLocaleString("en-US")}`;
    }
    const value = values[figure];
    // Money in after refunds is below zero in a period that refunded more than it took: known, and said as it is.
    if (figure === "revenue") {
      return typeof value === "number" && Number.isSafeInteger(value) && /^[a-z]{3}$/i.test(values.currency) ? `${name}: ${formatMoney(value, values.currency)}` : `${name}: unknown`;
    }
    if (!whole(value)) return `${name}: unknown`;
    return `${name}: ${value.toLocaleString("en-US")}`;
  });
}

/**
 * The figures the studio offers today: those the numbers the jobs already read
 * hold in full or say are not known (lib/stats-report.ts, summaryOf). New
 * subscribers and sales through affiliates have no aggregated reader there
 * yet, so they are not offered and a save naming them is refused: a figure
 * that could only ever say "unknown" is not shown as if it worked.
 */
export const FIGURES_OFFERED: readonly ReportFigure[] = ["sales", "revenue", "visits"];

/** How the studio says where an address is (405 [HX1], unit 5). */
export type GuestStatus = "waiting" | "ended" | "getting" | "stopped";
export const STATUS_WORDS: Record<GuestStatus, string> = {
  waiting: "Invited: waiting for a yes",
  ended: "Invitation ended: remove and add again to invite again",
  getting: "Gets the email",
  stopped: "Stopped the email",
};

export function guestStatus(guest: Guest, now: number): GuestStatus {
  if (guest.state === "confirmed") return "getting";
  if (guest.state === "left") return "stopped";
  return inviteOpen(guest, now) ? "waiting" : "ended";
}

/** What the studio is shown of a store's choice: never a link or its hash. */
export type ShareView = { figures: ReportFigure[]; every: ReportEvery; guests: { address: string; status: GuestStatus }[] };

export function shareView(share: { figures: ReportFigure[]; every: ReportEvery; guests: Guest[] }, now: number): ShareView {
  return { figures: share.figures, every: share.every, guests: share.guests.map((guest) => ({ address: guest.address, status: guestStatus(guest, now) })) };
}
