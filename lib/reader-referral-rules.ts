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
 *   - The personal code is an HMAC of the store and the person's address, so
 *     it is the same however the address is typed and never shows it. The
 *     link carries only the code; the caller keeps which person a code is.
 *   - A friend counts only when every check says yes: confirmed by the emailed
 *     link, consented to the creator's emails, still subscribed, not on the
 *     list before, not a disposable address, past the existing bot check, and
 *     not the person who shared it (a +tag or Gmail dots do not make a new
 *     person). A no on any check refuses. Anything else unknown waits and
 *     never counts. The same friend counts once; records about one friend that
 *     disagree count at their least favorable.
 *   - A milestone is given once per person, by its count. A milestone already
 *     given is never taken back, and editing a reward does not give it again.
 *   - What the person who shared sees has numbers only, never an address.
 *
 * No read, write, email or model call happens here. Storing the program and
 * the sign-ups, the link, the emails (counted against the plan's own email
 * allowance) and the privacy and terms wording come with the next units.
 */
import { createHmac } from "node:crypto";

export const MAX_MILESTONES = 5;
export const MAX_MILESTONE_COUNT = 1000;
/** Records about one referrer read at once; more is refused, never cut. */
export const MAX_REFERRAL_EVENTS = 5000;
export const REFERRAL_CODE = /^[A-Za-z0-9_-]{16}$/;
const REWARD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MIN_SECRET = 32;
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

/**
 * One person, however the address is typed: trimmed, lower case, without a
 * +tag, and for Gmail without dots. Null when it is not an address.
 */
export function referralAddress(email: string): string | null {
  if (typeof email !== "string") return null;
  const typed = email.trim().toLowerCase();
  if (typed.length === 0 || typed.length > MAX_ADDRESS || /\s/.test(typed)) return null;
  const parts = typed.split("@");
  if (parts.length !== 2) return null;
  let [local, domain] = parts;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return null;
  local = local.split("+")[0];
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  if (local.length === 0) return null;
  return `${local}@${domain}`;
}

/** The person's code for this store: stable, private, 16 characters. Null when it cannot be made safely. */
export function referralCode(secret: string, storeId: string, email: string): string | null {
  if (typeof secret !== "string" || secret.length < MIN_SECRET) return null;
  if (typeof storeId !== "string" || storeId.length === 0) return null;
  const address = referralAddress(email);
  if (!address) return null;
  return createHmac("sha256", secret).update(`reader-referral:v1:${storeId}:${address}`).digest("base64url").slice(0, 16);
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

/** How many friends of this referrer count, wait or were refused. Refused whole when the list cannot be trusted. */
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
  for (const v of byFriend.values()) tally[v] += 1;
  return { ok: true, tally };
}

const wholeCount = (counted: number) => typeof counted === "number" && Number.isInteger(counted) && counted >= 0;

/** Milestones this person has reached and not been given yet, in order. Each count is given once. */
export function dueMilestones(program: ReferralProgram, counted: number, given: readonly number[]): Milestone[] {
  if (!wholeCount(counted)) return [];
  const done = new Set(given);
  return program.milestones.filter((m) => m.count <= counted && !done.has(m.count)).map((m) => ({ count: m.count, reward: { ...m.reward } }));
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
  const upcoming = program.milestones.find((m) => !done.has(m.count) && m.count > counted);
  return {
    counted,
    pending,
    reached,
    next: upcoming ? { count: upcoming.count, left: upcoming.count - counted, reward: { ...upcoming.reward } } : null,
  };
}
