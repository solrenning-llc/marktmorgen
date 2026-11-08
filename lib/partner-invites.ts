/**
 * A partnership offered to somebody who already has a store here.
 *
 * Inviting a partner normally goes by email: the terms are in the message,
 * and opening the link is how the person agrees to them (lib/affiliates.ts
 * invitePartner). That is right for somebody from outside, who has no other
 * place to be asked.
 *
 * It is the wrong shape when the invited partner is already a creator here,
 * because then there is a better place to ask them: their own studio. An
 * email is found or lost; a studio is opened on purpose. So the offer waits
 * there, with the share and the products written out, to be accepted or
 * declined.
 *
 * What this is NOT is a shortcut past the agreement. A share of every sale of
 * a product is a commercial arrangement, and the person taking it has to say
 * yes to the number. Recognising somebody as a customer of ours is a reason to
 * ask them somewhere better, never a reason to stop asking. Nothing is written
 * into the inviting store's programme until they accept.
 *
 * And this is the quiet part worth naming: every partnership between two
 * creators here ties both of them to the same place, through a relationship
 * neither of them wants to break. A hundred of those is a denser thing than a
 * hundred separate stores, and it is the one network effect that does not
 * require operating a public marketplace to get.
 *
 *   nl:pinv:<hash of email>   hash  invitation id -> the offer
 */
import { createHash, randomBytes } from "node:crypto";
import { normaliseEmail } from "@/lib/auth";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor, stringList } from "@/lib/redis-reply";
import { type PartnerShare, parsePartnerShare } from "@/lib/partner-share";

/** How long an unanswered offer stays in a studio before it lapses. */
export const INVITE_SECONDS = 30 * 24 * 60 * 60;
/** How many offers one creator may have waiting, so a studio cannot be flooded. */
export const MAX_WAITING = 20;
export const INVITE_ID = /^[0-9a-f]{12}$/;

const inviteKey = (email: string) =>
  `nl:pinv:${createHash("sha256").update(`nimbus-partner-invite:${normaliseEmail(email)}`).digest("hex").slice(0, 40)}`;

/** One partnership waiting for an answer, as the invited creator sees it. */
export type PartnerInvite = {
  id: string;
  /** The store offering it, by its id, so the offer survives a rename. */
  sid: string;
  /** What it was called when the offer was made, for the sentence they read. */
  storeName: string;
  handle: string;
  share: PartnerShare;
  /** The products by name, as they were when offered. */
  titles: string[];
  /** When it was offered, in ms. */
  at: number;
};

function parseInvite(raw: unknown): PartnerInvite | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Partial<PartnerInvite>;
    const share = parsePartnerShare(value.share);
    if (!share) return null;
    if (typeof value.id !== "string" || !INVITE_ID.test(value.id)) return null;
    if (typeof value.sid !== "string" || !value.sid) return null;
    return {
      id: value.id,
      sid: value.sid,
      storeName: typeof value.storeName === "string" ? value.storeName.slice(0, 120) : "A store",
      handle: typeof value.handle === "string" ? value.handle : "",
      share,
      titles: Array.isArray(value.titles) ? value.titles.filter((t): t is string => typeof t === "string").slice(0, 24) : [],
      at: typeof value.at === "number" ? value.at : 0,
    };
  } catch {
    return null;
  }
}

/** A hash's fields and values, from its flat list as HGETALL answers it (already checked to be whole). Pure. */
function pairs(list: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < list.length; i += 2) out.push([list[i], list[i + 1]]);
  return out;
}

export type OfferResult = { ok: true; id: string } | { ok: false; reason: "full" | "error" };

/**
 * Leaves the offer in the invited creator's studio. Replaces any earlier offer
 * from the same store, so changing your mind about the share leaves one
 * current proposal rather than a pile of them to choose between.
 */
export async function offerPartnership(
  email: string,
  invite: Omit<PartnerInvite, "id" | "at">,
): Promise<OfferResult> {
  if (!isRedisConfigured() || !email) return { ok: false, reason: "error" };
  const key = inviteKey(email);
  const waiting = await waitingFor(email);
  const mine = waiting.filter((w) => w.sid === invite.sid);
  if (waiting.length - mine.length >= MAX_WAITING) return { ok: false, reason: "full" };

  const id = randomBytes(6).toString("hex");
  const row: PartnerInvite = { ...invite, id, at: Date.now() };
  await redisPipeline([
    ...mine.map((old) => ["HDEL", key, old.id]),
    ["HSET", key, id, JSON.stringify(row)],
    ["EXPIRE", key, INVITE_SECONDS],
  ]);
  return { ok: true, id };
}

/**
 * Every offer waiting for this creator, newest first. A key that is not there
 * is no offers; a reply in any other shape, or a row that is not one this
 * code wrote under its own id, throws UnknownReplyError (rule 24), never read
 * as "none" or skipped, so an offer is never hidden by a failed read and the
 * cap in offerPartnership is never checked against a list that was not read.
 */
export async function waitingFor(email: string): Promise<PartnerInvite[]> {
  if (!isRedisConfigured() || !email) return [];
  const flat = stringList(repliesFor(await redisPipeline([["HGETALL", inviteKey(email)]]), 1)?.[0]);
  if (!flat || flat.length % 2 !== 0) throw new UnknownReplyError("the partnerships offered to a creator");
  return pairs(flat)
    .map(([field, raw]) => {
      const invite = parseInvite(raw);
      if (!invite || invite.id !== field) throw new UnknownReplyError("a partnership offered to a creator");
      return invite;
    })
    .sort((a, b) => b.at - a.at);
}

/** One offer, by id, or null. Read before acting on an answer. */
export async function waitingOne(email: string, id: string): Promise<PartnerInvite | null> {
  if (!INVITE_ID.test(id)) return null;
  const [raw] = await redisPipeline([["HGET", inviteKey(email), id]]);
  return parseInvite(raw);
}

/** Takes an offer out, whichever way it was answered. */
export async function answerInvite(email: string, id: string): Promise<boolean> {
  if (!isRedisConfigured() || !INVITE_ID.test(id)) return false;
  const [gone] = await redisPipeline([["HDEL", inviteKey(email), id]]);
  return Number(gone) === 1;
}

/** The sentence the invited creator reads, before they decide. */
export function offerWords(invite: PartnerInvite): string {
  const named = invite.titles.length ? invite.titles.join(", ") : `${invite.share.products.length} of their products`;
  return `${invite.storeName} is offering you ${invite.share.percent}% of every sale of ${named} — on every sale, not only the ones you send them.`;
}
