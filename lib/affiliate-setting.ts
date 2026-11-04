/**
 * The terms of a store's affiliate programme, as the store record keeps them.
 *
 * Kept apart from lib/affiliates.ts, which reads and writes the affiliates,
 * their clicks and their sales, so the store record, the studio and the
 * checkout can know the terms without importing anything that talks to
 * Redis, Stripe or the sender.
 *
 * What a creator sets is small on purpose: whether it is on, what share of a
 * sale an affiliate earns — for the whole store, and differently for any
 * product they choose — how long after a click a purchase still counts, and
 * when they pay. Who is let in is the creator's decision, one application at
 * a time — or, when they choose, anybody who has bought from them.
 *
 * The last two are the promise. An affiliate who cannot see when they will be
 * paid has to ask, and asking is the thing every complaint about every
 * platform in this business is really about. So the creator says it once, in
 * the studio, and it is on the page before anybody applies: the day of the
 * month they pay, and how long a sale waits first so their refund window can
 * pass. Marktmorgen then holds them to it — a sale inside the wait is not in the
 * batch, and on the day itself the batch arrives in their inbox.
 */

import { type LeadSetting, NO_LEADS, parseLeadSetting } from "@/lib/affiliate-lead-rules";
import { type PendingTerms, readNoticeDays, readPending } from "@/lib/affiliate-notice";

/**
 * Which affiliate a sale belongs to when the buyer followed more than one
 * link before paying.
 *
 * "last" is the last link they followed, and is the default here and on every
 * other platform: it lets an affiliate win a buyer by offering something
 * better, and it leaves the buyer free to choose whose link to use.
 *
 * "first" is the affiliate who found the buyer in the first place, however
 * many links they followed afterwards. It rewards the person who did the
 * introducing rather than the person who caught them at the till.
 *
 * There is deliberately no third rule splitting one commission between
 * several affiliates. Hotmart offers it and says in its own help pages that
 * professional affiliates feel cheated by it — somebody who bought nothing
 * but a click takes a share of the work another affiliate did. One sale, one
 * affiliate, and the creator chooses which end of the journey counts.
 */
export type AttributionRule = "last" | "first";

export type AffiliateSetting = {
  /** Switched on by the creator in the studio. Off until they do. */
  enabled: boolean;
  /** What an affiliate earns on a sale, in percent of what was paid before tax. */
  percent: number;
  /** How many days after a click a purchase still counts for that affiliate. */
  days: number;
  /** Which of two links a buyer followed earns the sale. */
  rule: AttributionRule;
  /**
   * A different share for some products, by product id. 0 leaves a product
   * out of the programme; a product not listed earns the store-wide share.
   */
  rates: Record<string, number>;
  /**
   * The day of the month the creator pays their affiliates, 1 to 28, or 0
   * when they would rather not promise a day. Never 29, 30 or 31: those days
   * do not exist in every month, and a promise that skips February is worse
   * than no promise.
   */
  payday: number;
  /**
   * How many days a sale waits before it can be paid out, so the creator's
   * refund window passes first. 0 means a sale can be paid as soon as it is
   * made. This is the creator's own protection: money paid to an affiliate
   * on a sale that is later refunded has to be asked back by hand.
   */
  hold: number;
  /**
   * Whether anybody who bought from the store may join at once, without an
   * application waiting on the creator: the thanks page and the purchase email
   * offer them their own link. What Stan calls Affiliate Share and Skool calls
   * member affiliates. A buyer the creator declined or removed stays out.
   */
  buyers: boolean;
  /**
   * Whether this creator has said their programme may be listed in a public
   * directory of Marktmorgen affiliate programmes, if one ever opens.
   *
   * There is no directory. Nothing reads this to build a page, and the switch
   * says so in the future tense wherever it is shown. It exists now because
   * the slow part of a directory is not the page — that is a listing over the
   * share, the window and the payday each store already keeps — it is consent.
   * A directory opened without it means going back to every creator and asking,
   * and most never answer; asked once when they set the programme up, the
   * permission is simply there on the day the thing is worth opening.
   *
   * Which is not yet. A catalogue with ten stores in it tells an affiliate
   * there is nobody here, and operating a public marketplace brings duties
   * that cannot be switched off afterwards. So: the answer is collected, and
   * the page is not built, and this is in no plan card or comparison anywhere.
   */
  directory: boolean;
  /**
   * Whether the directory may also show this program's own numbers
   * (lib/affiliates.ts, programNumbers): how many affiliates it has, the
   * clicks they brought, the sales those clicks made and what the creator
   * says they have paid. A second consent, apart from being listed, because
   * it publishes figures about the creator's business; anything but an
   * explicit yes is a no.
   */
  numbers: boolean;
  /**
   * Whether approved affiliates may have posts drafted for them on their own
   * page (lib/affiliate-kit.ts), each one of the store's writing jobs for the
   * month and never more than a quarter of them. On unless the creator
   * switches it off: it spends the creator's allowance only to help sell the
   * creator's products, and every post says it is an affiliate link.
   */
  kit: boolean;
  /**
   * Whether a buyer, once credited to an affiliate, stays with that affiliate
   * for every later purchase — with no cookie and no expiry
   * (lib/affiliate-bond.ts). Off until the creator switches it on, because it
   * changes who gets paid and that is theirs to decide.
   */
  lifetime: boolean;
  /**
   * Whether a purchase that no link, code or bond credits earns the affiliate
   * who brought the buyer as a confirmed lead (630 [HN6](1)): an address that
   * confirmed a sign-up, claimed a free product from its emailed link or had a
   * booked call take place through that affiliate (lib/affiliate-leads.ts).
   * Off until the creator switches it on, as `lifetime` is: it changes who
   * gets paid, and a programme already running is not quietly re-pointed.
   * Missing is off.
   */
  contacts?: boolean;
  /**
   * Memberships and payment plans (added 12 October 2026): 0, not credited,
   * as every program before this was; otherwise each paid invoice of a
   * membership sold through a link earns while it falls within this many
   * months of the membership's start (1 is its first payment only,
   * RECURRING_ALWAYS for as long as the member pays), and a payment plan
   * earns on each of its payments. Worked out from the invoices on the
   * creator's own Stripe account when the book is read (lib/affiliates.ts).
   */
  recurring: number;
  /**
   * A bonus for each goal an affiliate reaches in a calendar month: so many
   * sales that earn, and the amount, in the store's currency. Up to three,
   * each paid once a month it is reached, and gone again if refunds take the
   * month back under it.
   */
  bonuses: AffiliateBonus[];
  /**
   * Whether affiliates may run paid search ads on the store's name. Off: a
   * click that came from one (Google's gclid, Microsoft's msclkid, or a link
   * tagged cpc) holds that affiliate's commission until the creator looks.
   */
  paidSearch: boolean;
  /**
   * The second tier (added 13 October 2026): 0, none, as every programme
   * before it; otherwise the percent of each sale an affiliate earns on top
   * when the sale was brought by somebody who joined through their
   * invitation link. Paid by the creator, beside the first affiliate's own
   * share and never out of it. Fixed for each recruit at the moment they
   * join (Affiliate.by), so changing it later never rewrites what somebody
   * was promised. One level only: nobody earns on the people their recruits
   * bring.
   */
  secondTier: number;
  /**
   * Pay per lead (added 18 October 2026, lib/affiliate-lead-rules.ts): a
   * fixed commission on each confirmed lead an affiliate brings, beside the
   * share of each sale. Off ("none") for every programme before it.
   */
  lead: LeadSetting;
  /**
   * Days of notice before a lower commission or a shorter window applies
   * (630 [HN6](2), lib/affiliate-notice.ts): 0 for none, else 3 to 90.
   * Missing on every program saved before it existed: none, as they were.
   */
  notice?: number;
  /**
   * A cut announced and not yet in force: the whole set of terms that takes
   * over on its day. Until then `percent`, `rates` and `days` are the old
   * ones; read on or after the day, they are these (parseAffiliateSetting).
   */
  pending?: PendingTerms | null;
};

/** The choices for the second tier, in percent; 0 is "none". */
export const SECOND_TIER_OPTIONS = [0, 2, 3, 5, 10, 15, 20] as const;

export type AffiliateBonus = { sales: number; cents: number };

/** As long as the member keeps paying. */
export const RECURRING_ALWAYS = 1200;
/** The choices a creator has for memberships, in months; 0 is "not credited". */
export const RECURRING_OPTIONS = [0, 1, 3, 6, 12, 24, RECURRING_ALWAYS] as const;
export const MAX_BONUSES = 3;
export const MAX_BONUS_SALES = 1000;
/** In the currency's smallest unit: 1 to 10,000 in it. */
export const MIN_BONUS_CENTS = 100;
export const MAX_BONUS_CENTS = 1_000_000;

/** The published limits. */
export const MIN_COMMISSION = 1;
export const MAX_COMMISSION = 90;
export const MIN_COOKIE_DAYS = 1;
/**
 * The longest window a creator can ask for, in days.
 *
 * 400 because that is the most any browser keeps today — Chrome caps every
 * cookie at 400 days from when it is set and shortens a longer one without
 * telling the site (Chrome 104, August 2022). Asking for more would be writing
 * down a number the browser quietly throws away.
 *
 * But this figure is NOT a promise, and nothing user-facing may turn it into
 * one. That is the whole point of the paragraph you are reading. A cookie's
 * life is decided by browser policy, and browser policy changes without
 * telling us either: the cap could rise, in which case this number is merely
 * conservative and costs a creator a few days, or it could fall, in which case
 * a promise built on it becomes a lie printed on the site — and nobody here is
 * going to be reading browser release notes to notice which.
 *
 * So the wording everywhere is conditional and self-correcting: up to N days,
 * for as long as the buyer's browser keeps it, browsers set their own limit.
 * That sentence stays true at 400, at 500 and at 90, and so never needs
 * revisiting. tests/affiliate-bond.test.ts fails if it is ever replaced by a
 * flat guarantee.
 *
 * The promise with no time limit is a different mechanism on purpose: the bond
 * between a buyer and their affiliate (lib/affiliate-bond.ts), which lives in
 * our own records, where no browser reaches. Hotmart's "for ever" is written
 * on a cookie, and a cookie is the one place that promise cannot be kept.
 */
export const MAX_COOKIE_DAYS = 400;
/** The last day of the month that exists in every month. */
export const MAX_PAYDAY = 28;
/** No day promised. */
export const NO_PAYDAY = 0;
export const MAX_HOLD_DAYS = 90;
/** How many people one store's programme may hold, applications included. */
export const MAX_AFFILIATES = 1_000;

export const NO_AFFILIATES: AffiliateSetting = {
  enabled: false,
  percent: 20,
  days: 30,
  rule: "last",
  rates: {},
  payday: NO_PAYDAY,
  hold: 0,
  buyers: false,
  directory: false,
  numbers: false,
  kit: true,
  lifetime: false,
  contacts: false,
  recurring: 0,
  bonuses: [],
  paidSearch: false,
  secondTier: 0,
  lead: NO_LEADS,
  notice: 0,
  pending: null,
};

/** The goals as given, each whole and in range, the fewest sales first; null when any is not. */
export function readBonuses(raw: unknown): AffiliateBonus[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_BONUSES) return null;
  const out: AffiliateBonus[] = [];
  for (const item of raw) {
    const value = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const sales = Number(value.sales);
    const cents = Number(value.cents);
    if (!Number.isInteger(sales) || sales < 1 || sales > MAX_BONUS_SALES) return null;
    if (!Number.isInteger(cents) || cents < MIN_BONUS_CENTS || cents > MAX_BONUS_CENTS) return null;
    if (out.some((b) => b.sales === sales)) return null;
    out.push({ sales, cents });
  }
  return out.sort((a, b) => a.sales - b.sales);
}

const whole = (value: unknown, min: number, max: number): number | null => {
  const n = typeof value === "string" && value.trim() ? Number(value.trim()) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max ? n : null;
};

/** Whatever came back from storage or from the studio, made safe to use. */
export function parseAffiliateSetting(raw: unknown, now: number = Date.now()): AffiliateSetting {
  if (!raw || typeof raw !== "object") return { ...NO_AFFILIATES, rates: {} };
  const value = raw as Record<string, unknown>;
  const rates: Record<string, number> = {};
  if (value.rates && typeof value.rates === "object" && !Array.isArray(value.rates)) {
    for (const [id, rate] of Object.entries(value.rates as Record<string, unknown>).slice(0, 200)) {
      // 0 is allowed here, and only here: it takes one product out.
      const n = whole(rate, 0, MAX_COMMISSION);
      if (/^[a-z0-9]{6,40}$/.test(id) && n !== null) rates[id] = n;
    }
  }
  const setting: AffiliateSetting = {
    enabled: value.enabled === true,
    percent: whole(value.percent, MIN_COMMISSION, MAX_COMMISSION) ?? NO_AFFILIATES.percent,
    days: whole(value.days, MIN_COOKIE_DAYS, MAX_COOKIE_DAYS) ?? NO_AFFILIATES.days,
    // Missing on every programme written down before the rule existed, and
    // they were all last click, which is what missing means here.
    rule: value.rule === "first" ? "first" : "last",
    rates,
    // Both are new, and every programme written down before they existed has
    // neither. Missing means no promised day and no wait, which is what those
    // programmes have always done.
    payday: whole(value.payday, NO_PAYDAY, MAX_PAYDAY) ?? NO_AFFILIATES.payday,
    hold: whole(value.hold, 0, MAX_HOLD_DAYS) ?? NO_AFFILIATES.hold,
    buyers: value.buyers === true,
    // Consent is given, never assumed: anything but an explicit yes is a no.
    directory: value.directory === true,
    numbers: value.numbers === true,
    // Missing on every program saved before it existed: on, as for a new one.
    kit: value.kit !== false,
    // Likewise: a programme already running is not quietly re-pointed.
    lifetime: value.lifetime === true,
    // Off on every program saved before it existed, and off whenever leads are
    // not paid: kept on under "no leads", it would turn itself back on unseen
    // the day leads are paid again (creditsContacts).
    contacts: value.contacts === true && parseLeadSetting(value.lead).kind !== "none",
    // Every programme before these existed credited no membership, paid no
    // bonus and held nothing for paid search: missing means the same.
    recurring: (RECURRING_OPTIONS as readonly number[]).includes(Number(value.recurring)) ? Number(value.recurring) : 0,
    bonuses: readBonuses(value.bonuses) ?? [],
    paidSearch: value.paidSearch === true,
    // Missing on every programme saved before it existed: none.
    secondTier: (SECOND_TIER_OPTIONS as readonly number[]).includes(Number(value.secondTier)) ? Number(value.secondTier) : 0,
    // Missing on every programme saved before it existed: no lead commission.
    lead: parseLeadSetting(value.lead),
    notice: readNoticeDays(value.notice),
    pending: null,
  };
  // A cut whose day has come is the terms from then on; before it, the old ones hold.
  const pending = readPending(value.pending, { minPercent: MIN_COMMISSION, maxPercent: MAX_COMMISSION, minDays: MIN_COOKIE_DAYS, maxDays: MAX_COOKIE_DAYS });
  if (pending && now / 1000 >= pending.from) return { ...setting, percent: pending.percent, rates: { ...pending.rates }, days: pending.days };
  return { ...setting, pending };
}

/** "1st", "2nd", "23rd" — the day as it is said in American English. */
export function ordinal(day: number): string {
  const rest = day % 100;
  if (rest >= 11 && rest <= 13) return `${day}th`;
  const last = day % 10;
  return `${day}${last === 1 ? "st" : last === 2 ? "nd" : last === 3 ? "rd" : "th"}`;
}

/**
 * The next day the creator pays, counted in UTC, or null when they promised
 * no day. Today counts: on the day itself the answer is today, which is what
 * both the affiliate's page and the morning's email need it to say.
 */
export function nextPayday(payday: number, now = new Date()): Date | null {
  if (payday < 1 || payday > MAX_PAYDAY) return null;
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const due = new Date(Date.UTC(year, month, payday));
  if (now.getUTCDate() > payday) return new Date(Date.UTC(year, month + 1, payday));
  return due;
}

/** That date written out: "October 1, 2026". */
export function paydayWords(date: Date): string {
  return date.toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });
}

/**
 * The promise in one sentence, for the affiliate to read before they apply
 * and every time they look afterward. When no day is promised it says that
 * plainly rather than dressing it up: an affiliate is owed the truth about
 * when they will be paid, including when the answer is "no fixed day".
 */
export function payoutPromise(setting: AffiliateSetting, storeName: string): string {
  const wait =
    setting.hold > 0
      ? ` A sale is payable ${setting.hold} ${setting.hold === 1 ? "day" : "days"} after it is made, so a refund in that time comes off it first.`
      : "";
  if (setting.payday < 1) {
    return `${storeName} has not set a payment day, and pays when they choose.${wait}`;
  }
  return `${storeName} pays on the ${ordinal(setting.payday)} of each month.${wait}`;
}

/** What an affiliate earns on this product, in percent; 0 when it is left out. */
export function commissionRate(setting: AffiliateSetting, productId: string, affiliateRate: number | null = null): number {
  const own = setting.rates[productId];
  // A share set for one affiliate (lib/affiliates.ts, Affiliate.rate) replaces
  // the store's and each product's — except on a product set to 0%, which the
  // creator took out of the program and which stays out for everyone.
  if (affiliateRate !== null) return own === 0 ? 0 : affiliateRate;
  return typeof own === "number" ? own : setting.percent;
}

/** What a percentage of an amount comes to, in whole cents, rounded down. */
export function commissionOn(baseCents: number, percent: number): number {
  if (baseCents <= 0 || percent <= 0) return 0;
  return Math.floor((baseCents * percent) / 100);
}

/** The code an affiliate's link carries: ?via=<code>. */
export const AFFILIATE_CODE_PATTERN = /^[a-z0-9]{3,20}$/;

/**
 * The first-party cookie a click leaves, one per store, named after it so a
 * visitor sent to two stores keeps both. It holds the code and the time of
 * the click; the checkout decides from those whether it still counts.
 */
export function viaCookieName(handle: string): string {
  return `nl_via_${handle.replace(/[^a-z0-9._-]/g, "")}`;
}

/** The longest any store's window can be, so the cookie never outlives it. */
export const VIA_COOKIE_SECONDS = MAX_COOKIE_DAYS * 24 * 60 * 60;

/** One click on one affiliate's link: whose code, and when. */
export type Click = { code: string; at: number };

/**
 * What the cookie holds, now that a store can earn its sales on the first
 * click instead of the last.
 *
 * `last` is the most recent link followed, which is all the cookie used to
 * carry. `first` is the earliest one still remembered, kept so a store set to
 * first click has something to credit — a cookie that only ever held the
 * latest click cannot answer who found the buyer.
 *
 * On a cookie written before `first` existed the two are the same click, which
 * is the truth about what is known of that visitor.
 */
export type Via = { last: Click; first: Click };

const ONE = /^([a-z0-9]{3,20})\.(\d{9,11})$/;

/** Reads the cookie, or null when there is nothing usable in it. */
export function readViaCookie(raw: string | undefined): Via | null {
  if (!raw) return null;
  // "<last>~<first>", and a bare "<last>" from before the first was kept.
  const [latest, earliest] = raw.split("~", 2);
  const lastMatch = latest?.match(ONE);
  if (!lastMatch) return null;
  const last: Click = { code: lastMatch[1], at: Number(lastMatch[2]) };
  const firstMatch = earliest?.match(ONE);
  const first: Click = firstMatch ? { code: firstMatch[1], at: Number(firstMatch[2]) } : last;
  // A first click later than the last one is a cookie somebody has edited.
  return { last, first: first.at <= last.at ? first : last };
}

/**
 * The cookie to write for a click on `code`, keeping whatever first click the
 * visitor already carries.
 *
 * Nothing here decides whether the code is real or whether the window has
 * passed: both are the checkout's to decide, against the store's own setting,
 * which this cannot see. All it does is remember both ends of the journey.
 */
export function viaCookieValue(existing: string | undefined, code: string, nowSeconds: number): string {
  const at = Math.floor(nowSeconds);
  const before = readViaCookie(existing);
  const first = before?.first ?? { code, at };
  return `${code}.${at}~${first.code}.${first.at}`;
}

/**
 * Whether a purchase that nothing else credits goes to the affiliate who
 * brought the buyer as a confirmed lead (630 [HN6](1)). Only while the program
 * pays per lead: that is the only time a contact is confirmed and written down
 * as an affiliate's (lib/affiliate-leads.ts recordLead), so a switch that could
 * find nobody is not offered or promised.
 */
export function creditsContacts(setting: Pick<AffiliateSetting, "enabled" | "contacts" | "lead">): boolean {
  return setting.enabled && setting.contacts === true && setting.lead.kind !== "none";
}

/** The sentence added to the rule when a program credits its affiliates' contacts (creditsContacts). */
export const CONTACTS_RULE =
  "A one-off purchase not credited to an affiliate's link, an affiliate's code or an earlier purchase goes to the affiliate who brought the buyer as a confirmed lead before they bought, on any device and with no cookie involved.";

/**
 * The sentence the affiliate and the creator both read about the rule.
 *
 * The window is stated conditionally — up to so many days, for as long as the
 * browser keeps the cookie — and never as a flat guarantee, because how long a
 * browser keeps a cookie is browser policy and changes without notice. The
 * unconditional half of this sentence is the bond, which is ours and does not
 * expire. Keeping those two apart is what means nobody has to watch a browser
 * release note to know whether this page is still true.
 */
export function attributionWords(setting: AffiliateSetting): string {
  const window = `up to ${setting.days} ${setting.days === 1 ? "day" : "days"}`;
  const kept = "for as long as the buyer's browser keeps the cookie — browsers set their own limit on that and shorten a long one without telling the site";
  const rule =
    setting.rule === "first"
      ? `The first affiliate link a buyer follows earns the sale, ${window} after that first click and ${kept}, even if they follow somebody else's link later.`
      : `The last affiliate link a buyer follows earns the sale, ${window} after that click and ${kept}.`;
  const withBond = setting.lifetime
    ? `${rule} None of that applies once a sale has been credited: from then on the buyer stays with that affiliate, and everything the person buys afterward earns them, with no time limit, on any device, with no cookie involved at all.`
    : rule;
  return creditsContacts(setting) ? `${withBond} ${CONTACTS_RULE}` : withBond;
}
