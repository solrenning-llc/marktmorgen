/**
 * The come-back email to members who stopped coming (added 12 October 2026;
 * the rule is lib/member-health-rules.ts, nudgeFits).
 *
 * Once a day, for every store that turned it on: its running members are
 * scored as the studio scores them (lib/member-health.ts), and a member at
 * risk only for being away — never opened the course or the community their
 * membership includes, or away from it 30 days and more — gets one email from
 * the store, with the way back in. Once per period they pay for, and only if
 * they agreed to hear from the creator and have not left the list: it goes
 * out as a list email, with the reason they get it, the one-click way off and
 * the creator's postal address.
 *
 *   nl:nudge:<statsId>:<sub>:<period end>   sent, 400 days
 *   nl:nudge:count:<statsId>:<yyyy-mm>      sent this month, 400 days
 *   nl:nudge:cursor                          where the last run stopped
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { platformKey } from "@/lib/stripe-account";
import { isSenderConfigured, sendEmail } from "@/lib/email";
import { type Store, storesAfter } from "@/lib/store";
import { sellsMemberships } from "@/lib/membership-manage";
import { fromLine, render } from "@/lib/mail";
import { tokensFor } from "@/lib/contacts";
import { storeBase } from "@/lib/purchase-email";
import { readListings } from "@/lib/catalog";
import { membershipWords } from "@/lib/buyer-words/membership";
import type { LanguageCode } from "@/lib/store-language";
import { nudgeFits } from "@/lib/member-health-rules";
import { type MemberRow, runningMembers, scoreMembers } from "@/lib/member-health";
import { suppressedKey, suppressionPrint } from "@/lib/suppression";

const CURSOR_KEY = "nl:nudge:cursor";
const KEEP_SECONDS = 400 * 86_400;
const sentKey = (statsId: string, sub: string, periodEnd: number) => `nl:nudge:${statsId}:${sub}:${periodEnd}`;
const countKey = (statsId: string, month: string) => `nl:nudge:count:${statsId}:${month}`;
const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);

/**
 * The period's mark, taken only while the member has no deletion print on the store's list, in one step (Codex L,
 * #4764): the job reads the list's tokens before it reaches each member, and an erasure that finished in between must
 * not get a notice, a period mark or a count. A list email, so any print refuses (it is lifted only by the person's
 * own yes again, lib/suppression.ts). KEYS[1] the period's mark, KEYS[2] the store's prints; ARGV[1] the member's
 * print, ARGV[2] the mark's value, ARGV[3] its seconds. 1: taken; 0: taken before; -1: erased, nothing written.
 * Billed as the EVAL, its HEXISTS and, when not erased, its SET; lib/redis-memory.ts runs it the same way.
 */
export const NUDGE_CLAIM = `-- marktmorgen:nudge-claim:v1
if redis.call("HEXISTS", KEYS[2], ARGV[1]) == 1 then return -1 end
if redis.call("SET", KEYS[1], ARGV[2], "NX", "EX", ARGV[3]) then return 1 end
return 0`;

/** The email, pure: what a member reads. */
export function nudgeEmail(input: { storeName: string; title: string; courseUrl: string; communityUrl: string; language?: LanguageCode }): { subject: string; body: string } {
  const m = membershipWords(input.language);
  return {
    subject: m.nudgeSubject(input.title).slice(0, 200),
    body: [
      m.nudgeLead(input.title),
      ...(input.courseUrl ? ["", m.nudgeCourse, input.courseUrl] : []),
      ...(input.communityUrl ? ["", m.nudgeCommunity, input.communityUrl] : []),
      "",
      m.nudgeReply(input.storeName),
    ].join("\n"),
  };
}

/** One store's members who stopped coming, each written to once per period. */
export async function nudgeStore(store: Store, deadline: number, now = Date.now()): Promise<number> {
  if (!store.nudge.on || !store.stripeAccountId || !store.statsId || !store.listId) return 0;
  const { rows } = await runningMembers(store);
  const members = (await scoreMembers(store, rows, now)).filter((m) => nudgeFits(m.score, m.factors) && m.periodEnd > 0);
  if (!members.length) return 0;
  // Only those who agreed to hear from the creator and have not left the list.
  const tokens = await tokensFor(store.listId, [...new Set(members.map((m) => m.email))], store.handle);
  const listings = new Map((await readListings(store, [...new Set(members.map((m) => m.product))]).catch(() => [])).map((p) => [p.id, p]));
  const statsId = store.statsId;
  const base = storeBase(store);
  let sent = 0;

  for (const member of members as MemberRow[]) {
    if (Date.now() >= deadline) break;
    const unsub = tokens.get(member.email);
    const listing = listings.get(member.product);
    if (!unsub || !listing) continue;
    const away = new Set(member.factors.map((f) => f.reason));
    const key = sentKey(statsId, member.sub, member.periodEnd);
    const claim = await redisPipeline([[
      "EVAL", NUDGE_CLAIM, 2, key, suppressedKey(store.listId), suppressionPrint(store.listId, member.email), String(now), KEEP_SECONDS,
    ]]);
    if (!Array.isArray(claim) || claim.length !== 1 || !Object.hasOwn(claim, 0) || (claim[0] !== 1 && claim[0] !== 0 && claim[0] !== -1)) {
      // The mark may already exist. Never send or delete it without proof
      // that this attempt owns it.
      throw new Error("Member notice ownership could not be confirmed");
    }
    // 0: another run took this period's mark. -1: the member was erased after
    // the tokens were read: no mark, no email and no count.
    if (claim[0] !== 1) continue;
    let accepted = false;
    try {
      const mail = nudgeEmail({
        storeName: store.name,
        title: listing.title,
        courseUrl: listing.course && (away.has("course-never") || away.has("course-30")) ? `${base}/course/${encodeURIComponent(listing.id)}` : "",
        communityUrl: away.has("community-never") || away.has("community-30") ? `${base}/community` : "",
        language: store.language as LanguageCode,
      });
      const withAddress = { ...store, mail: { fromName: store.mail?.fromName || store.name, address: store.nudge.address } };
      const rendered = render(withAddress, mail.subject, mail.body, unsub);
      const ok = await sendEmail({ meter: { by: "store", store: store, kind: "email" },
        from: fromLine(withAddress),
        to: member.email,
        subject: rendered.subject,
        text: rendered.text,
        replyTo: store.email,
        headers: rendered.headers,
        idempotencyKey: `nimbus-nudge:${statsId}:${member.sub}:${member.periodEnd}`,
      });
      if (ok) {
        accepted = true;
        sent += 1;
      } else {
        await redisPipeline([["DEL", key]]);
      }
    } catch (error) {
      await redisPipeline([["DEL", key]]).catch(() => {});
      console.error("sending a come-back email failed", store.handle, error);
    }
    if (accepted) {
      // The email went out: the period mark stays whatever happens to the
      // monthly count, so a lost count never sends the same member a second
      // notice in the same period. A count that fails is only a lower figure
      // on the studio page.
      const count = countKey(statsId, monthOf(now));
      await redisPipeline([
        ["INCR", count],
        ["EXPIRE", count, KEEP_SECONDS],
      ]).catch((error) => console.error("counting a come-back email failed", store.handle, error));
    }
  }
  return sent;
}

/** How many come-back emails a store sent this month. */
export async function nudgesThisMonth(store: Store, now = Date.now()): Promise<number> {
  if (!store.statsId || !isRedisConfigured()) return 0;
  const [n] = await redisPipeline([["GET", countKey(store.statsId, monthOf(now))]]);
  return Number(n) || 0;
}

/** The daily run: every store with it on, from where the last run stopped. */
export async function sendMemberNudges(deadline: number): Promise<{ stores: number; sent: number }> {
  const counts = { stores: 0, sent: 0 };
  if (!isRedisConfigured() || !platformKey() || !isSenderConfigured()) return counts;
  const [saved] = await redisPipeline([["GET", CURSOR_KEY]]);
  const [savedCursor, savedDone] = typeof saved === "string" ? saved.split("|") : ["0", "0"];
  let cursor = /^\d+$/.test(savedCursor ?? "") ? savedCursor : "0";
  let skip = Number(savedDone) || 0;
  while (Date.now() < deadline) {
    const { stores, next } = await storesAfter(cursor);
    let done = 0;
    for (const store of stores) {
      if (done < skip) {
        done += 1;
        continue;
      }
      if (Date.now() >= deadline) break;
      if (store.nudge.on && sellsMemberships(store)) {
        counts.stores += 1;
        try {
          counts.sent += await nudgeStore(store, deadline);
        } catch (error) {
          console.error("reading a store's members for come-back emails failed", store.handle, error);
        }
      }
      done += 1;
    }
    if (done < stores.length) {
      await redisPipeline([["SET", CURSOR_KEY, `${cursor}|${done}`]]);
      return counts;
    }
    skip = 0;
    cursor = next;
    if (next === "0") break;
  }
  await redisPipeline([["SET", CURSOR_KEY, `${cursor}|0`]]);
  return counts;
}
