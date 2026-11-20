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
import { storeIdCommand } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { PAYPAL_PENDING_SWEEP, PAYPAL_REFUND_KEPT, PAYPAL_REFUND_WATCH } from "./plan-cost-registry";
import { ORDER_WRITE } from "@/lib/order-data";
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
    // The live store's id key, which the refund watch's fence reads before it puts an order back (Codex G-1144).
    ["SET", storeIdCommand(store.sid)[1], store.email],
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

  part("Retrying the refund watch keeps the refund in the day it was first seen");
  await setup();
  captures.set(CAPTURE, "REFUNDED");
  const dayStart = Math.floor(NOW / 86_400) * 86_400 + 86_400;
  const firstSeen = dayStart - 60;
  const nextTry = dayStart + 3600;
  const realNow = Date.now;
  try {
    Date.now = () => firstSeen * 1000;
    await answering("EVAL", `nl:ppsell:back:${SID}`, "garbled", () => watch());
    const initial = await readPayPalRefundsWithCoverage(SID, 0);
    is("the first attempt records the time the refund was seen", initial.rows[0]?.at, firstSeen);

    Date.now = () => nextTry * 1000;
    await watch();
    is("the follow-up finishes checking the order", redis.run(["ZSCORE", `nl:ppsell:watch:${SID}`, ORDER]), null);
    const reading = await readPayPalRefundsWithCoverage(SID, 0);
    is("the original refund time stays put", reading.rows[0]?.at, firstSeen);
    const nextDay = await readPayPalRefundsWithCoverage(SID, dayStart);
    is("the next day does not include the previous day's refund", nextDay.rows.length, 0);
  } finally {
    Date.now = realNow;
  }

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

  // Claude 7 on #3464 (MÉDIO, cost): the watch's lasting write is one ORDER_WRITE EVAL a refund look, tried again an
  // hour on while it fails; tests/plan-cost-registry.ts prices it (PAYPAL_REFUND_KEPT), never "not certified".
  part("The lasting write's commands are the cost line's, retries included");
  {
    /** The order put back on the watch, fenced against the store's erasure (lib/paypal-sales.ts, PAYPAL_WATCH_IF_LIVE). */
    const fencedPutBack = (c: (string | number)[]) =>
      c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:paypal-watch-if-live:v1") && c.includes(`nl:ppsell:watch:${SID}`) && c[c.length - 1] === ORDER;
    const scripts = async (run: () => Promise<unknown>) => {
      const original = redis.pipeline;
      const sent: (string | number)[][] = [];
      redis.pipeline = async (commands) => {
        sent.push(...commands);
        return original.call(redis, commands);
      };
      try {
        await run();
      } finally {
        redis.pipeline = original;
      }
      const kept = sent.filter((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:order-write:v1") && c.some((a) => String(a).startsWith(`nl:ppsell:back:${SID}`)));
      return { kept, sent };
    };
    await setup();
    captures.set(CAPTURE, "REFUNDED");
    const ok = await scripts(() => watch());
    is("one ORDER_WRITE script a refund look", ok.kept.length, PAYPAL_REFUND_KEPT.scriptsPerRefundLook);
    is("carrying one write, the HSETNX", ok.kept.map((c) => [Number(c[2 + Number(c[2]) + 1]), c[2 + Number(c[2]) + 2]]), [[PAYPAL_REFUND_KEPT.writesPerScript, "HSETNX"]]);
    // The script's own calls for one HSETNX field at its dearest (lib/order-data.ts, ORDER_WRITE): EXISTS, TYPE,
    // HEXISTS and HSTRLEN before, the HSETNX, HEXISTS and HSTRLEN after, the room's two HGETs and its HSET; with EVAL.
    const calls = ["EXISTS", "TYPE", "HEXISTS", "HSTRLEN", "HSETNX", "HEXISTS", "HSTRLEN", "HGET", "HGET", "HSET"];
    is("every call counted is one the script makes", calls.every((name) => name === "HSETNX" || ORDER_WRITE.includes(`redis.call('${name}'`)), true);
    is("the line counts the script and each of its calls", PAYPAL_REFUND_KEPT.commandsPerScriptAtMost >= 1 + calls.length, true);
    await setup();
    captures.set(CAPTURE, "REFUNDED");
    const failed = await scripts(() => answering("EVAL", `nl:ppsell:back:${SID}`, "garbled", () => watch()));
    // Put back an hour on only while the store is live (Codex G-1144): one fenced script, billed as its EVAL and the
    // three calls it runs (EXISTS, HEXISTS, ZADD).
    const again = failed.sent.filter((c) => fencedPutBack(c));
    const billed = again.reduce((sum, c) => sum + 1 + (String(c[1]).match(/redis\.call\(/g) ?? []).length, 0);
    is("a failed write is one script and one fenced put-back an hour on", [failed.kept.length, again.length, billed], [PAYPAL_REFUND_KEPT.scriptsPerRefundLook, 1, PAYPAL_REFUND_KEPT.retryWritesPerFailedLook]);
    is("tried again at most hourly, as the watch's looks", PAYPAL_REFUND_KEPT.looksPerDayAtMost, PAYPAL_REFUND_WATCH.looksPerOrderPerDayAtMost);
    is("and no longer than the watch keeps the order", PAYPAL_REFUND_KEPT.daysAtMost, PAYPAL_REFUND_WATCH.daysWatchedAtMost);

    // Claude 6 on #3464 (MEDIUM, cost): a failed look is looked at again an hour on, and each later look runs the whole
    // taken-back path again before the lasting write: the refund mark's ZADD and EXPIRE, and for a capture reversed,
    // failed or declined also its own mark's. The WHOLE command list of a failed look is held to the lines' sum, so
    // no step in that path can go uncounted: the run's two list reads (the pending sweep's and the watch's), the watch
    // line's own two (the paid record's GET and the list write), the one script, and the marks (PAYPAL_REFUND_KEPT).
    // The sibling retry (rule 30): a buyer's record read whose reply is not exact also puts the order back an hour on,
    // after the marks and the script; its one HGET is the buyer's record of PAYPAL_REFUND_WATCH's open gap (main's).
    const failures = [
      { name: "the lasting write", command: "EVAL", prefix: `nl:ppsell:back:${SID}`, reply: "garbled" as unknown },
      { name: "the buyer's record read", command: "HGET", prefix: `nl:imp:buy:${SID}`, reply: 42 as unknown },
    ];
    for (const status of ["REFUNDED", "REVERSED"]) for (const failure of failures) {
      await setup();
      captures.set(CAPTURE, status);
      const look = await scripts(() => answering(failure.command, failure.prefix, failure.reply, () => watch()));
      const label = `${status}, ${failure.name} unknown`;
      is(`${label}: looked at again an hour on, one script`, [look.kept.length, look.sent.filter((c) => fencedPutBack(c)).length], [1, 1]);
      const counted = [
        (c: (string | number)[]) => failure.command === "HGET" && c[0] === "HGET" && String(c[1]).startsWith(failure.prefix),
        (c: (string | number)[]) => c[0] === "ZRANGEBYSCORE" && c[1] === `nl:ppsell:pending:${SID}`,
        (c: (string | number)[]) => c[0] === "ZRANGEBYSCORE" && c[1] === `nl:ppsell:watch:${SID}`,
        (c: (string | number)[]) => c[0] === "GET" && c[1] === `nl:ppsell:paid:${ORDER}`,
        (c: (string | number)[]) => fencedPutBack(c),
        (c: (string | number)[]) => look.kept.includes(c),
      ];
      const rest = [...look.sent];
      for (const named of counted) {
        const at = rest.findIndex(named);
        if (at >= 0) rest.splice(at, 1);
      }
      const marks = new Set([`nl:ppsell:refunded:${SID}`, `nl:ppsell:reversed:${SID}`]);
      is(`${label}: every other command of a failed look is a take-back mark (ZADD or EXPIRE of its set)`, rest.every((c) => (c[0] === "ZADD" || c[0] === "EXPIRE") && marks.has(String(c[1]))), true);
      is(`${label}: the marks of a failed look are within the line`, rest.length <= PAYPAL_REFUND_KEPT.markCommandsPerRefundLookAtMost, true);
      is(
        `${label}: the whole failed look is within the lines' sum`,
        look.sent.length - (failure.command === "HGET" ? 1 : 0) <=
          PAYPAL_PENDING_SWEEP.listReadsPerStoreRun +
            PAYPAL_REFUND_WATCH.listReadsPerStoreRun +
            PAYPAL_REFUND_WATCH.ownCommandsPerOrderLook +
            PAYPAL_REFUND_KEPT.scriptsPerRefundLook +
            PAYPAL_REFUND_KEPT.markCommandsPerRefundLookAtMost,
        true,
      );
    }
  }

  part("The refund seen twice, in the lasting record and in the set, counts once");
  await setup();
  captures.set(CAPTURE, "REFUNDED");
  await watch();
  is("refunded once, the sale's cents", (await lineOf(`paypal:${ORDER}`))?.refunded, 4900);
  done();
}

void main();
