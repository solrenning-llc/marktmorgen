/**
 * The reminders before a booked call (lib/call-reminders.ts), sent by the
 * five-minute mail job, under a sender whose answer is not known (rule 30, a
 * sibling of 283 [HG2]'s sendEmailOutcome).
 *
 * A timeout, a server error or a network error after the request may have
 * reached the sender can mean the email went. The reminder's mark is then
 * kept, so the next run, five minutes on, never writes to the buyer or the
 * creator again; only a certain refusal, or an error before the sender was
 * asked, lets the mark go so the next run tries once more. Stripe and the
 * sender are played by a stand-in for `fetch`; no real email is sent.
 * Checked over several runs of the job:
 *
 *   - a 500 to the buyer: asked once, its mark kept;
 *   - a thrown request (network error) to the buyer: the same;
 *   - a 500 to the creator: asked once, its mark kept;
 *   - a 422 (a certain refusal) to the buyer: tried again on the next run
 *     and sent then (control: unchanged behavior);
 *   - an error before the buyer's email was asked for (the room could not be
 *     read): the buyer's mark is let go and the next run sends it once; the
 *     creator's reminder of that booking still goes on the first run;
 *   - a plain yes: sent once (control).
 */
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import type { CallSetup } from "@/lib/call-setup";
import { REMINDER_QUEUE, reminderMember } from "@/lib/call-records";
import { sendCallReminders } from "@/lib/call-reminders";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "owner@example.com";
const HOUR = 3_600_000;

/** Every email the sender was asked for, taken or not. */
const asked: { to: string; subject: string }[] = [];
/** How the sender answers one email, when not plainly yes. */
let senderSays: (to: string, subject: string) => (() => Response) | null = () => null;
let paidRows: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string };
    const to = [body.to].flat()[0] ?? "";
    asked.push({ to, subject: body.subject });
    const special = senderSays(to, body.subject);
    if (special) return special();
    return answer({ id: `email_${asked.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") return answer({ object: "list", data: paidRows, has_more: false });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const setup = (room: string) =>
  ({
    kind: "weekly",
    minutes: 60,
    tz: "America/New_York",
    weekly: [[[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]]],
    noticeHours: 12,
    horizonDays: 30,
    bufferMinutes: 0,
    room,
    video: false,
    meet: null,
    seats: 1,
    sessions: [],
  }) as unknown as CallSetup;

function answerOf(status: number): Response {
  return new Response(JSON.stringify({ message: status >= 500 ? "internal" : "invalid recipient" }), { status });
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_uncertain_call_reminders_stand_in";
  process.env.RESEND_API_KEY = "re_test_call_reminder_only";

  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0002", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00002", subscriptionId: "sub_Owner00002", active: true, period: paidPeriod() });
  const coaching = await addProduct(OWNER, "Coaching Call", "", "120", null);
  const review = await addProduct(OWNER, "Portfolio Review", "", "90", null);
  if (!coaching.ok || !review.ok) throw new Error("no product");
  await setProductCall(OWNER, coaching.product.id, setup("https://example.com/room"));
  await setProductCall(OWNER, review.product.id, setup("https://example.com/review-room"));
  const store = (await storeForEmail(OWNER))!;
  if (!store.callsId) throw new Error("no calls id");
  const callsId = store.callsId;

  // Due "a day before" reminders, each for a call three hours or so from now, at a time of its own.
  const now = Date.now();
  const bookings = [
    { session: "cs_test_una00000000001", email: "una@example.com", product: coaching.product.id },
    { session: "cs_test_tom00000000001", email: "tom@example.com", product: coaching.product.id },
    { session: "cs_test_rex00000000001", email: "rex@example.com", product: coaching.product.id },
    { session: "cs_test_ola00000000001", email: "ola@example.com", product: coaching.product.id },
    { session: "cs_test_ivy00000000001", email: "ivy@example.com", product: coaching.product.id },
    { session: "cs_test_cy000000000001", email: "cy@example.com", product: review.product.id },
  ].map((b, i) => ({ ...b, start: Math.floor((now + 3 * HOUR + i * 7 * 60_000) / 60_000) * 60_000 }));
  paidRows = bookings.map((b) => ({
    id: b.session,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    created: Math.floor(now / 1000) - 3_600,
    amount_total: 12_000,
    currency: "usd",
    customer_details: { email: b.email },
    metadata: { store: "harbor", product: b.product, kind: "call", start: String(b.start), end: String(b.start + HOUR), tz: "Europe/Lisbon" },
  }));
  for (const b of bookings) redis.run(["ZADD", REMINDER_QUEUE, b.start - 24 * HOUR, reminderMember(callsId, "harbor", b.session, "24", b.start)]);

  senderSays = (to, subject) => {
    if (to === "una@example.com") return () => answerOf(500);
    if (to === "tom@example.com") return () => {
      throw new TypeError("fetch failed: the connection was reset");
    };
    if (to === "rex@example.com") return () => answerOf(422);
    if (to === OWNER && subject.includes("Portfolio Review")) return () => answerOf(500);
    return null;
  };
  // The room of Ivy's booking cannot be read on the first run: nothing was asked of the sender for her.
  const ivyRoom = `nl:call:room:${callsId}:b:cs_test_ivy00000000001`;
  let roomFails = true;
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    // The room is read with GET, or with MGET among the booking's other keys (lib/call-rooms.ts roomsFor, #3545).
    if (roomFails && commands.some((c) => (c[0] === "GET" && c[1] === ivyRoom) || (c[0] === "MGET" && c.slice(1).includes(ivyRoom)))) {
      // Once only: the creator's reminder of the same booking reads the room again, and gets it.
      roomFails = false;
      throw new Error("synthetic: the room could not be read");
    }
    return pipeline(commands);
  }) as typeof redis.pipeline;

  const buyerAsks = (email: string) => asked.filter((m) => m.to === email).length;
  const creatorAsks = (title: string) => asked.filter((m) => m.to === OWNER && m.subject.includes(title)).length;
  const run = () => sendCallReminders(async (handle) => (handle === "harbor" ? storeForEmail(OWNER) : null), Date.now() + 20_000, "https://marktmorgen.com");

  part("The first run");
  await run();
  is("each buyer whose email could be written was asked once; Ivy not at all", bookings.map((b) => buyerAsks(b.email)), [1, 1, 1, 1, 0, 1]);
  is("the creator was asked once for each call time, Ivy's included", [creatorAsks("Coaching Call"), creatorAsks("Portfolio Review")], [5, 1]);

  part("Five minutes on, and again: an answer not known is never sent twice");
  senderSays = () => null;
  await run();
  await run();
  is("a 500 to the buyer: not asked again", buyerAsks("una@example.com"), 1);
  is("a thrown request to the buyer: not asked again", buyerAsks("tom@example.com"), 1);
  is("a 500 to the creator: not asked again", creatorAsks("Portfolio Review"), 1);
  is("a certain refusal (422) to the buyer: asked again on the next run, once", buyerAsks("rex@example.com"), 2);
  is("an error before the sender was asked: the buyer's reminder goes on the next run, once", buyerAsks("ivy@example.com"), 1);
  is("the plain yes: not asked again", buyerAsks("ola@example.com"), 1);
  is("the creator's reminders of the coaching call times: each once", creatorAsks("Coaching Call"), 5);
  redis.pipeline = pipeline;

  part("The marks");
  const mark = (session: string, start: number) => redis.run(["EXISTS", `nl:call:reminded:${session}:${start}:24`]);
  is("the uncertain ones keep the buyer's mark", [mark(bookings[0].session, bookings[0].start), mark(bookings[1].session, bookings[1].start)], [1, 1]);
  is("the creator's uncertain one keeps the creator's mark", redis.run(["EXISTS", `nl:call:creator-reminded:${callsId}:${review.product.id}:${bookings[5].start}:24`]), 1);
  const [left] = await pipeline([["ZRANGEBYSCORE", REMINDER_QUEUE, 0, "+inf"]]);
  is("nothing is left in the queue", left, []);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
