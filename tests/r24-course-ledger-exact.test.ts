/**
 * Who may open a paid course reads its own records exactly (CX-123 rule 24; Claude 6 audit of the buyer side of
 * courses, 7 November 2026). lib/learn.ts courseLedger decides, for every course page, lesson, lesson download and
 * emailed course link, which courses an address may open and from when (the drip clock).
 *
 *   - A student the creator took off a course (setBlocked) stays off it. The SISMEMBER reply that says so was read
 *     loosely: anything but 1 or "1" (null, a word, a short pipeline) was read as "not taken off", so an unreadable
 *     reply opened the paid course to a removed student. Now each reply is 0 or 1, one for each course asked, or the
 *     read throws UnknownReplyError: the page fails and is tried again, and nobody is let in on a guess.
 *   - A course written down on the thanks page keeps when it began, in whole seconds. Its value was read with
 *     Number(), so an empty or missing value became 0 (1 January 1970): every drip module of the course read as
 *     already open. Now a value that is not whole seconds, or a list of fields and values that does not pair up, is
 *     unknown and throws, never "began long ago".
 *
 * Synthetic only: an in-memory Redis and a stand-in for the creator's Stripe account.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setStripeAccount, storeForEmail } from "@/lib/store";
import { paidCourses, recordEnrollment, setBlocked } from "@/lib/learn";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_course_ledger_exact";

const OWNER = "tutor@example.com";
const ACCOUNT = "acct_1TestLedger01";
const NOW = Math.floor(Date.now() / 1000);
const COURSE = "c".repeat(32);

const sessions: Record<string, Record<string, unknown>[]> = {};
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") return answer({ object: "list", data: sessions[url.searchParams.get("customer_details[email]") ?? ""] ?? [], has_more: false });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const paid = (id: string, product: string) => ({
  id,
  object: "checkout.session",
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created: NOW - 86_400,
  customer: "cus_TestLedger001",
  metadata: { store: "tutoring", product },
  payment_intent: { id: `pi_${id.slice(8)}`, latest_charge: { object: "charge", amount: 4900, amount_refunded: 0, refunded: false } },
});

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
/** Rewrites the replies to the commands this picks; everything else is answered as it is. */
let rewrite: ((commands: Command[], replies: unknown[]) => unknown[]) | null = null;
redis.pipeline = (async (commands: Command[]) => {
  const replies = (await real(commands)) as unknown[];
  return rewrite ? rewrite(commands, replies) : replies;
}) as typeof redis.pipeline;

const isBlockedRead = (command: Command) => command[0] === "SISMEMBER" && String(command[1]).endsWith(":blocked");
const isLedgerRead = (command: Command) => command[0] === "HGETALL" && String(command[1]).startsWith("nl:learn:enr:");

/** What paidCourses says: the courses with when each began, or that it threw an unknown reply. */
async function outcome(store: NonNullable<Awaited<ReturnType<typeof storeForEmail>>>, email: string): Promise<string> {
  try {
    const paidNow = await paidCourses(store, email);
    return JSON.stringify([...paidNow.entries()]);
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `threw ${String(error)}`;
  }
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "tutoring", "Tutoring", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  const made = await addProduct(OWNER, "Algebra Course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductCourse(OWNER, made.product.id, { id: COURSE, lessons: 4 });
  const product = made.product.id;
  const store = (await storeForEmail(OWNER))!;
  const START = NOW - 86_400;

  part("Exact replies decide as before");
  sessions["ana@example.com"] = [paid("cs_test_ana000000001", product)];
  await recordEnrollment(store, "ana@example.com", product, START);
  is("bought: open, from when it began", await outcome(store, "ana@example.com"), JSON.stringify([[product, START]]));
  await setBlocked(store, COURSE, "ana@example.com", true);
  is("taken off the course by the creator: shut", await outcome(store, "ana@example.com"), "[]");

  part("A removed student is never let back in on a reply that cannot be read");
  for (const [label, reply] of [
    ["no reply (null)", null],
    ["a word", "yes"],
    ["a list", [1]],
    ["a count past one", 2],
    ["a fraction", 0.5],
  ] as const) {
    rewrite = (commands, replies) => replies.map((r, i) => (isBlockedRead(commands[i]) ? reply : r));
    is(`blocked read as ${label}: unknown, not open`, await outcome(store, "ana@example.com"), "unknown");
  }
  rewrite = (commands, replies) => (commands.some(isBlockedRead) ? replies.slice(0, -1) : replies);
  is("a pipeline with one reply missing: unknown, not open", await outcome(store, "ana@example.com"), "unknown");
  rewrite = null;
  is("read exactly again: still shut", await outcome(store, "ana@example.com"), "[]");

  part("When a course began is read in whole seconds, never as 1970");
  sessions["ben@example.com"] = [paid("cs_test_ben000000001", product)];
  await recordEnrollment(store, "ben@example.com", product, START);
  is("bought: open from its real start", await outcome(store, "ben@example.com"), JSON.stringify([[product, START]]));
  for (const [label, value] of [
    ["empty", ""],
    ["missing (null)", null],
    ["a word", "soon"],
    ["negative", "-5"],
    ["a fraction", "12.5"],
  ] as const) {
    rewrite = (commands, replies) => replies.map((r, i) => (isLedgerRead(commands[i]) ? [product, value] : r));
    is(`start read as ${label}: unknown, never drip-open`, await outcome(store, "ben@example.com"), "unknown");
  }
  rewrite = (commands, replies) => replies.map((r, i) => (isLedgerRead(commands[i]) ? [product] : r));
  is("a field with no value: unknown", await outcome(store, "ben@example.com"), "unknown");
  rewrite = null;
  is("read exactly again: open from its real start", await outcome(store, "ben@example.com"), JSON.stringify([[product, START]]));

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
