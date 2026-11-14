import { createHash, randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { countNotice } from "@/lib/transparency";

/**
 * A company ceiling on the emails the notice form sends (lib/takedown.ts fileReport). Every notice is kept and answered
 * as received, whatever the ceiling: a notice under the DMCA (17 U.S.C. § 512(c)(3)) or the DSA (Art. 16) is never
 * refused. Up to REPORT_EMAILS_PER_DAY of them a day (UTC) go to the support inbox one by one, as before; past it,
 * each one waits in a queue, and once a day one digest email carries up to DIGEST_NOTICES of them, each with its own
 * link, the rest going in the next day's. So the form costs at most REPORT_EMAILS_PER_DAY + 1 company emails a day
 * however many networks send it, and every notice still reaches the inbox.
 *
 * What is kept in Redis for each notice is unchanged (its record and link, 400 and 60 days); the queue holds ids only.
 * Whether the records themselves need a ceiling is the owner's question, because refusing to keep a notice has a legal
 * effect.
 */
export const REPORT_EMAILS_PER_DAY = 40;
/** How many waiting notices one digest carries, so a digest stays a readable email. */
export const DIGEST_NOTICES = 100;

const DAY_SECONDS = 86_400;
const REPORT_SECONDS = 400 * DAY_SECONDS;
const TOKEN_SECONDS = 60 * DAY_SECONDS;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const reportKey = (id: string) => `nl:report:${id}`;
// The same key lib/takedown.ts keeps a notice's link under (tokenKey); held to it by tests/report-mail-ceiling.test.ts.
const tokenKey = (token: string) => `nl:report:t:${sha(`nimbus-takedown:${token}`)}`;
const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);
const mailDayKey = (day: string) => `nl:report:mailday:${day}`;
export const HELD_NOTICES_KEY = "nl:report:held";
const digestKey = (day: string) => `nl:report:digest:${day}`;

/**
 * Whether the notice `id` may have an email of its own now: "send" within the day's ceiling; "held" past it, its id
 * queued for the next digest; "unknown" when a reply is missing or of another shape (CX-123 rule 24), which sends
 * nothing.
 */
export async function reportEmailRoom(id: string, now = Date.now()): Promise<"send" | "held" | "unknown"> {
  const day = dayOf(now);
  let replies: unknown[] | null = null;
  try {
    replies = repliesFor(await redisPipeline([["INCR", mailDayKey(day)], ["EXPIRE", mailDayKey(day), 2 * DAY_SECONDS]]), 2);
  } catch {
    return "unknown";
  }
  const count = replies ? countOf(replies[0]) : null;
  if (count === null || count < 1) return "unknown";
  if (count <= REPORT_EMAILS_PER_DAY) return "send";
  try {
    const queued = repliesFor(await redisPipeline([["RPUSH", HELD_NOTICES_KEY, id], ["EXPIRE", HELD_NOTICES_KEY, REPORT_SECONDS]]), 2);
    const length = queued ? countOf(queued[0]) : null;
    return length !== null && length >= 1 ? "held" : "unknown";
  } catch {
    return "unknown";
  }
}

type HeldNotice = { id: string; kind?: unknown; url?: unknown; handle?: unknown; name?: unknown; email?: unknown; at?: unknown };

/**
 * Sends the day's digest of waiting notices, once a day (a mark per UTC day): up to DIGEST_NOTICES of the oldest, each
 * with a new link that acts on it, and says how many still wait. The ones sent are taken off the queue only once the
 * email was accepted; a failed send leaves them all for the next run. Nothing waiting sends nothing.
 */
export async function sendHeldNoticeDigest(origin: string, now = Date.now()): Promise<{ ok: boolean; sent: number; waiting: number }> {
  if (!isRedisConfigured() || !isSenderConfigured()) return { ok: false, sent: 0, waiting: 0 };
  const day = dayOf(now);
  const mine = claimValue(now);
  const claimed = await claimMark(digestKey(day), 2 * DAY_SECONDS, mine);
  if (claimed === "taken") return { ok: true, sent: 0, waiting: 0 };
  if (claimed === "unknown") return { ok: false, sent: 0, waiting: 0 };
  const letGo = async (result: { ok: boolean; sent: number; waiting: number }) => {
    await releaseMark(digestKey(day), mine);
    return result;
  };
  const read = repliesFor(await redisPipeline([["LRANGE", HELD_NOTICES_KEY, 0, DIGEST_NOTICES - 1], ["LLEN", HELD_NOTICES_KEY]]).catch(() => null), 2);
  const ids = read ? stringList(read[0]) : null;
  const waiting = read ? countOf(read[1]) : null;
  if (!ids || waiting === null) return letGo({ ok: false, sent: 0, waiting: 0 });
  if (ids.length === 0) return { ok: true, sent: 0, waiting: 0 };
  const records = repliesFor(await redisPipeline(ids.map((id) => ["GET", reportKey(id)])).catch(() => null), ids.length);
  if (!records) return letGo({ ok: false, sent: 0, waiting });
  const notices: { notice: HeldNotice; token: string }[] = [];
  records.forEach((raw, i) => {
    let notice: HeldNotice = { id: ids[i] };
    if (typeof raw === "string") {
      try {
        notice = { ...(JSON.parse(raw) as HeldNotice), id: ids[i] };
      } catch {
        // A record that cannot be read is still listed by its id, so it is looked at by hand.
      }
    }
    notices.push({ notice, token: randomBytes(24).toString("hex") });
  });
  const linked = repliesFor(await redisPipeline(notices.map(({ notice, token }) => ["SET", tokenKey(token), notice.id, "EX", TOKEN_SECONDS])).catch(() => null), notices.length);
  if (!linked || linked.some((reply) => reply !== "OK")) return letGo({ ok: false, sent: 0, waiting });
  const text = (value: unknown) => (typeof value === "string" ? value.slice(0, 300) : "");
  const lines = notices.flatMap(({ notice, token }, i) => [
    `${i + 1}. ${notice.kind === "copyright" ? "Copyright notice" : "Notice of illegal content"}${text(notice.handle) ? ` about @${text(notice.handle)}` : ""}`,
    `   Where: ${text(notice.url) || "(the record could not be read; open it by its id)"}`,
    `   From: ${text(notice.name)} <${text(notice.email)}>, ${text(notice.at)}`,
    `   Open it to act on it (the link works for 60 days): ${origin}/takedown/${token}`,
    `   Notice ${notice.id}`,
    "",
  ]);
  const left = Math.max(0, waiting - notices.length);
  const sent = await sendEmail({
    meter: { by: "company" },
    from: NIMBUS_FROM,
    to: SUPPORT_EMAIL,
    subject: `${notices.length} notices from the report form, past the day's ${REPORT_EMAILS_PER_DAY} emails`,
    text: [
      `More notices came through ${origin}/report than the ${REPORT_EMAILS_PER_DAY} sent one by one a day. Each was kept and its sender told it was received; here are ${notices.length} of them, oldest first.`,
      "",
      ...lines,
      left > 0 ? `${left} more wait for the next digest.` : "No more wait.",
    ].join("\n"),
    idempotencyKey: `report-digest-${day}`,
  }).catch(() => false);
  if (!sent) return letGo({ ok: false, sent: 0, waiting });
  await redisPipeline([["LTRIM", HELD_NOTICES_KEY, notices.length, -1]]).catch((error: unknown) => console.error("trimming the held notices failed", error));
  // The public transparency page counts a notice once it reached the inbox (lib/takedown.ts fileReport).
  for (const { notice } of notices) await countNotice(notice.kind === "copyright" ? "copyright" : "other").catch(() => undefined);
  return { ok: true, sent: notices.length, waiting: left };
}
