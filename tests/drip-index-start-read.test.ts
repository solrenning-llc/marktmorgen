// The course drip job over the store's index of due pairs (#3344, lib/learn.ts sendDue) keeps #3369's start read: one
// RED check for each invariant the reviewer of #3369 (Claude 6) named on the merge of the two.
//   1. The start is read exactly (courseLedger "strict", importedFromExact): an unknown read is never "no purchase":
//      nothing is sent, the mark is let go and the pair stays in the index.
//   2. takeDripStartUnits runs before the start read: no read while the store's units are not taken.
//   3. redateStudent only on a start that was really read, never on "row" or "unknown".
//   4. forgetEarlyDripMails runs on a re-buy: the emails sent early under the refunded purchase go again on the new day.
//   5. The drip-start-read cost line is summed with course-drip-run, and the refunded Store year is measured with both.
// Synthetic only: the in-memory Redis (tests/redis-stub.ts), a fixed catalog, a fixed Stripe and a recording mailer.
import { readFileSync } from "node:fs";
import type { Course } from "@/lib/course";
import { emailKey, noteBoughtAgain, recordEnrollment, registerDrip, sendDripEmails, studentDates } from "@/lib/learn";
import type { Listing, Store } from "@/lib/store";
import { allowanceWindow } from "@/lib/allowance-window";
import { dripStartUnits } from "@/lib/drip-start-rules";
import { catalog } from "./course-repurchase-catalog-world";
import { stripe } from "./course-repurchase-stripe-world";
import { mail } from "./course-drip-mail-world";
import { counted } from "./course-drip-count-world";
import { store as redis } from "./redis-stub";
import { COST_LINES } from "./plan-cost-registry";
import { providerFeeUsd, worstCost, GB, STORAGE_PER_GB } from "./plan-cost-model";
import { PRICES_WITHOUT_COMMISSION } from "@/lib/plan";
import { paidStorageBytes } from "@/lib/storage-rules";
import { CLOSING_DAYS, WARN_WEEK_DAYS } from "@/lib/plan-closing-rules";
import { done, is, part } from "./check";

const courseId = "8".repeat(32);
const lesson = (id: string) => ({ id, title: id, preview: false, video: null, files: [], link: null, hasBody: false, quiz: null });
const course: Course = {
  id: courseId, certificate: false, startsAt: null,
  modules: [
    { id: "module000000", title: "Week 1", dripDays: 0, lessons: [lesson("lesson000000")] },
    { id: "module000001", title: "Month 1", dripDays: 30, lessons: [lesson("lesson000001")] },
    { id: "module000002", title: "Month 2", dripDays: 60, lessons: [lesson("lesson000002")] },
  ],
};
const product = { id: "prod_dripindex1", title: "Index course", priceCents: 4900, course: { id: courseId, lessons: 3 } } as unknown as Listing;
const store = { handle: "drip-index", previousHandles: [], name: "Drip Index", email: "owner@example.test", statsId: "4".repeat(32), sid: "3".repeat(32), language: "en", stripeAccountId: "acct_synthetic03" } as unknown as Store;
const buyer = "buyer-index@example.test";
const DAY = 86_400;
const first = Math.floor(Date.UTC(2026, 0, 1, 12) / 1000);
const second = first + 120 * DAY;
const subject = (title: string) => `Now open in Index course: ${title}`;
const dueKey = `nl:drip:due:${store.statsId}`;
const pairOf = (moduleId: string, who = buyer) => `${courseId}|${emailKey(who)}|${moduleId}`;
const markOf = (moduleId: string, who = buyer) => `nl:course:${courseId}:dripmail:${emailKey(who)}:${moduleId}`;

const session = (id: string, created: number, refunded: boolean) => ({
  id, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", created,
  metadata: { store: store.handle, product: product.id },
  payment_intent: { object: "payment_intent", latest_charge: { object: "charge", amount: 4900, amount_refunded: refunded ? 4900 : 0, refunded } },
});

/** One reply replaced once, for the command `match` picks. */
let odd: { match: (command: (string | number)[]) => boolean; reply: unknown } | null = null;
const real = redis.pipeline.bind(redis);
redis.pipeline = async (commands) => {
  const picked = odd;
  const hit = picked ? commands.findIndex(picked.match) : -1;
  if (!picked || hit < 0) return real(commands);
  odd = null;
  const out = [...(await real(commands))];
  out[hit] = picked.reply;
  return out;
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
  stripe.asked = [];
  await registerDrip(store, product, course);
}

async function openedOn(start: number, extra: Record<string, unknown> = {}) {
  await redis.pipeline([["HSET", `nl:course:${courseId}:students`, emailKey(buyer), JSON.stringify({ e: buyer, s: start, l: start, ...extra })]]);
}

async function run(now: number): Promise<string[]> {
  mail.sent = [];
  await sendDripEmails(async (handle) => (handle === store.handle ? store : null), async (id) => (id === courseId ? course : null), "https://marktmorgen.example", now);
  return mail.sent.map((m) => m.subject);
}
const startReads = () => stripe.asked.filter((p) => p.startsWith("/checkout/sessions?")).length;
const inIndex = async (member: string) => (await redis.pipeline([["ZSCORE", dueKey, member]]))[0] !== null;
const exists = async (key: string) => (await redis.pipeline([["EXISTS", key]]))[0] === 1;

async function main() {
  part("1. The start is read exactly: an unknown read is never \"no purchase\"");
  {
    await fresh([]);
    (store as { pastBuyers?: boolean }).pastBuyers = true;
    const { addressHash } = await import("@/lib/imported-purchases");
    await redis.pipeline([["HSET", `nl:imp:buy:${store.statsId}:${addressHash(buyer)}`, product.id, JSON.stringify({ at: first, job: "imp_synthetic2" })]]);
    await openedOn(first);
    // The walk puts the pairs in the index on the first run, a day before Month 1 opens.
    is("nothing before its day", await run(first + 29 * DAY), []);
    is("Month 1's pair is in the index", await inIndex(pairOf("module000001")), true);
    // The hash answered in its own shape, another product's row legible and this course's row illegible: the strict read
    // (importedFromExact) takes it as unknown, never as "not brought over" (Claude 7's MEDIUM on #3369).
    odd = { match: (c) => c[0] === "HGETALL" && String(c[1]).startsWith("nl:imp:buy:"), reply: ["prod_otherthing", JSON.stringify({ at: first, job: "imp_synthetic3" }), product.id, "{not a row"] };
    is("what was brought over unreadable: nothing sent", await run(first + 30 * DAY), []);
    is("the mark is let go", await exists(markOf("module000001")), false);
    is("the pair stays in the index", await inIndex(pairOf("module000001")), true);
    is("read the next day: Month 1 goes", await run(first + 31 * DAY), [subject("Month 1")]);
    (store as { pastBuyers?: boolean }).pastBuyers = false;
  }

  part("2. The store's units are taken before the start is read");
  {
    await fresh([session("cs_test_units", first, false)]);
    await recordEnrollment(store, buyer, product.id, first);
    await openedOn(first);
    await run(first + 29 * DAY);
    // The store's window for these reads, spent in full.
    const window = allowanceWindow(store, (first + 30 * DAY) * 1000);
    await redis.pipeline([["SET", `nl:dripstart:${store.sid}:${window?.id}`, String(Number.MAX_SAFE_INTEGER - 10)]]);
    stripe.asked = [];
    is("its units spent: Month 1 goes from the row's day", await run(first + 30 * DAY), [subject("Month 1")]);
    is("and no start is read", startReads(), 0);
    await fresh([session("cs_test_units", first, false)]);
    await recordEnrollment(store, buyer, product.id, first);
    await openedOn(first);
    await run(first + 29 * DAY);
    stripe.asked = [];
    is("with units: Month 1 goes", await run(first + 30 * DAY), [subject("Month 1")]);
    is("after one start read", startReads(), 1);
    const taken = (await redis.pipeline([["GET", `nl:dripstart:${store.sid}:${allowanceWindow(store, (first + 30 * DAY) * 1000)?.id}`]]))[0];
    is("which took its units from the store's figure", Number(taken), dripStartUnits(1));
  }

  part("3. A student's start moves only on a start really read");
  {
    // Refunded in full and bought again: the page opens the course from the second purchase.
    const sessions = [session("cs_test_second", second, false), session("cs_test_first", first, true)];
    await fresh(sessions);
    await recordEnrollment(store, buyer, product.id, first);
    await openedOn(first);
    await run(second - DAY);
    // The new purchase's confirmation notes it (lib/purchase-email.ts, confirmOnce).
    await noteBoughtAgain(store, [courseId], buyer, second);
    stripe.fail = true;
    is("Stripe not answering (\"row\"): nothing sent", await run(second + 30 * DAY), []);
    is("and the row keeps its day", (await studentDates(courseId, buyer))?.since, first);
    stripe.fail = false;
    odd = { match: (c) => c[0] === "INCRBY" && String(c[1]).startsWith("nl:dripstart:"), reply: "QUEUED" };
    is("the units not counted (\"unknown\"): nothing sent", await run(second + 30 * DAY + 60), []);
    is("and the row keeps its day", (await studentDates(courseId, buyer))?.since, first);
    is("read: Month 1 goes on the new purchase's day", await run(second + 31 * DAY), [subject("Month 1")]);
    is("and the row takes the page's day", (await studentDates(courseId, buyer))?.since, second);
  }

  part("4. A re-buy forgets the emails sent early, which go again on the new day");
  {
    const sessions = [session("cs_test_first", first, false)];
    await fresh(sessions);
    await recordEnrollment(store, buyer, product.id, first);
    await openedOn(first);
    await run(first + 29 * DAY);
    is("Month 1 under the first purchase", await run(first + 30 * DAY), [subject("Month 1")]);
    is("its mark kept", await exists(markOf("module000001")), true);
    // Refunded in full, bought again four months on; the confirmation notes it (noteBoughtAgain's set).
    stripe.sessions = [session("cs_test_second", second, false), session("cs_test_first", first, true)];
    await redis.pipeline([["DEL", redis.keys().find((k) => k.startsWith("nl:learn:paid:")) ?? "none"], ["SADD", `nl:course:${courseId}:again`, emailKey(buyer)]]);
    // Month 2 under the old day (first + 60) is due: the run reads the start first.
    await run(first + 60 * DAY);
    is("the row takes the new day", (await studentDates(courseId, buyer))?.since, second);
    is("Month 1's early mark is forgotten", await exists(markOf("module000001")), false);
    is("Month 1 goes again the day it opens on the new purchase", await run(second + 30 * DAY), [subject("Month 1")]);
  }

  part("5. drip-start-read is summed with course-drip-run, and the Store year is measured with both");
  {
    const ids = ["drip-start-read", "course-drip-run"];
    for (const tier of ["creator", "pro", "scale"] as const) {
      const lines = ids.map((id) => COST_LINES.find((line) => line.id === id));
      is(`${tier}: both lines are plan lines, each above zero`, lines.every((line) => line !== undefined && line.monthlyUsd(tier) > 0), true);
      const others = COST_LINES.filter((line) => !ids.includes(line.id)).reduce((sum, line) => sum + line.monthlyUsd(tier), 0);
      const both = lines.reduce((sum, line) => sum + (line ? line.monthlyUsd(tier) : 0), 0);
      is(`${tier}: the worst month holds both`, Math.abs(worstCost(tier) - others - both) < 1e-9, true);
    }
    const registry = readFileSync("tests/plan-cost-registry.ts", "utf8");
    is("a store that pays nothing carries both lines too", registry.includes("+ creator(\"course-drip-run\")") && registry.includes("+ creator(\"drip-start-read\")"), true);
    const tier = "creator" as const;
    const kept = (paidStorageBytes(tier) / GB) * STORAGE_PER_GB * ((CLOSING_DAYS + WARN_WEEK_DAYS) / 30);
    const year = worstCost(tier) + providerFeeUsd(PRICES_WITHOUT_COMMISSION[tier].year) + kept;
    console.log(`a refunded Store first year with both drip lines: US$${year.toFixed(4)}`);
    is("a refunded Store first year with both drip lines is under US$66", year < 66, true);
  }
  part("6. A stamped student re-dated through the start read keeps an access end on their row");
  {
    // Bought with an end, refunded in full, bought again with an earlier end: the row held the first purchase's.
    const endNew = second + 45 * DAY;
    const endOld = second + 400 * DAY;
    const ending = { ...course, accessEndsAt: endNew, accessEndsKept: [] } as Course;
    const stamped = (id: string, created: number, refunded: boolean, end: number) => ({ ...session(id, created, refunded), metadata: { store: store.handle, product: product.id, access_end: String(end) } });
    await fresh([stamped("cs_test_second", second, false, endNew), stamped("cs_test_first", first, true, endOld)]);
    await registerDrip(store, product, ending);
    await recordEnrollment(store, buyer, product.id, first);
    await openedOn(first, { x: endOld });
    await noteBoughtAgain(store, [courseId], buyer, second);
    is("Month 1 goes, inside the new purchase's access", await run(second + 30 * DAY), [subject("Month 1")]);
    is("the row takes the new day", (await studentDates(courseId, buyer))?.since, second);
    const row = JSON.parse(String((await redis.pipeline([["HGET", `nl:course:${courseId}:students`, emailKey(buyer)]]))[0])) as { x?: number };
    is("and keeps an end: the stamp read with the start", row.x, endNew);
    // A later run whose start read falls back to the row (Stripe not answering, its kept answer gone): the row's end
    // still holds.
    await redis.pipeline([["DEL", redis.keys().find((k) => k.startsWith("nl:learn:paid:")) ?? "none"]]);
    stripe.fail = true;
    is("Month 2 opens after that end: not sent, even from the row", await run(second + 60 * DAY), []);
    stripe.fail = false;
  }

  part("7. What a paid order's re-buy note costs in the drip index stays inside the line that prices it");
  {
    const R = await import("./plan-cost-registry");
    const { MAX_DELIVERED } = await import("@/lib/bundle-rules");
    const { MAX_MODULES } = await import("@/lib/course");
    is("its card and pair bytes are the drip run's own", [R.ORDER_BOUGHT_AGAIN_INDEX_CARD_BYTES, R.ORDER_BOUGHT_AGAIN_INDEX_PAIR_BYTES], [R.DRIP_CARD_MAX_BYTES, R.DRIP_PAIR_BYTES]);
    is("its bytes cover MAX_DELIVERED courses", R.ORDER_BOUGHT_AGAIN_INDEX_BYTES, MAX_DELIVERED * (R.DRIP_CARD_MAX_BYTES + 2 * MAX_MODULES * R.DRIP_PAIR_BYTES));
    // Priced with the note (#5034's line order-bought-again, on every order of each plan's figure and the trial's).
    const note = R.ORDER_BOUGHT_AGAIN_COMMANDS * R.COMMAND + R.ORDER_BOUGHT_AGAIN_BYTES * R.DB_BYTE + R.ORDER_BOUGHT_AGAIN_MARK_BYTES * R.DB_BYTE_MONTH * (R.ORDER_BOUGHT_AGAIN_MARK_SECONDS / (30 * 86_400));
    is("priced in order-bought-again, beside the note", R.ORDER_BOUGHT_AGAIN_INDEX > 0 && Math.abs(R.ORDER_BOUGHT_AGAIN - (note + R.ORDER_BOUGHT_AGAIN_INDEX)) < 1e-15, true);
    is("the line names indexBoughtAgain", R.COST_LINES.find((line) => line.id === "order-bought-again")?.sources.some((src) => src.file === "lib/learn.ts" && src.names.includes("indexBoughtAgain")), true);
    // Measured: three courses of one order, each a re-buy with its card kept, every command of the index part counted.
    const ids = ["7", "6", "5"].map((c) => c.repeat(32));
    await fresh([]);
    for (const id of ids) {
      const other = { ...course, id } as Course;
      await registerDrip(store, { ...product, id: `prod_${id.slice(0, 8)}`, course: { id, lessons: 3 } } as unknown as Listing, other);
      await redis.pipeline([["HSET", `nl:course:${id}:students`, emailKey(buyer), JSON.stringify({ e: buyer, s: first, l: first })]]);
    }
    const sent: (string | number)[][] = [];
    const counting = redis.pipeline;
    redis.pipeline = async (list) => {
      sent.push(...list);
      return counting(list);
    };
    const noted = await noteBoughtAgain(store, ids, buyer, second);
    redis.pipeline = counting;
    is("the note is written", noted, true);
    // The index part: what comes after the note's own HGETs, SADDs and DEL (#3369's).
    const own = 2 * ids.length + 1;
    const index = sent.length - own;
    is(`the index part's commands (${index}) within the formula (${R.ORDER_BOUGHT_AGAIN_INDEX_COMMANDS}), a script billed at TAKE's four`, index > 0 && index <= R.ORDER_BOUGHT_AGAIN_INDEX_COMMANDS, true);
    is("one MGET of every card, whatever the courses", sent.filter((c) => c[0] === "MGET").length, 1);
  }
  done();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
