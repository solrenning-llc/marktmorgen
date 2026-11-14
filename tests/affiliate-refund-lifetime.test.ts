/**
 * A PayPal refund lives as long as the affiliate line it takes back (HIGH,
 * found in the pre-review of the PayPal partial refund, 9 November 2026).
 *
 * The affiliate book's lines (nl:aff:<stats>:sales and :shares) are kept for
 * good, but what said a PayPal sale was refunded did not live as long:
 *
 *   - P4: the refund's mark (nl:ppsell:refunded:<stats>) outlives the paid
 *     record it names (nl:ppsell:paid:<order>, PAID_KEPT_SECONDS, 400 days),
 *     because the set's expiry is renewed by every later refund. From then on
 *     the reading of PayPal's refunds was partial and the whole book stayed
 *     unchecked: no affiliate of the store could be paid, ever again.
 *   - P3: once the set itself expired (400 days after the store's last
 *     refund), the refunded sale read as "earned" again and its whole
 *     commission, and every partner's share of it, became payable.
 *
 * Now the refund watch writes the refund down for good, by the payment as
 * the book names it (nl:ppsell:back:<stats>, a field per refunded payment,
 * charged to the store's room through lib/order-data.ts), before the order
 * leaves the watch; the book reads it for its own PayPal payments only. The
 * set stays a short-lived index for the other readers, and one of its marks
 * whose paid record is gone is matched to the book's line by its order: a
 * refund in full of that line, never a reason to leave the whole book
 * unchecked. Unknown stays unknown (rule 24): a write or a read whose reply
 * is not exact keeps the order watched, or the book unchecked.
 *
 * Synthetic only: the Redis stub and a stand-in for PayPal's API answering
 * the token and a capture's status.
 */
import { creditPayPalSale, readBook } from "@/lib/affiliates";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { readFileSync } from "node:fs";
import { AFFILIATE_ENTRY_BYTES, BOOK_KEPT_REFUND_BYTES } from "@/lib/api-read-rules";
import { PAYPAL_REFUNDS_READ, type Paid, readPayPalRefundsWithCoverage, watchPayPal } from "@/lib/paypal-sales";
import { payableLines } from "@/lib/paypal-payouts";
import type { Store } from "@/lib/store";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = Math.floor(Date.now() / 1000);
// Forty days old: inside PayPal's refund window, so the watch asks about it.
const PAID_AT = NOW - 40 * 86_400;
const SID = "synthetic-refund-lifetime";
const AFF = "aaaaaaaaaaaa";
const PARTNER = "bbbbbbbbbbbb";
const ORDER = "5O190127TN3647102";
const CAPTURE = "3C679366HH908702";
const OTHER_ORDER = "6O190127TN3647106";
const OTHER_CAPTURE = "4C679366HH908706";
const SELLER = "7KNGBPH2U58GQ";

process.env.PAYPAL_PARTNER_CLIENT_ID = "AZpartnerClientId0123456789";
process.env.PAYPAL_PARTNER_SECRET = "EPpartnerSecret0123456789";
process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";
delete process.env.PAYPAL_ENV;

const captures = new Map<string, string>();
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AApartner", token_type: "Bearer", expires_in: 32400 });
  const cap = /^\/v2\/payments\/captures\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (cap) return json({ id: cap, status: captures.get(cap) ?? "COMPLETED" });
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

const store = {
  sid: "synthetic-lifetime-store",
  statsId: SID,
  handle: "synthetic-lifetime-shop",
  name: "Synthetic shop",
  email: "owner@example.com",
  currency: "usd",
  previousHandles: [],
  releasedHandles: [],
  paypalSeller: { merchant: SELLER, at: 1 },
  affiliates: { ...NO_AFFILIATES, enabled: true, percent: 30, hold: 0 },
} as unknown as Store;

const paid: Paid = { store: SID, order: ORDER, capture: CAPTURE, email: "buyer@example.com", product: "course", cents: 4900, currency: "usd", at: PAID_AT, via: { aff: AFF, rate: 30 } } as Paid;
const other: Paid = { ...paid, order: OTHER_ORDER, capture: OTHER_CAPTURE, email: "other@example.com" } as Paid;

let told = 0;
const on = { handOver: async () => undefined, dropStart: async () => undefined, refunded: async () => void (told += 1) };
const watch = () => watchPayPal(store, Date.now() + 10_000, on);

const person = (id: string, email: string, share?: unknown) =>
  JSON.stringify({ id, email, code: `code${id.slice(0, 4)}`, status: "approved", appliedAt: 1, decidedAt: 1, note: "", ...(share ? { share } : {}) });

/** The affiliate (and, with `partner`, a partner sharing in the product), two PayPal sales on the book, and ORDER due on the refund watch. */
async function setup(partner = false): Promise<void> {
  redis.clear();
  told = 0;
  captures.clear();
  await redis.pipeline([
    ["HSET", `nl:aff:${SID}:people`, AFF, person(AFF, "affiliate@example.com")],
    ...(partner ? [["HSET", `nl:aff:${SID}:people`, PARTNER, person(PARTNER, "partner@example.com", { percent: 20, products: ["course"] })]] : []),
  ]);
  await creditPayPalSale(store, paid, "Synthetic course");
  await creditPayPalSale(store, other, "Synthetic course");
  await redis.pipeline([
    ["SET", `nl:ppsell:paid:${ORDER}`, JSON.stringify(paid)],
    ["SET", `nl:ppsell:paid:${OTHER_ORDER}`, JSON.stringify(other)],
    ["ZADD", `nl:ppsell:watch:${SID}`, "0", ORDER],
  ]);
}

/** Whether the book is checked, and what it would pay each affiliate (nothing while it is not checked). */
async function offered(): Promise<{ checked: boolean; to: Map<string, number> }> {
  const book = await readBook(store);
  const to = new Map<string, number>();
  if (book.refundsChecked) for (const line of payableLines(book, new Set())) to.set(line.affiliate.id, (to.get(line.affiliate.id) ?? 0) + line.cents);
  return { checked: book.refundsChecked, to };
}

const lineOf = async (ref: string) => (await readBook(store)).lines.find((l) => l.ref === ref);

/** Every command whose name is `name` and that names a key starting with `prefix` answered `reply`; the rest by the stub. */
async function answering<T>(name: string, prefix: string, reply: unknown, run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  redis.pipeline = async (commands) => {
    const replies = await original.call(redis, commands);
    return commands.map((command, i) => (command[0] === name && command.some((arg) => String(arg).startsWith(prefix)) ? reply : replies[i]));
  };
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

async function main(): Promise<void> {
  console.error = () => {};

  part("Control: the watch sees the refund in full; the refunded sale earns nothing, the other is payable");
  await setup();
  captures.set(CAPTURE, "REFUNDED");
  await watch();
  is("the creator was told once", told, 1);
  const fresh = await offered();
  is("checked", fresh.checked, true);
  is("only the other sale's commission is offered (30% of 4900)", fresh.to.get(AFF), 1470);
  is("the refunded line says refunded", (await lineOf(`paypal:${ORDER}`))?.status, "refunded");

  part("P4: the paid record expires (400 days) before the refund's mark: the rest of the book stays payable");
  await setup();
  captures.set(CAPTURE, "REFUNDED");
  await watch();
  await redis.pipeline([["DEL", `nl:ppsell:paid:${ORDER}`]]);
  const p4 = await offered();
  is("the book stays checked", p4.checked, true);
  is("the other sale is still offered", p4.to.get(AFF), 1470);
  is("the refunded line is still refunded", (await lineOf(`paypal:${ORDER}`))?.status, "refunded");

  part("P3: the refunds' set expires (400 days after the last refund): the refunded sale never becomes payable again");
  await setup();
  captures.set(CAPTURE, "REFUNDED");
  await watch();
  await redis.pipeline([["DEL", `nl:ppsell:refunded:${SID}`], ["DEL", `nl:ppsell:paid:${ORDER}`]]);
  const p3 = await offered();
  is("checked", p3.checked, true);
  is("only the other sale's commission is offered, never the refunded one's", p3.to.get(AFF), 1470);
  const kept = await lineOf(`paypal:${ORDER}`);
  is("the refunded line is still refunded", kept?.status, "refunded");
  is("refunded once, the sale's cents", kept?.refunded, 4900);

  part("P3 for a partner's share of the refunded sale (rule 30)");
  await setup(true);
  captures.set(CAPTURE, "REFUNDED");
  await watch();
  await redis.pipeline([["DEL", `nl:ppsell:refunded:${SID}`], ["DEL", `nl:ppsell:paid:${ORDER}`]]);
  const share = await lineOf(`paypal:${ORDER}:${PARTNER}`);
  is("the partner's share of the refunded sale is refunded", share?.status, "refunded");
  is("and earns nothing", share?.commission, 0);
  const shares = await offered();
  is("checked", shares.checked, true);
  is("the partner is offered only the other sale's share (20% of 4900)", shares.to.get(PARTNER), 980);

  part("A mark whose paid record is gone, for an order the book has no line of: the book stays checked");
  await setup();
  await redis.pipeline([["ZADD", `nl:ppsell:refunded:${SID}`, String(NOW), "9O190127TN3647109"]]);
  const stranger = await offered();
  is("checked", stranger.checked, true);
  is("both sales offered", stranger.to.get(AFF), 2940);

  part("A mark whose paid record is gone, for an order on the book: a refund in full of its line, never the whole book unchecked");
  await setup();
  await redis.pipeline([["ZADD", `nl:ppsell:refunded:${SID}`, String(NOW), ORDER], ["DEL", `nl:ppsell:paid:${ORDER}`]]);
  const legacy = await offered();
  is("checked", legacy.checked, true);
  is("only the other sale's commission is offered", legacy.to.get(AFF), 1470);

  part("Unknown: the refund's lasting record not known written keeps the order watched, an hour on, untold");
  await setup();
  captures.set(CAPTURE, "REFUNDED");
  await answering("EVAL", `nl:ppsell:back:${SID}`, "garbled", () => watch());
  is("not told", told, 0);
  const score = Number((await redis.pipeline([["ZSCORE", `nl:ppsell:watch:${SID}`, ORDER]]))[0]);
  is("still watched, about an hour on", score >= NOW + 3000 && score <= NOW + 4000, true);
  is("meanwhile the set's mark takes the refunded sale back", (await offered()).to.get(AFF), 1470);

  part("Unknown: the book's read of the lasting refunds not exact leaves it unchecked");
  await setup();
  captures.set(CAPTURE, "REFUNDED");
  await watch();
  await redis.pipeline([["DEL", `nl:ppsell:refunded:${SID}`]]);
  const garbled = await answering("HMGET", `nl:ppsell:back:${SID}`, "garbled", () => offered());
  is("not checked", garbled.checked, false);
  is("nothing offered", garbled.to.size, 0);

  // Changed in the second unit (pre-review of 50bc3b0f26, MEDIUM 2): the book no longer lists the set since its
  // oldest line (a listing capped at PAYPAL_REFUNDS_READ, cut for good once a store passed it); it asks the set about
  // its own orders only. The exact listing is still the store's numbers' (was: the book read through the listing).
  part("Unknown: the set's listing not exact is a reading that covered nothing, never \"no refunds\" (rule 24)");
  await setup();
  await redis.pipeline([["ZADD", `nl:ppsell:refunded:${SID}`, String(NOW), ORDER]]);
  // Since main's exact reading (tests/paypal-refunds-score-exact.test.ts), a listing not exact throws instead of answering
  // partial; its callers (lib/stats.ts, lib/segments.ts) take the throw as an unread reading, so it is never "no refunds".
  const listing = await answering("ZRANGEBYSCORE", `nl:ppsell:refunded:${SID}`, "garbled", () => readPayPalRefundsWithCoverage(SID, 0)).catch((error: unknown) => error);
  is("the numbers' reading is refused as unknown, never read as complete", listing instanceof UnknownReplyError, true);

  part("Unknown: the book's question to the set about its own orders not exact leaves it unchecked");
  await setup();
  await redis.pipeline([["ZADD", `nl:ppsell:refunded:${SID}`, String(NOW), ORDER]]);
  const asked = await answering("ZMSCORE", `nl:ppsell:refunded:${SID}`, "garbled", () => offered());
  is("not checked", asked.checked, false);
  is("nothing offered", asked.to.size, 0);

  part("Pre-review A: more refunds than PAYPAL_REFUNDS_READ, all kept for good: the book stays checked");
  await setup();
  captures.set(CAPTURE, "REFUNDED");
  await watch();
  const crowd: (string | number)[][] = [];
  for (let i = 0; i < PAYPAL_REFUNDS_READ; i += 1) {
    const order = `7O${String(i).padStart(15, "0")}`;
    const capture = `5C${String(i).padStart(14, "0")}`;
    crowd.push(["SET", `nl:ppsell:paid:${order}`, JSON.stringify({ ...paid, order, capture, via: undefined })]);
    crowd.push(["ZADD", `nl:ppsell:refunded:${SID}`, String(NOW - 60), order]);
    crowd.push(["HSET", `nl:ppsell:back:${SID}`, `paypal:${capture}`, String(NOW - 60)]);
  }
  await redis.pipeline(crowd);
  const many = await offered();
  is("checked", many.checked, true);
  is("the other sale is offered", many.to.get(AFF), 1470);
  is("the refunded one is not", (await lineOf(`paypal:${ORDER}`))?.status, "refunded");

  part("A partial refund's member (part:<order>, the partial refund's unit) is not a cut of the numbers' reading");
  await setup();
  await redis.pipeline([["ZADD", `nl:ppsell:refunded:${SID}`, String(NOW), `part:${OTHER_ORDER}`]]);
  is("not partial", (await readPayPalRefundsWithCoverage(SID, 0)).partial, false);
  is("and the book stays checked", (await offered()).checked, true);

  part("The book's questions are cut in slices, never one command past BOOK_KEPT_SLICE fields");
  await setup();
  const sales: Paid[] = [];
  for (let i = 0; i < 520; i += 1) sales.push({ ...paid, order: `8O${String(i).padStart(15, "0")}`, capture: `6C${String(i).padStart(14, "0")}`, email: `b${i}@example.com` } as Paid);
  for (const sale of sales) await creditPayPalSale(store, sale, "Synthetic course");
  const widths: number[] = [];
  const original = redis.pipeline;
  redis.pipeline = async (commands) => {
    for (const command of commands) if (command[0] === "HMGET" && String(command[1]).startsWith("nl:ppsell:back:")) widths.push(command.length - 2);
    for (const command of commands) if (command[0] === "ZMSCORE") widths.push(command.length - 2);
    return original.call(redis, commands);
  };
  try {
    await readBook(store);
  } finally {
    redis.pipeline = original;
  }
  is("each question asks at most 500 fields", widths.length >= 4 && widths.every((n) => n > 0 && n <= 500), true);

  part("Pre-review C: the public page's price of the book counts the new reads' bytes");
  const registry = readFileSync("tests/plan-cost-registry.ts", "utf8");
  const page = registry.slice(registry.indexOf("export function affiliatePageRead("), registry.indexOf("export function affiliateLoadRead("));
  is("affiliatePageRead counts BOOK_KEPT_REFUND_BYTES a field", page.includes("BOOK_KEPT_REFUND_BYTES"), true);
  // Corrected in the fix commit (rule 23): a bulk string's framing is at most 8 bytes ("$NN\r\n" and "\r\n"), not 16;
  // the names and answers are those of the code: "paypal:" and 64, a time of 12, an order of 36, a score of 24.
  is("what one answer and its name weigh is counted, both questions (HMGET and ZMSCORE)", BOOK_KEPT_REFUND_BYTES >= 4 * 8 + 71 + 12 + 36 + 24, true);
  is("the entry's own bytes are still counted", AFFILIATE_ENTRY_BYTES, 4_096);

  part("The refund seen twice, in the lasting record and in the set, counts once");
  await setup();
  captures.set(CAPTURE, "REFUNDED");
  await watch();
  is("refunded once, the sale's cents", (await lineOf(`paypal:${ORDER}`))?.refunded, 4900);
  done();
}

void main();
