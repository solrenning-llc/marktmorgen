/**
 * 543 [CM2] unit 2: telling the creator, once a day, that posts or comments
 * wait for their approval (added 6 November 2026).
 *
 * Read once a day by the courses job (app/api/cron/courses), for the stores
 * whose community held something lately (storesWithHeld). For each one: the
 * queue is counted (heldQueue, after the sweep that refuses what waited
 * HELD_DAYS), and only when something waits, the day's mark is claimed and
 * one plain email goes to the creator with the counts and the way to the
 * queue in the studio. Nothing is said about who wrote what.
 *
 * The email is the store's own (the "store" meter, kind "email"): its figure
 * is taken before it goes (lib/email.ts), and one that does not fit is not
 * sent. At most one a store a day, on an exact claim (lib/claim-mark.ts).
 * An unknown answer anywhere sends nothing: an unreadable queue takes no
 * mark, so the next day's run tries again; an unknown claim sends nothing
 * that run and lets nothing go.
 */
import { claimMark } from "@/lib/claim-mark";
import { NIMBUS_FROM, sendEmail as realSendEmail } from "@/lib/email";
import { SITE_URL } from "@/lib/site-url";
import { standingOf } from "@/lib/plan-standing";
import { type Store, storeForId } from "@/lib/store";
import { HELD_DAYS, heldNoticeKey, heldQueue, storesWithHeld } from "@/lib/community-approval";

/** The most stores one run reads; the list is the latest first, so the stores held from lately go first. */
export const NOTICE_STORES_PER_RUN = 500;
/** How long the day's mark is kept: the day, and the next for a run that starts late. */
const MARK_SECONDS = 2 * 86_400;

export type HeldNoticeOutcome = "sent" | "none" | "seen" | "skipped" | "failed";
export type HeldNoticeCounts = Record<HeldNoticeOutcome, number>;

function counted(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The email's subject and text, in plain US English: what waits, where to answer, how often it comes. */
export function heldNoticeEmail(store: Pick<Store, "name" | "sid">, posts: number, comments: number): { subject: string; text: string } {
  const parts = [posts ? counted(posts, "post", "posts") : "", comments ? counted(comments, "comment", "comments") : ""].filter(Boolean);
  const one = posts + comments === 1;
  const what = `${parts.join(" and ")} ${one ? "is" : "are"} waiting for your approval`;
  const queue = `${SITE_URL}/studio/community${store.sid ? `?store=${store.sid}` : ""}#cm-held-title`;
  return {
    subject: what.slice(0, 180),
    text: [
      `${what} in the ${store.name} community.`,
      "",
      one ? "Members do not see it until you approve it." : "Members do not see them until you approve them.",
      "",
      "To approve or remove what waits, open your community in the studio:",
      queue,
      "",
      `Anything that waits ${HELD_DAYS} days without an answer is not published, and its author is told.`,
      "",
      "You get this email at most once a day, and only on days when something is waiting.",
    ].join("\n"),
  };
}

/** One store: counts its queue and, when something waits, tells its creator once today. */
export async function noticeHeld(store: Store, now: number, sendEmail: typeof realSendEmail = realSendEmail): Promise<HeldNoticeOutcome> {
  const id = store.community?.id;
  if (!id) return "skipped";
  const standing = standingOf(store, now / 1000);
  if (standing !== "paid" && standing !== "trial") return "skipped";
  // Counted first: an unreadable queue sends nothing and takes no mark, so the next run tries again.
  const waiting = await heldQueue(id, Math.floor(now / 1000)).catch(() => null);
  if (waiting === null) return "skipped";
  if (!waiting.length) return "none";
  const posts = waiting.filter((held) => held.kind === "post").length;
  const claimed = await claimMark(heldNoticeKey(id, new Date(now).toISOString().slice(0, 10)), MARK_SECONDS);
  if (claimed === "taken") return "seen";
  if (claimed !== "ours") return "skipped";
  const { subject, text } = heldNoticeEmail(store, posts, waiting.length - posts);
  const sent = await sendEmail({ meter: { by: "store", store, kind: "email" },
    from: NIMBUS_FROM,
    to: store.email,
    subject,
    text,
  }).catch(() => false);
  return sent ? "sent" : "failed";
}

/**
 * The daily pass: every store on the list, until `until` (milliseconds, on the
 * clock `now` is read on; a test's `now` is measured from the run's start). The
 * store is read by its id; one that is gone is passed over. An unreadable list
 * sends nothing this run.
 */
export async function noticeHeldStores(input: {
  until: number;
  now?: number;
  load?: (sid: string) => Promise<Store | null>;
  sendEmail?: typeof realSendEmail;
}): Promise<HeldNoticeCounts> {
  const now = input.now ?? Date.now();
  const load = input.load ?? storeForId;
  const out: HeldNoticeCounts = { sent: 0, none: 0, seen: 0, skipped: 0, failed: 0 };
  // The time this run may take, measured on the real clock from its start.
  const started = Date.now();
  const late = () => Date.now() - started > input.until - now;
  if (late()) return out;
  const sids = await storesWithHeld(Math.floor(now / 1000), NOTICE_STORES_PER_RUN).catch(() => null);
  if (!sids) return out;
  for (const sid of sids) {
    if (late()) break;
    const store = await load(sid).catch(() => null);
    if (!store || store.sid !== sid) {
      out.skipped += 1;
      continue;
    }
    out[await noticeHeld(store, now, input.sendEmail)] += 1;
  }
  return out;
}
