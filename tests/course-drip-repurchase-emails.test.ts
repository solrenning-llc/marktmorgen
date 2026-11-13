// The "now open" emails of a drip course (sendDripEmails) go on the day the course page opens the module, from the
// same start the page reads (courseLedger): a course bought again after a full refund is emailed from the purchase
// that stands, a purchase refunded in full and not bought again is not emailed, and a start that cannot be read
// sends nothing that run and is tried again on the next, never early and never skipped. The page re-dates the
// student's row when it reads a different start, so the studio and the next run follow it. The job's reads are its
// own, bounded per store and allowance window (lib/drip-start.ts), never taken from the store's public requests (what
// its buyers' pages use).
import type { Course } from "@/lib/course";
import { emailKey, noteBoughtAgain, paidCourses, recordEnrollment, registerDrip, sendDripEmails, studentDates, touchStudent } from "@/lib/learn";
import type { DataStore } from "@/lib/store-data";
import type { Listing, Store } from "@/lib/store";
import { catalog } from "./course-repurchase-catalog-world";
import { stripe } from "./course-repurchase-stripe-world";
import { mail } from "./course-drip-mail-world";
import { counted } from "./course-drip-count-world";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const courseId = "9".repeat(32);
const lesson = (id: string) => ({ id, title: id, preview: false, video: null, files: [], link: null, hasBody: false, quiz: null });
const course: Course = {
  id: courseId, certificate: false, startsAt: null,
  modules: [
    { id: "module000000", title: "Week 1", dripDays: 0, lessons: [lesson("lesson000000")] },
    ...[1, 2, 3, 4, 5, 6].map((n) => ({ id: `module00000${n}`, title: `Month ${n}`, dripDays: 30 * n, lessons: [lesson(`lesson00000${n}`)] })),
  ],
};
/** A short course: one module, 30 days after buying, and nothing later to come due under an old start (Codex G on #3369). */
const short: Course = {
  id: courseId, certificate: false, startsAt: null,
  modules: [
    { id: "module000000", title: "Week 1", dripDays: 0, lessons: [lesson("lesson000000")] },
    { id: "module000001", title: "Month 1", dripDays: 30, lessons: [lesson("lesson000001")] },
  ],
};
let current: Course = course;
const product = { id: "prod_dripmail1", title: "Drip course", priceCents: 4900, course: { id: courseId, lessons: 7 } } as unknown as Listing;
const store = { handle: "drip-school", previousHandles: [], name: "Drip School", email: "owner@example.test", statsId: "6".repeat(32), sid: "5".repeat(32), language: "en", stripeAccountId: "acct_synthetic02" } as unknown as Store;
const buyer = "buyer-drip@example.test";
const DAY = 86_400;
const first = Math.floor(Date.UTC(2026, 0, 1, 12) / 1000);
const second = first + 120 * DAY; // May 1, four months on
const origin = "https://marktmorgen.example";

const session = (id: string, created: number, refunded: boolean) => ({
  id, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", created,
  metadata: { store: store.handle, product: product.id },
  payment_intent: { object: "payment_intent", latest_charge: { object: "charge", amount: 4900, amount_refunded: refunded ? 4900 : 0, refunded } },
});

/** The row touchStudent writes the first time a student opens the course. */
async function openedOn(start: number, who = buyer) {
  await redis.pipeline([["HSET", `nl:course:${courseId}:students`, emailKey(who), JSON.stringify({ e: who, s: start, l: start })]]);
}

/** One run of the daily job at `now`; the subjects of what it sent. */
async function run(now: number): Promise<string[]> {
  mail.sent = [];
  await sendDripEmails(async (handle) => (handle === store.handle ? store : null), async (id) => (id === courseId ? current : null), origin, now);
  return mail.sent.map((m) => m.subject);
}
const subject = (title: string) => `Now open in Drip course: ${title}`;

/**
 * Replies of this shape, once, for the commands `match` picks; every other reply as Redis gives it. `lost`: the
 * picked command never reached Redis, so nothing it would write is there (a mark's claim that is really unknown:
 * lib/claim-mark.ts reads the mark back, and a write that landed under an odd reply is read back as ours).
 */
let odd: { match: (command: (string | number)[]) => boolean; reply: unknown; lost?: boolean } | null = null;
const real = redis.pipeline.bind(redis);
redis.pipeline = async (commands) => {
  const picked = odd;
  const hit = picked ? commands.findIndex(picked.match) : -1;
  if (!picked || hit < 0) return real(commands);
  odd = null;
  if (!picked.lost) {
    const out = [...(await real(commands))];
    out[hit] = picked.reply;
    return out;
  }
  const replies = await real(commands.filter((_, i) => i !== hit));
  return [...replies.slice(0, hit), picked.reply, ...replies.slice(hit)];
};

async function fresh(sessions: Record<string, unknown>[]) {
  redis.clear();
  odd = null;
  counted.asked = [];
  counted.left = Number.MAX_SAFE_INTEGER;
  catalog.listings = [product];
  stripe.sessions = sessions;
  stripe.fail = false;
  stripe.byEmail = undefined;
  await registerDrip(store, product, current);
}

async function main() {
  part("Bought, opened, refunded in full, bought again four months on, not opened since");
  await fresh([session("cs_test_second", second, false), session("cs_test_first", first, true)]);
  await recordEnrollment(store, buyer, product.id, first);
  await openedOn(first);
  const may31 = await run(first + 150 * DAY);
  is("the refunded purchase's Month 5 is not announced (the page keeps it shut until September 28)", may31.includes(subject("Month 5")), false);
  is("Month 1 is announced the day the page opens it, 30 days after buying again", may31, [subject("Month 1")]);
  is("the studio's start follows the purchase that stands", (await studentDates(courseId, buyer))?.since, second);
  is("Month 5 is announced when the page opens it, 150 days after buying again", await run(second + 150 * DAY), [subject("Month 5")]);
  is("and Month 6, 180 days after buying again", await run(second + 180 * DAY), [subject("Month 6")]);

  part("Bought again, then the course opened: the page re-dates the student's row");
  // The page opens today, the day after buying again; the first purchase four months before.
  const again = Math.floor(Date.now() / 1000) - DAY;
  const before = again - 120 * DAY;
  await fresh([session("cs_test_first", before, false)]);
  await recordEnrollment(store, buyer, product.id, before);
  await openedOn(before);
  is("before the refund, Month 1 was announced on time", await run(before + 30 * DAY), [subject("Month 1")]);
  stripe.sessions = [session("cs_test_second", again, false), session("cs_test_first", before, true)];
  await redis.pipeline([["DEL", redis.keys().find((k) => k.startsWith("nl:learn:paid:")) ?? "none"]]);
  const start = (await paidCourses(store, buyer)).get(product.id);
  is("the page opens the course from the purchase that stands", start, again);
  await touchStudent(courseId, buyer, start ?? 0, store as unknown as DataStore, course);
  is("and the student's row takes that day", (await studentDates(courseId, buyer))?.since, again);
  is("Month 1 is announced again when it opens again, 30 days after buying again", await run(again + 30 * DAY), [subject("Month 1")]);
  is("once", await run(again + 31 * DAY), []);

  part("Refunded in full and not bought again");
  await fresh([session("cs_test_gone", first, true)]);
  await recordEnrollment(store, buyer, product.id, first);
  await openedOn(first);
  is("nothing is announced for a course it can no longer open", await run(first + 30 * DAY), []);
  is("nor the next day", await run(first + 31 * DAY), []);

  part("A start that cannot be read, or a mark that cannot be claimed");
  await fresh([session("cs_test_once", first, false)]);
  await recordEnrollment(store, buyer, product.id, first);
  await openedOn(first);
  odd = { match: (c) => c[0] === "SISMEMBER" && String(c[1]).endsWith(":blocked"), reply: "maybe" };
  is("whether the student was taken off unknown: nothing is sent", await run(first + 30 * DAY), []);
  odd = { match: (c) => c[0] === "SET" && String(c[1]).includes(":dripmail:"), reply: "QUEUED", lost: true };
  is("the mark's claim unknown: nothing is sent", await run(first + 30 * DAY), []);
  is("the next run sends it, never skipped", await run(first + 31 * DAY), [subject("Month 1")]);
  await fresh([session("cs_test_once", first, false)]);
  await recordEnrollment(store, buyer, product.id, first);
  await openedOn(first);
  odd = { match: (c) => c[0] === "SET" && String(c[1]).includes(":dripmail:"), reply: "QUEUED" };
  is("the mark's reply odd but our own value read back: sent", await run(first + 30 * DAY), [subject("Month 1")]);
  is("and once", await run(first + 31 * DAY), []);

  // Changed on #3369 (Claude 7's MEDIUM 2, Codex L): main's job sends from the row, and the course page opens a one-off
  // course from its thanks-page record when Stripe does not answer, so the email goes from the row's day too.
  part("Stripe does not answer: the module is announced from the row's day, as the page opens it");
  await fresh([session("cs_test_once", first, false)]);
  await recordEnrollment(store, buyer, product.id, first);
  await openedOn(first);
  stripe.fail = true;
  is("Stripe not answering: Month 1 goes on its day, from the row", await run(first + 30 * DAY), [subject("Month 1")]);
  stripe.fail = false;
  is("once", await run(first + 31 * DAY), []);

  part("The job's reads are its own, never the store's public requests");
  await fresh([session("cs_test_once", first, false)]);
  await recordEnrollment(store, buyer, product.id, first);
  await openedOn(first);
  counted.left = 0;
  is("with the store's public requests all used, the email still goes", await run(first + 30 * DAY), [subject("Month 1")]);
  is("and none of them is asked for", counted.asked, []);
  is("a run with nothing to announce reads nothing at Stripe", (stripe.asked = [], await run(first + 45 * DAY), stripe.asked), []);

  // Changed on #3369 (Claude 1's MEDIUM 1, Codex L): past the figure nothing more is read, and the rest are announced
  // from their rows' day in the same run, as main's job does, instead of waiting for a window that may come too late.
  part("One window reads at most the store's monthly figure for these reads; the rest are announced from their rows");
  await fresh([session("cs_test_once", first, false)]);
  // A one-course store's window reads as many students as the store may email in it (its "email" figure); this store
  // pays nothing, so its window is the calendar month: January 31, then February 1.
  const reads = allowanceFor(store, "email", first + 30 * DAY);
  const students = Array.from({ length: reads + 1 }, (_, n) => `student-${n}@example.test`);
  for (const who of students) {
    await recordEnrollment(store, who, product.id, first);
    await openedOn(first, who);
  }
  stripe.asked = [];
  const day30 = await run(first + 30 * DAY);
  is(`the first run announces Month 1 to all ${reads + 1} students`, day30.length, reads + 1);
  is("and reads no more students at Stripe than the figure", stripe.asked.filter((p) => p.startsWith("/checkout/sessions?")).length, reads);
  is("and then to nobody again", await run(first + 31 * DAY), []);

  part("A short course bought again after a full refund, not opened since: its restarted Month 1 still goes (Codex G on #3369)");
  current = short;
  await fresh([session("cs_test_second", second, false), session("cs_test_first", first, true)]);
  await recordEnrollment(store, buyer, product.id, first);
  await openedOn(first);
  // The new purchase's confirmation notes it (lib/purchase-email.ts, confirmOnce).
  await noteBoughtAgain(store, [courseId], buyer, second);
  is("before the new Month 1 opens, nothing is announced", await run(second + 29 * DAY), []);
  is("Month 1 is announced the day the page opens it again, 30 days after buying again", await run(second + 30 * DAY), [subject("Month 1")]);
  is("the studio's start follows the purchase that stands", (await studentDates(courseId, buyer))?.since, second);
  is("once", await run(second + 31 * DAY), []);
  current = course;

  part("Students who finished long ago never take the reads a due email needs (Claude 7 on #3369)");
  current = short;
  await fresh([session("cs_test_once", first, false)]);
  const figure = allowanceFor(store, "email", first + 70 * DAY);
  const past = Array.from({ length: figure }, (_, n) => `past-${n}@example.test`);
  const late = first + 40 * DAY;
  for (const who of past) {
    await recordEnrollment(store, who, product.id, first);
    // Seen the day before: the most recently seen come first in the job's list.
    await redis.pipeline([["HSET", `nl:course:${courseId}:students`, emailKey(who), JSON.stringify({ e: who, s: first, l: late + 29 * DAY })]]);
  }
  await recordEnrollment(store, "new-one@example.test", product.id, late);
  await openedOn(late, "new-one@example.test");
  stripe.asked = [];
  is(`with ${figure} past students, the one whose Month 1 opens today is emailed`, await run(late + 30 * DAY), [subject("Month 1")]);
  is("and only that start is read at Stripe", stripe.asked.filter((p) => p.startsWith("/checkout/sessions?")).length, 1);
  current = course;

  part("Students refunded in full never take the reads a paying student's due email needs (Claude 1 and Codex L on #3369)");
  current = short;
  await fresh([session("cs_test_refunded", first, true)]);
  const refundedFigure = allowanceFor(store, "email", first + 30 * DAY);
  const refunded = Array.from({ length: refundedFigure }, (_, n) => `refunded-${n}@example.test`);
  for (const who of refunded) {
    await recordEnrollment(store, who, product.id, first);
    await redis.pipeline([["HSET", `nl:course:${courseId}:students`, emailKey(who), JSON.stringify({ e: who, s: first, l: first + 29 * DAY })]]);
  }
  const payer = "payer@example.test";
  stripe.byEmail = { [payer]: [session("cs_test_payer", first, false)] };
  await recordEnrollment(store, payer, product.id, first);
  await openedOn(first, payer);
  const firstDays = [...(await run(first + 30 * DAY)), ...(await run(first + 31 * DAY)), ...(await run(first + 32 * DAY))];
  is("the paying student gets Month 1 within its window, nobody refunded does", firstDays, [subject("Month 1")]);
  stripe.byEmail = undefined;
  current = course;

  part("Stripe does not answer at all: a one-off buyer's module is announced from the row, as the page opens it (Claude 7 on #3369)");
  await fresh([session("cs_test_once", first, false)]);
  await recordEnrollment(store, buyer, product.id, first);
  await openedOn(first);
  stripe.fail = true;
  const outage = [...(await run(first + 30 * DAY)), ...(await run(first + 31 * DAY)), ...(await run(first + 32 * DAY))];
  is("Month 1 is announced within its window, once", outage, [subject("Month 1")]);
  stripe.fail = false;

  // Claude 7's MEDIUM on #3369 at 43cc9cabb7: the strict read the job asks for was strict for Stripe only; an imported
  // purchase or a course earned in the community whose reply did not read was taken as none, "shut" kept the mark for
  // 400 days, and the module's email was lost for good. Not read is unknown: nothing that run, sent on the next.
  part("A course brought over by an import, its reply unreadable once: sent on the next run, never lost (Claude 7 on #3369)");
  await fresh([]);
  (store as { pastBuyers?: boolean }).pastBuyers = true;
  await redis.pipeline([["HSET", `nl:imp:buy:${store.statsId}:${(await import("@/lib/imported-purchases")).addressHash(buyer)}`, product.id, JSON.stringify({ at: first, job: "imp_synthetic1" })]]);
  await openedOn(first);
  odd = { match: (c) => c[0] === "HGETALL" && String(c[1]).startsWith("nl:imp:buy:"), reply: "bare" };
  is("not read: nothing that run", await run(first + 30 * DAY), []);
  is("read the next day: Month 1 goes", await run(first + 31 * DAY), [subject("Month 1")]);
  (store as { pastBuyers?: boolean }).pastBuyers = false;

  part("A course earned in the community, its reply unreadable once: sent on the next run, never lost (Claude 7 on #3369)");
  await fresh([]);
  const community = "c".repeat(32);
  (store as { community?: unknown }).community = { id: community, on: true };
  const member = emailKey(buyer);
  await redis.pipeline([
    ["HSET", `nl:cm:${community}:m`, member, JSON.stringify({ k: member, removed: false })],
    ["HSET", `nl:cm:${community}:unl:${member}`, product.id, first],
  ]);
  await openedOn(first);
  odd = { match: (c) => c[0] === "HGETALL" && String(c[1]) === `nl:cm:${community}:unl:${member}`, reply: "bare" };
  is("not read: nothing that run", await run(first + 30 * DAY), []);
  is("read the next day: Month 1 goes", await run(first + 31 * DAY), [subject("Month 1")]);
  (store as { community?: unknown }).community = undefined;

  part("One purchase, written down on its thanks page (unchanged)");
  await fresh([session("cs_test_once", first, false)]);
  await recordEnrollment(store, buyer, product.id, first);
  await openedOn(first);
  is("nothing before its day", await run(first + 29 * DAY), []);
  is("Month 1 on its day", await run(first + 30 * DAY), [subject("Month 1")]);
  is("once", await run(first + 31 * DAY), []);
  is("Month 2 on its day", await run(first + 60 * DAY), [subject("Month 2")]);
  is("the student's row keeps its day", (await studentDates(courseId, buyer))?.since, first);
  done();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
