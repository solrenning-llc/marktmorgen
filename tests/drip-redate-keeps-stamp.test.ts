// A student row re-dated by the drip job (lib/learn.ts, redateStudent, when a course was bought again after a full
// refund) keeps the end of the purchase that stands (24 [E7]): the job's later runs fall back to the row's stamp
// whenever the start is not read (Stripe not answering, or the store's monthly figure for these reads spent), and the
// studio's student list shows it. Before this, the re-dated row dropped its stamp, so a later run that fell back to the
// row sent a module that opens after the student's access had ended (Claude 6's LEVE on #3369).
// Synthetic: the Redis stand-in, a Stripe world and a mail world only.
import type { Course } from "@/lib/course";
import { STAMP_BYTES, emailKey, noteBoughtAgain, recordEnrollment, registerDrip, sendDripEmails } from "@/lib/learn";
import { dataKey } from "@/lib/store-data";
import { contentRoomFor } from "@/lib/store-data-rules";
import type { Listing, Store } from "@/lib/store";
import { catalog } from "./course-repurchase-catalog-world";
import { stripe } from "./course-repurchase-stripe-world";
import { mail } from "./course-drip-mail-world";
import { counted } from "./course-drip-count-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const courseId = "9".repeat(32);
const lesson = (id: string) => ({ id, title: id, preview: false, video: null, files: [], link: null, hasBody: false, quiz: null });
const base: Course = {
  id: courseId, certificate: false, startsAt: null,
  modules: [
    { id: "module000000", title: "Week 1", dripDays: 0, lessons: [lesson("lesson000000")] },
    ...[1, 2, 3].map((n) => ({ id: `module00000${n}`, title: `Month ${n}`, dripDays: 30 * n, lessons: [lesson(`lesson00000${n}`)] })),
  ],
};
let current: Course = base;
const product = { id: "prod_dripmail1", title: "Drip course", priceCents: 4900, course: { id: courseId, lessons: 4 } } as unknown as Listing;
const store = { handle: "drip-school", previousHandles: [], name: "Drip School", email: "owner@example.test", statsId: "6".repeat(32), sid: "5".repeat(32), language: "en", stripeAccountId: "acct_synthetic02" } as unknown as Store;
const buyer = "buyer-drip@example.test";
const DAY = 86_400;
const first = Math.floor(Date.UTC(2026, 0, 1, 12) / 1000);
const second = first + 120 * DAY;
const origin = "https://marktmorgen.example";
const rowKey = `nl:course:${courseId}:students`;

const session = (id: string, created: number, refunded: boolean, end?: number) => ({
  id, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", created,
  metadata: { store: store.handle, product: product.id, ...(end === undefined ? {} : { access_end: String(end) }) },
  payment_intent: { object: "payment_intent", latest_charge: { object: "charge", amount: 4900, amount_refunded: refunded ? 4900 : 0, refunded } },
});

async function run(now: number): Promise<string[]> {
  mail.sent = [];
  await sendDripEmails(async (handle) => (handle === store.handle ? store : null), async (id) => (id === courseId ? current : null), origin, now);
  return mail.sent.map((m) => m.subject);
}
const subject = (title: string) => `Now open in Drip course: ${title}`;
async function rowOf(): Promise<Record<string, unknown> | null> {
  const [raw] = await redis.pipeline([["HGET", rowKey, emailKey(buyer)]]);
  return typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

/** Bought, opened with the first purchase's end on the row, refunded in full and bought again `second`. */
async function boughtAgain(sessions: Record<string, unknown>[], row: Record<string, unknown>) {
  redis.clear();
  counted.asked = [];
  counted.left = Number.MAX_SAFE_INTEGER;
  catalog.listings = [product];
  stripe.sessions = sessions;
  stripe.fail = false;
  stripe.byEmail = undefined;
  await registerDrip(store, product, current);
  await recordEnrollment(store, buyer, product.id, first);
  await redis.pipeline([["HSET", rowKey, emailKey(buyer), JSON.stringify(row)]]);
  await noteBoughtAgain(store, [courseId], buyer, second);
}

async function main() {
  part("Bought again with an earlier end: the re-dated row carries the new purchase's end");
  {
    const endNew = second + 45 * DAY;
    const endOld = second + 400 * DAY;
    current = { ...base, accessEndsAt: endNew, accessEndsKept: [] };
    await boughtAgain([session("cs_test_second", second, false, endNew), session("cs_test_first", first, true, endOld)], { e: buyer, s: first, l: first, x: endOld });
    is("Month 1 goes, inside the new purchase's access", await run(second + 30 * DAY), [subject("Month 1")]);
    const row = await rowOf();
    is("the row takes the day of the purchase that stands", row?.s, second);
    is("and its end, not the refunded purchase's (and never none)", row?.x, endNew);
    is("its last visit is kept", row?.l, first);
    // The buyer's kept answer let go and Stripe not answering: the start is not read, so the run falls back to the row.
    await redis.pipeline([["DEL", ...redis.keys().filter((k) => k.startsWith("nl:learn:paid:"))]]);
    stripe.fail = true;
    is("a later run that cannot read the start falls back to the row: Month 2 opens after the end, not sent", await run(second + 60 * DAY), []);
    current = base;
  }

  part("Bought again with no end: the re-dated row carries none");
  {
    const endOld = second + 10 * DAY;
    current = base;
    await boughtAgain([session("cs_test_second", second, false), session("cs_test_first", first, true, endOld)], { e: buyer, s: first, l: first, x: endOld });
    is("Month 1 goes", await run(second + 30 * DAY), [subject("Month 1")]);
    const row = await rowOf();
    is("the row takes the day of the purchase that stands", row?.s, second);
    is("and no end: the refunded purchase's is gone", row && "x" in row, false);
    // The buyer's kept answer let go and Stripe not answering: the start is not read, so the run falls back to the row.
    await redis.pipeline([["DEL", ...redis.keys().filter((k) => k.startsWith("nl:learn:paid:"))]]);
    stripe.fail = true;
    is("a later run that falls back to the row still sends Month 2, the access having no end", await run(second + 60 * DAY), [subject("Month 2")]);
    current = base;
  }

  // A stamp is written only with its bytes taken from the store's room (touchStudent). On main the re-date had no room
  // to take from and left it off; with the drip index (#3344) the stamp is put back by noteStudentStamp, which takes its
  // bytes first, so the rule is held by what is taken, not by a row left stampless (Claude 6 on #3344, 7073926808).
  const room = dataKey(store)!;
  const doneSlot = async () => Number((await redis.pipeline([["HGET", room, `cd:${courseId}`]]))[0] ?? 0);
  part("A row that had no end and a purchase with one: the stamp is written with its bytes taken (touchStudent)");
  {
    const endNew = second + 45 * DAY;
    current = { ...base, accessEndsAt: endNew, accessEndsKept: [] };
    await boughtAgain([session("cs_test_second", second, false, endNew), session("cs_test_first", first, true)], { e: buyer, s: first, l: first });
    const before = await doneSlot();
    is("Month 1 goes", await run(second + 30 * DAY), [subject("Month 1")]);
    const row = await rowOf();
    is("the row takes the day", row?.s, second);
    is("the stamp is the new purchase's end", row?.x, endNew);
    is("and the course's slot grew by exactly the stamp's bytes", (await doneSlot()) - before, STAMP_BYTES);
    current = base;
  }

  part("The same with the store's room full: no stamp is written and nothing is taken");
  {
    const endNew = second + 45 * DAY;
    current = { ...base, accessEndsAt: endNew, accessEndsKept: [] };
    await boughtAgain([session("cs_test_second", second, false, endNew), session("cs_test_first", first, true)], { e: buyer, s: first, l: first });
    await redis.pipeline([["HSET", room, "#", String(contentRoomFor(store as never, second + 30 * DAY))]]);
    const before = await doneSlot();
    await run(second + 30 * DAY);
    const row = await rowOf();
    is("no stamp written without its bytes taken", row !== null && "x" in row, false);
    is("and nothing taken from the room for it", await doneSlot(), before);
    current = base;
  }
  done();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
