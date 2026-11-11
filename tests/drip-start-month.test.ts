// What the daily course job spends reading drip students' starts (lib/learn.ts, sendDripEmails) is taken from a
// monthly figure per store, in the store's own allowance window, before each read (Claude 2's MEDIUM on #3369): a
// figure that came back whole every run let a store's month read 32 times its email figure, a cost that grew with
// each store and its plan but was kept out of every plan's worst month. Now a second run in the same window reads
// nothing past the figure, a store that pays nothing reads only with one of the month's places (lib/free-pool.ts),
// a count that cannot be read reads and sends nothing that run (CX-123 rule 24), and the figure is a plan line
// (tests/plan-cost-registry.ts, COST_LINES "drip-start-read"), with the share of the stores that pay nothing in
// nonPayingWorst.
//
// Synthetic only: the in-memory Redis, a synthetic Stripe account and a synthetic mailer; nothing leaves.
import type { Course } from "@/lib/course";
import { emailKey, recordEnrollment, registerDrip, sendDripEmails } from "@/lib/learn";
import type { Listing, Store } from "@/lib/store";
import { allowanceFor, STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { calendarWindow } from "@/lib/allowance-window";
import { dripStartUnits } from "@/lib/drip-start-rules";
import { catalog } from "./course-repurchase-catalog-world";
import { stripe } from "./course-repurchase-stripe-world";
import { mail } from "./course-drip-mail-world";
import { counted } from "./course-drip-count-world";
import { COST_LINES, NOT_A_COST, nonPayingWorst } from "./plan-cost-registry";
import { laterPageCost } from "./traffic-cost";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const courseId = "8".repeat(32);
const lesson = (id: string) => ({ id, title: id, preview: false, video: null, files: [], link: null, hasBody: false, quiz: null });
const course: Course = {
  id: courseId, certificate: false, startsAt: null,
  modules: [
    { id: "module000000", title: "Week 1", dripDays: 0, lessons: [lesson("lesson000000")] },
    { id: "module000001", title: "Month 1", dripDays: 30, lessons: [lesson("lesson000001")] },
  ],
};
const product = { id: "prod_dripmonth1", title: "Month course", priceCents: 4900, course: { id: courseId, lessons: 2 } } as unknown as Listing;
const store = { handle: "drip-month", previousHandles: [], name: "Drip Month", email: "owner@example.test", statsId: "4".repeat(32), sid: "3".repeat(32), language: "en", stripeAccountId: "acct_synthetic03" } as unknown as Store;
const DAY = 86_400;
// April 1: Month 1 opens on May 1, and May 2 is in the same calendar month (a store that pays nothing counts by it).
const start = Math.floor(Date.UTC(2026, 3, 1, 12) / 1000);
const opens = start + 30 * DAY;
const origin = "https://marktmorgen.example";

const session = (id: string, created: number) => ({
  id, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", created,
  metadata: { store: store.handle, product: product.id },
  payment_intent: { object: "payment_intent", latest_charge: { object: "charge", amount: 4900, amount_refunded: 0, refunded: false } },
});

async function enrol(who: string) {
  await recordEnrollment(store, who, product.id, start);
  await redis.pipeline([["HSET", `nl:course:${courseId}:students`, emailKey(who), JSON.stringify({ e: who, s: start, l: start })]]);
}

async function run(now: number): Promise<string[]> {
  mail.sent = [];
  await sendDripEmails(async (handle) => (handle === store.handle ? store : null), async (id) => (id === courseId ? course : null), origin, now);
  return mail.sent.map((m) => m.subject);
}
const sessionsAsked = () => stripe.asked.filter((p) => p.startsWith("/checkout/sessions?")).length;

/** Replies of this shape, once, for the command `match` picks, which still runs; every other reply as Redis gives it. */
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

async function fresh(students: string[]) {
  redis.clear();
  odd = null;
  counted.asked = [];
  counted.left = Number.MAX_SAFE_INTEGER;
  catalog.listings = [product];
  stripe.fail = false;
  stripe.sessions = [session("cs_test_month", start)];
  stripe.asked = [];
  await registerDrip(store, product, course);
  for (const who of students) await enrol(who);
}

async function main() {
  // The figure of one month: as many one-course reads as the store may email in it.
  const reads = allowanceFor(store, "email", opens);
  const students = Array.from({ length: reads + 1 }, (_, n) => `month-student-${n}@example.test`);

  part("One window reads at most the store's monthly figure; a second run in it reads nobody more");
  await fresh(students);
  const first = await run(opens);
  is(`the first run announces Month 1 to ${reads} students`, first.length, reads);
  is("and reads that many students at Stripe", sessionsAsked(), reads);
  stripe.asked = [];
  is("the next day, in the same month, nothing more is announced", await run(opens + DAY), []);
  is("and nobody is read at Stripe", sessionsAsked(), 0);

  part("A store that pays nothing reads only with one of the month's places");
  await fresh([students[0]]);
  await redis.pipeline([["SET", `nl:free:n:${calendarWindow(opens * 1000).id}`, String(1_000_000), "EX", 40 * DAY]]);
  is("no place this month: nothing is announced", await run(opens), []);
  is("and nobody is read at Stripe", sessionsAsked(), 0);

  part("The month's count read in another shape: nothing is read or sent that run, and the next run sends it");
  await fresh([students[0]]);
  odd = { match: (c) => c[0] === "INCRBY" && String(c[1]).startsWith("nl:dripstart:"), reply: "QUEUED" };
  is("unknown: nothing is announced", await run(opens), []);
  is("and nobody is read at Stripe", sessionsAsked(), 0);
  is("the next run announces it, never skipped", await run(opens + DAY), ["Now open in Month course: Month 1"]);

  part("The figure is a plan line, and the stores that pay nothing carry their share");
  const line = COST_LINES.find((one) => one.id === "drip-start-read");
  is("a line prices the drip job's start reads", Boolean(line), true);
  for (const tier of ["creator", "pro", "scale"] as const) {
    const month = STORE_ALLOWANCES[tier].email * dripStartUnits(1) * laterPageCost();
    is(`${tier}: the store's monthly figure at a later page's cost`, line ? Math.abs(line.monthlyUsd(tier) - month) < 1e-12 : false, true);
  }
  is("it is no longer kept out as not a cost", Object.keys(NOT_A_COST).filter((name) => name.startsWith("DRIP_")), []);
  is("a store that pays nothing counts it in its worst window", nonPayingWorst.toString().includes("drip-start-read"), true);
  done();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
