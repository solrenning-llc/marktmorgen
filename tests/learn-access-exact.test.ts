/**
 * Who may open a paid course reads Stripe's list of checkouts exactly (CX-123 rules 24 and 30; Claude 5, 9 November
 * 2026). lib/learn.ts paidAtStripe asks the creator's Stripe account which checkouts an address paid, and
 * courseLedger decides from it, for every course page, lesson, download and emailed course link, what opens.
 *
 * The list was read as `Array.isArray(data) ? data : []` and only its first page, and a failed read became "bought
 * nothing". Both directions were wrong:
 *
 *   - a paying member lost the course without a word (the page offered to sell it again), and a garbled answer was
 *     kept for ten minutes, so a good answer right after it changed nothing;
 *   - a one-off course written down on the thanks page and since refunded in full opened again, because "refunded"
 *     could not be read;
 *   - a purchase on a later page was never read.
 *
 * Now a page in another shape, a failed read or a row that does not read is unknown, never "none": what Stripe alone
 * decides is shown as "could not be confirmed, try again" (state "unknown"), nothing unpaid opens, an unknown answer is
 * never kept, every page is read to its end, and a "yes" on a readable row still stands. A kept answer in another
 * shape is asked again, never read as "nothing was refunded".
 *
 * Synthetic only: an in-memory Redis and a stand-in for the creator's Stripe account.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setStripeAccount, storeForEmail } from "@/lib/store";
import { courseAccess, emailKey, forgetPaid, mintPass, paidCourses, passCookieName, recordEnrollment, requestCourseLink, storeKey } from "@/lib/learn";
import { coursesWords } from "@/lib/buyer-words/courses";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { readListing } from "@/lib/catalog";
import { readFileSync } from "node:fs";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_learn_access_exact";
// Amazon's settings, synthetic, so a course link is not refused for want of a sender; nothing is sent in this test.
process.env.AWS_SES_ROLE_ARN = "arn:aws:iam::123456789012:role/synthetic-learn-access";
process.env.AWS_SES_REGION = "us-east-1";
process.env.AWS_SES_CONFIGURATION_SET = "synthetic";
process.env.AWS_SES_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:synthetic";

const OWNER = "teacher@example.com";
const HANDLE = "brushwork";
const ACCOUNT = "acct_1TestLearnExact";
const NOW = Math.floor(Date.now() / 1000);
const ONE_OFF_COURSE = "a".repeat(32);
const MEMBER_COURSE = "b".repeat(32);

/** Checkouts by the address they were paid from. */
const sessions: Record<string, Record<string, unknown>[]> = {};
/** When set, the answer to the list of checkouts, in place of the healthy one. */
let garble: (() => Response) | null = null;
/** How many rows a page holds: smaller than the list makes Stripe say there is more. */
let pageSize = 100;
let sessionReads = 0;
let sends = 0;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (!url.hostname.endsWith("stripe.com")) {
    sends += 1;
    return answer({ error: "no sending in this test" }, 500);
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") {
    sessionReads += 1;
    if (garble) return garble();
    const all = sessions[url.searchParams.get("customer_details[email]") ?? ""] ?? [];
    const after = url.searchParams.get("starting_after");
    const from = after ? all.findIndex((row) => row.id === after) + 1 : 0;
    const data = all.slice(from, from + pageSize);
    return answer({ object: "list", data, has_more: from + pageSize < all.length, url: "/v1/checkout/sessions" });
  }
  if (path === "/refunds") {
    // Rule 23, a fixture only (owner decision 18, C1-20261109-1054-C5-54): a charge refunded in full here has its
    // refund succeeded, its row in Stripe's real shape (its charge an id), so the course is taken off the ledger
    // and stays shut while Stripe cannot be read. Without a succeeded refund (pending) it would stay written down
    // and open (tests/learn-refund-confirmed.test.ts).
    const intent = url.searchParams.get("payment_intent") ?? "";
    const paid = Object.values(sessions).flat().find((row) => (row?.payment_intent as { id?: unknown } | null)?.id === intent);
    const charge = (paid?.payment_intent as { latest_charge?: { refunded?: unknown; amount?: unknown } } | undefined)?.latest_charge;
    const data = charge?.refunded === true
      ? [{ id: `re_${intent.slice(3)}`, object: "refund", status: "succeeded", amount: charge.amount, created: NOW - 3_600, payment_intent: intent, charge: `ch_${intent.slice(3)}` }]
      : [];
    return answer({ object: "list", data, has_more: false, url: "/v1/refunds" });
  }
  return answer({ object: "list", data: [], has_more: false, url: path });
}) as typeof fetch;

const oneOff = (id: string, product: string, refunded = false) => ({
  id,
  object: "checkout.session",
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created: NOW - 86_400,
  customer: "cus_TestLearnExact1",
  metadata: { store: HANDLE, product },
  payment_intent: {
    id: `pi_${id.slice(8)}`,
    object: "payment_intent",
    latest_charge: { object: "charge", id: `ch_${id.slice(8)}`, amount: 4900, amount_refunded: refunded ? 4900 : 0, refunded, disputed: false },
  },
});
const membership = (id: string, product: string) => ({
  id,
  object: "checkout.session",
  mode: "subscription",
  status: "complete",
  payment_status: "paid",
  created: NOW - 86_400,
  customer: "cus_TestLearnExact2",
  metadata: { store: HANDLE, product },
  payment_intent: null,
  subscription: { id: `sub_${id.slice(8)}`, object: "subscription", status: "active" },
});
/** A paid checkout for something that is not a course here: it only fills the pages. */
const filler = (n: number) => ({ ...oneOff(`cs_test_fill${String(n).padStart(8, "0")}`, "not-a-course"), metadata: { store: "elsewhere", product: "x" } });

const GARBLED: [string, () => Response][] = [
  ["no list (an empty object)", () => new Response("{}", { status: 200 })],
  ["data not a list", () => new Response(JSON.stringify({ object: "list", data: "none", has_more: false }), { status: 200 })],
  ["data null", () => new Response(JSON.stringify({ object: "list", data: null, has_more: false }), { status: 200 })],
  ["has_more missing", () => new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 })],
  ["a bare list", () => new Response("[]", { status: 200 })],
  ["Stripe failing (500)", () => new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 })],
];

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Brushwork", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  const single = await addProduct(OWNER, "Ink Basics", "", "49", null);
  const club = await addProduct(OWNER, "Ink Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!single.ok || !club.ok) throw new Error("no product");
  await setProductCourse(OWNER, single.product.id, { id: ONE_OFF_COURSE, lessons: 3 });
  await setProductCourse(OWNER, club.product.id, { id: MEMBER_COURSE, lessons: 3 });
  const store = (await storeForEmail(OWNER))!;
  const one = (await readListing(store, single.product.id))!;
  const member = (await readListing(store, club.product.id))!;
  const START = NOW - 86_400;

  const pass = async (email: string) => {
    const token = await mintPass(store, email, "all");
    return { get: (name: string) => (name === passCookieName(store) ? { value: token } : undefined) };
  };
  const stateOf = async (email: string, product: typeof one) => (await courseAccess(store, product, await pass(email))).state;

  part("Healthy answers decide as before (controls)");
  sessions["mia@example.com"] = [membership("cs_test_mia000000001", member.id)];
  is("a member: the membership course is open", await stateOf("mia@example.com", member), "open");
  sessions["leo@example.com"] = [oneOff("cs_test_leo000000001", one.id)];
  await recordEnrollment(store, "leo@example.com", one.id, START, "stripe");
  is("a one-off buyer: open", await stateOf("leo@example.com", one), "open");
  sessions["ref@example.com"] = [oneOff("cs_test_ref000000001", one.id, true)];
  await recordEnrollment(store, "ref@example.com", one.id, START, "stripe");
  is("a one-off refunded in full: shut, though written down on the thanks page", await stateOf("ref@example.com", one), "closed");
  is("a stranger: shut", await stateOf("nobody@example.com", one), "closed");

  part("A paying member never loses the course in silence on an answer that cannot be read");
  for (const [label, answer] of GARBLED) {
    await forgetPaid(store, "mia@example.com");
    garble = answer;
    is(`${label}: said as not confirmed, not shut`, await stateOf("mia@example.com", member), "unknown");
    is(`${label}: paidCourses does not open it either`, (await paidCourses(store, "mia@example.com")).has(member.id), false);
    garble = null;
    is(`${label}: never kept, so the next good answer opens it at once`, await stateOf("mia@example.com", member), "open");
  }

  part("A refunded course never opens again on an answer that cannot be read");
  for (const [label, answer] of GARBLED) {
    await forgetPaid(store, "ref@example.com");
    garble = answer;
    is(`${label}: refunded one-off is not open`, await stateOf("ref@example.com", one), "unknown");
    garble = null;
    is(`${label}: read again, still shut`, await stateOf("ref@example.com", one), "closed");
  }

  part("A one-off written down on the thanks page stays open while Stripe cannot be read (owner decision 18)");
  await forgetPaid(store, "leo@example.com");
  // The stranger's whole answer from the controls is kept ten minutes and rightly decides: ask again.
  await forgetPaid(store, "nobody@example.com");
  garble = GARBLED[0][1];
  // Rule 23: expected "unknown" until owner decision 18 (C1-20261109-1029-C5-52; C1-20261109-1054-C5-54): the entry is
  // proof of payment, and only a refund Stripe confirms takes it off the ledger (tests/learn-refund-confirmed.test.ts).
  is("a one-off written down, refund not readable: open (owner decision 18)", await stateOf("leo@example.com", one), "open");
  is("a stranger is not confirmed either: nothing tells the two apart, and nothing opens", await stateOf("nobody@example.com", one), "unknown");
  garble = null;
  await forgetPaid(store, "leo@example.com");
  await forgetPaid(store, "nobody@example.com");
  is("read again: the one-off buyer opens", await stateOf("leo@example.com", one), "open");
  is("read again: the stranger is shut", await stateOf("nobody@example.com", one), "closed");

  part("Every page is read: a purchase on a later page counts");
  sessions["max@example.com"] = [filler(1), filler(2), filler(3), membership("cs_test_max000000001", member.id)];
  pageSize = 2;
  sessionReads = 0;
  is("a membership on the second page: open", await stateOf("max@example.com", member), "open");
  is("both pages were read", sessionReads >= 2, true);
  sessions["rex@example.com"] = [filler(4), filler(5), oneOff("cs_test_rex000000001", one.id, true)];
  await recordEnrollment(store, "rex@example.com", one.id, START, "stripe");
  is("a refund on the second page shuts a course written down", await stateOf("rex@example.com", one), "closed");
  pageSize = 100;

  part("A row that does not read proves nothing, and a readable yes still stands");
  sessions["amy@example.com"] = [null as unknown as Record<string, unknown>, membership("cs_test_amy000000001", member.id)];
  is("a member beside a row that does not read: open", await stateOf("amy@example.com", member), "open");
  sessions["ted@example.com"] = [{ id: "cs_test_ted000000001", metadata: "garbled" }, filler(6)];
  await recordEnrollment(store, "ted@example.com", one.id, START, "stripe");
  // Rule 23: expected "unknown" until owner decision 18 (as above): what cannot be read keeps what was written down.
  is("a course written down, its refund maybe on the unreadable row: open (owner decision 18)", await stateOf("ted@example.com", one), "open");

  part("A kept answer in another shape is asked again, never read as 'nothing refunded'");
  const cacheKey = `nl:learn:paid:${storeKey(store)}:${emailKey("ref@example.com")}`;
  for (const [label, kept] of [
    ["refunded not a list", JSON.stringify({ p: {}, x: [], r: "none" })],
    ["ended not a list", JSON.stringify({ p: {}, x: null, r: [] })],
    ["a start that is not seconds", JSON.stringify({ p: { [one.id]: "soon" }, x: [], r: [] })],
    ["the old shape", JSON.stringify({ [one.id]: START })],
  ] as const) {
    await redis.pipeline([["SET", cacheKey, kept]]);
    is(`${label}: asked again, the refunded course stays shut`, await stateOf("ref@example.com", one), "closed");
  }

  part("An emailed course link is never 'sent' in silence when the purchase could not be read");
  await forgetPaid(store, "mia@example.com");
  garble = GARBLED[0][1];
  sends = 0;
  const asked = await requestCourseLink({ store, product: member, email: "mia@example.com", ip: "203.0.113.9", origin: "https://marktmorgen.com" });
  is("unknown: 'try again', not 'sent'", asked, "error");
  is("and nothing was sent", sends, 0);
  garble = null;

  part("The course page says it, in every store language, and sells nothing to the member");
  for (const code of LANGUAGE_CODES) {
    const w = coursesWords(code);
    is(`${code}: a title, a body and a way to try again`, [w.accessUnknownTitle, w.accessUnknownBody, w.accessUnknownAgain].every((s) => typeof s === "string" && s.length > 0), true);
  }
  const page = readFileSync("app/[handle]/course/[product]/page.tsx", "utf8");
  is("the page draws the unknown state", page.includes('access.state === "unknown"'), true);
  is("the page offers no checkout on it", /\) : access\.state === "unknown" \? null : \(/.test(page), true);
  is("a device's lesson places are not forgotten on it", page.includes('access.state !== "open" && access.state !== "unknown"'), true);
  // The way to try again stands alone on its line, not inside a sentence, so it is a 44 px target (WCAG 2.5.5, AX274).
  const tryAgain = /<Link href=\{base\} className="([^"]*)"[^>]*>\s*\{w\.accessUnknownAgain\}/.exec(page)?.[1] ?? "";
  is("the way to try again is a 44 px target", ["inline-flex", "min-h-11", "items-center"].every((name) => tryAgain.split(/\s+/).includes(name)), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
