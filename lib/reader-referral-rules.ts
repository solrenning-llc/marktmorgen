/**
 * Reader referrals, as rules only: 118 [F2-READER-REFERRALS] and 267 [KT1],
 * one implementation for both items.
 *
 * A creator offers the people on their list a personal link. When a friend
 * signs up through it and confirms their address, the person who shared it
 * moves toward milestones the creator set, for example 3 friends for a free
 * guide and 10 for a coupon.
 *
 * What this file decides, and nothing else:
 *
 *   - A program has 1 to MAX_MILESTONES milestones, each a whole count from 1
 *     to MAX_MILESTONE_COUNT, going up. A reward is one of the creator's own
 *     products or one of the creator's own coupons, checked against the lists
 *     the caller passes in. Never money: no cash, credit or payout of any kind,
 *     so Marktmorgen never holds or pays anything for a referral. Any field
 *     this file does not know is refused, never ignored.
 *   - The personal code is an HMAC of the store and the person's address,
 *     each field prefixed by its length so one can never run into the other,
 *     so it is the same however the address is typed and never shows it. A
 *     short secret, or one of few distinct characters, gives no code. The
 *     link carries only the code; the caller keeps which person a code is.
 *   - One person is one address: lower case, no +tag, Gmail without dots,
 *     and a provider's equivalent domains (iCloud, Proton, a Fastmail
 *     subdomain) folded into one. An address with any character outside
 *     printable ASCII (invisible, look-alike, accented) is refused, so an
 *     address that looks the same can never be a new person.
 *   - A friend counts only when every check says yes: confirmed by the emailed
 *     link, consented to the creator's emails, still subscribed, not on the
 *     list before, not a disposable address, past the existing bot check, and
 *     not the person who shared it (a +tag or Gmail dots do not make a new
 *     person). A no on any check refuses. Anything else unknown waits and
 *     never counts. The same friend counts once; records about one friend that
 *     disagree count at their least favorable. On a domain that is not a
 *     public provider (COMMON_PROVIDERS), where whoever holds it can make any
 *     number of addresses, at most MAX_FRIENDS_PER_OWN_DOMAIN friends count
 *     per domain (its subdomains included) and the rest wait.
 *   - What was given is kept as the friend counts at which each reward was
 *     given. A step is due only past the highest count already rewarded and
 *     only beyond the number of rewards already given, so moving, adding or
 *     editing a milestone never pays a step again, and nobody gets more
 *     rewards than the program has steps. Nothing given is ever taken back.
 *   - What the person who shared sees has numbers only, never an address.
 *
 * No read, write, email or model call happens here. Storing the program and
 * the sign-ups, the link, the emails (counted against the plan's own email
 * allowance) and the privacy and terms wording come with the next units.
 */
import { createHmac } from "node:crypto";
import { COMMON_PROVIDERS } from "@/lib/email-typo";

export const MAX_MILESTONES = 5;
export const MAX_MILESTONE_COUNT = 1000;
/** Records about one referrer read at once; more is refused, never cut. */
export const MAX_REFERRAL_EVENTS = 5000;
export const REFERRAL_CODE = /^[A-Za-z0-9_-]{16}$/;
const REWARD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MIN_SECRET = 32;
/** Distinct characters a referral secret needs, besides its length. */
export const MIN_SECRET_DISTINCT = 8;
/** Friends counted on one domain that is not a public provider; the rest wait. */
export const MAX_FRIENDS_PER_OWN_DOMAIN = 2;
const MAX_ADDRESS = 254;

export type ReferralReward = { kind: "product"; productId: string } | { kind: "coupon"; couponId: string };
export type Milestone = { count: number; reward: ReferralReward };
export type ReferralProgram = { milestones: Milestone[] };
/** What the creator has today: products that can be handed over free, and live coupons. */
export type OwnRewards = { products: ReadonlySet<string>; coupons: ReadonlySet<string> };
export type ProgramProblem = "none" | "shape" | "too-many" | "count" | "order" | "reward" | "money" | "not-yours";

/** Reward kinds that would be money. Named so a refusal says why. */
const MONEY_KINDS = new Set(["cash", "money", "credit", "payout", "gift_card", "store_credit", "balance", "transfer"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value);

function readReward(raw: unknown, own: OwnRewards): { ok: true; reward: ReferralReward } | { ok: false; reason: ProgramProblem } {
  if (!isRecord(raw) || typeof raw.kind !== "string") return { ok: false, reason: "shape" };
  if (MONEY_KINDS.has(raw.kind)) return { ok: false, reason: "money" };
  if (raw.kind === "product") {
    if (!onlyKeys(raw, ["kind", "productId"]) || typeof raw.productId !== "string" || !REWARD_ID.test(raw.productId)) return { ok: false, reason: "shape" };
    if (!own.products.has(raw.productId)) return { ok: false, reason: "not-yours" };
    return { ok: true, reward: { kind: "product", productId: raw.productId } };
  }
  if (raw.kind === "coupon") {
    if (!onlyKeys(raw, ["kind", "couponId"]) || typeof raw.couponId !== "string" || !REWARD_ID.test(raw.couponId)) return { ok: false, reason: "shape" };
    if (!own.coupons.has(raw.couponId)) return { ok: false, reason: "not-yours" };
    return { ok: true, reward: { kind: "coupon", couponId: raw.couponId } };
  }
  return { ok: false, reason: "reward" };
}

/** The creator's program as kept or as sent, checked whole. Null or no milestones means off. */
export function readReferralProgram(raw: unknown, own: OwnRewards): { ok: true; program: ReferralProgram } | { ok: false; reason: ProgramProblem } {
  if (raw === null || raw === undefined) return { ok: false, reason: "none" };
  if (!isRecord(raw) || !onlyKeys(raw, ["milestones"]) || !Array.isArray(raw.milestones)) return { ok: false, reason: "shape" };
  const list: unknown[] = raw.milestones;
  if (list.length === 0) return { ok: false, reason: "none" };
  if (list.length > MAX_MILESTONES) return { ok: false, reason: "too-many" };
  const milestones: Milestone[] = [];
  for (const item of list) {
    if (!isRecord(item) || !onlyKeys(item, ["count", "reward"])) return { ok: false, reason: "shape" };
    const { count } = item;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > MAX_MILESTONE_COUNT) return { ok: false, reason: "count" };
    const previous = milestones[milestones.length - 1];
    if (previous && count <= previous.count) return { ok: false, reason: "order" };
    const reward = readReward(item.reward, own);
    if (!reward.ok) return reward;
    milestones.push({ count, reward: reward.reward });
  }
  return { ok: true, program: { milestones } };
}

/** Domains one provider delivers to the same mailbox, folded into one. */
const SAME_MAILBOX: Readonly<Record<string, string>> = {
  "googlemail.com": "gmail.com",
  "me.com": "icloud.com",
  "mac.com": "icloud.com",
  "protonmail.com": "proton.me",
  "protonmail.ch": "proton.me",
  "pm.me": "proton.me",
};
/** Fastmail delivers anything@user.fastmail.com to user@fastmail.com. */
const FASTMAIL_SUBDOMAIN = /^([a-z0-9-]+)\.fastmail\.com$/;
/** Printable ASCII only: no space, control, invisible, look-alike or accented character. */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const PUBLIC_PROVIDERS = new Set(COMMON_PROVIDERS.map((domain) => SAME_MAILBOX[domain] ?? domain));

/**
 * One person, however the address is typed: trimmed, lower case, without a
 * +tag, for Gmail without dots, and on a provider's equivalent domains as
 * one. Null when it is not an address or holds a character outside
 * printable ASCII.
 */
export function referralAddress(email: string): string | null {
  if (typeof email !== "string") return null;
  const trimmed = email.trim();
  // Checked before lower case, which would turn some look-alikes (the Kelvin sign) into ASCII.
  if (trimmed.length === 0 || trimmed.length > MAX_ADDRESS || !PRINTABLE_ASCII.test(trimmed)) return null;
  const parts = trimmed.toLowerCase().split("@");
  if (parts.length !== 2) return null;
  let [local, domain] = parts;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return null;
  local = local.split("+")[0];
  if (local.length === 0) return null;
  const fastmailUser = FASTMAIL_SUBDOMAIN.exec(domain);
  if (fastmailUser) {
    local = fastmailUser[1];
    domain = "fastmail.com";
  }
  domain = SAME_MAILBOX[domain] ?? domain;
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  if (local.length === 0) return null;
  return `${local}@${domain}`;
}

/**
 * The bucket a friend's address falls in for the own-domain ceiling: null on
 * a public provider, otherwise the domain's last two labels, so every
 * subdomain of one domain is one bucket (a shared ending such as co.uk is one
 * bucket too, which only makes more friends wait, never fewer).
 */
function ownDomainBucket(address: string): string | null {
  const domain = address.slice(address.lastIndexOf("@") + 1);
  if (PUBLIC_PROVIDERS.has(domain)) return null;
  return domain.split(".").slice(-2).join(".");
}

/** The person's code for this store: stable, private, 16 characters. Null when it cannot be made safely. */
export function referralCode(secret: string, storeId: string, email: string): string | null {
  if (typeof secret !== "string" || secret.length < MIN_SECRET || new Set(secret).size < MIN_SECRET_DISTINCT) return null;
  if (typeof storeId !== "string" || storeId.length === 0) return null;
  const address = referralAddress(email);
  if (!address) return null;
  // Each field carries its length, so "s:a" + "b@x" and "s" + "a:b@x" never meet.
  const message = `reader-referral:v1:${storeId.length}:${storeId}:${address.length}:${address}`;
  return createHmac("sha256", secret).update(message).digest("base64url").slice(0, 16);
}

/**
 * What the caller knows about one friend who signed up through a link. A
 * check is true (yes), false (no), or anything else (unknown).
 */
export type ReferredSignup = {
  email: string;
  /** Confirmed by the emailed link (double opt-in). */
  confirmed: boolean | null;
  /** Agreed to the creator's emails themselves. */
  consented: boolean | null;
  /** Still on the list now. */
  subscribed: boolean | null;
  /** Was on the list before this link. */
  wasOnList: boolean | null;
  disposable: boolean | null;
  /** Passed the existing bot check. */
  human: boolean | null;
};
export type ReferralTally = { counted: number; pending: number; refused: number };
type Verdict = "counted" | "pending" | "refused";
const RANK: Record<Verdict, number> = { counted: 0, pending: 1, refused: 2 };

function verdict(signup: ReferredSignup, referrer: string): { address: string | null; verdict: Verdict } {
  const address = isRecord(signup) ? referralAddress(signup.email) : null;
  if (!address || address === referrer) return { address, verdict: "refused" };
  // Each check as "yes" must be true; a definite opposite refuses; anything else is unknown.
  const checks: [unknown, boolean][] = [
    [signup.confirmed, true],
    [signup.consented, true],
    [signup.subscribed, true],
    [signup.wasOnList, false],
    [signup.disposable, false],
    [signup.human, true],
  ];
  if (checks.some(([value, yes]) => value === !yes)) return { address, verdict: "refused" };
  if (checks.some(([value, yes]) => value !== yes)) return { address, verdict: "pending" };
  return { address, verdict: "counted" };
}

/**
 * How many friends of this referrer count, wait or were refused. Refused
 * whole when the list cannot be trusted. On a domain that is not a public
 * provider, the first MAX_FRIENDS_PER_OWN_DOMAIN friends that count, in the
 * order given, count; the rest wait.
 */
export function tallyReferrals(referrerEmail: string, signups: readonly ReferredSignup[]): { ok: true; tally: ReferralTally } | { ok: false } {
  const referrer = referralAddress(referrerEmail);
  if (!referrer || !Array.isArray(signups) || signups.length > MAX_REFERRAL_EVENTS) return { ok: false };
  const byFriend = new Map<string, Verdict>();
  let invalid = 0;
  for (const signup of signups) {
    const { address, verdict: v } = verdict(signup, referrer);
    if (!address) {
      invalid += 1;
      continue;
    }
    const before = byFriend.get(address);
    // Records about one friend that disagree count at their least favorable.
    byFriend.set(address, before === undefined || RANK[v] > RANK[before] ? v : before);
  }
  const tally: ReferralTally = { counted: 0, pending: 0, refused: invalid };
  const perOwnDomain = new Map<string, number>();
  for (const [address, v] of byFriend) {
    const bucket = v === "counted" ? ownDomainBucket(address) : null;
    if (bucket !== null) {
      const already = perOwnDomain.get(bucket) ?? 0;
      if (already >= MAX_FRIENDS_PER_OWN_DOMAIN) {
        tally.pending += 1;
        continue;
      }
      perOwnDomain.set(bucket, already + 1);
    }
    tally[v] += 1;
  }
  return { ok: true, tally };
}

const wholeCount = (counted: number) => typeof counted === "number" && Number.isInteger(counted) && counted >= 0;

/**
 * What was given, read: how many rewards and the highest friend count
 * rewarded. Null when the record is not a list of whole counts of at least
 * one, so nothing more is given until it is.
 */
function readGiven(given: readonly number[]): { steps: number; highest: number } | null {
  if (!Array.isArray(given) || given.length > MAX_MILESTONE_COUNT) return null;
  let highest = 0;
  for (const count of given) {
    if (!wholeCount(count) || count < 1) return null;
    highest = Math.max(highest, count);
  }
  return { steps: given.length, highest };
}

/** Whether a milestone, at its place in the program, can still be given to someone with this record. */
const stillToGive = (record: { steps: number; highest: number }, index: number, m: Milestone) => index >= record.steps && m.count > record.highest;

/**
 * Milestones this person has reached and not been given yet, in order.
 * `given` holds the friend count at which each reward was given, whatever
 * the program was then. A step is due only past the highest count already
 * rewarded and beyond the number of rewards already given, so no step is
 * paid twice after the creator changes the program.
 */
export function dueMilestones(program: ReferralProgram, counted: number, given: readonly number[]): Milestone[] {
  if (!wholeCount(counted)) return [];
  const record = readGiven(given);
  if (!record) return [];
  return program.milestones
    .filter((m, index) => m.count <= counted && stillToGive(record, index, m))
    .map((m) => ({ count: m.count, reward: { ...m.reward } }));
}

export type ReferrerView = {
  counted: number;
  pending: number;
  /** Counts of this program's milestones already given. */
  reached: number[];
  next: { count: number; left: number; reward: ReferralReward } | null;
};

/** What the person who shared the link sees: numbers and rewards, never an address. */
export function referrerView(program: ReferralProgram, tally: ReferralTally, given: readonly number[]): ReferrerView {
  const done = new Set(given);
  const counted = wholeCount(tally.counted) ? tally.counted : 0;
  const pending = wholeCount(tally.pending) ? tally.pending : 0;
  const reached = program.milestones.filter((m) => done.has(m.count)).map((m) => m.count);
  // The next step is one dueMilestones could still give; none while the record cannot be read.
  const record = readGiven(given);
  const upcoming = record ? program.milestones.find((m, index) => stillToGive(record, index, m) && m.count > counted) : undefined;
  return {
    counted,
    pending,
    reached,
    next: upcoming ? { count: upcoming.count, left: upcoming.count - counted, reward: { ...upcoming.reward } } : null,
  };
}
