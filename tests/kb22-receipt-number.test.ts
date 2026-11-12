/**
 * 601 [KB22] unit U2 (docs/reviews/c5-kb22-audit.md): every receipt a store
 * downloads carries a number of that store's own, "R-000001" upward, given
 * once to a sale and the same on every later download.
 *
 * The number is the one thing a receipt keeps (lib/receipt-number.ts): one
 * field a sale in the store's own list, taken from the store's data room in
 * the same step that writes it, erased with the store. Two stores never
 * share a count. A reply that is not exactly one the script gives makes no
 * PDF with a guessed number: the route answers 503.
 * Synthetic data only: Stripe and the database are stand-ins.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { PDFDocument } from "pdf-lib";
import {
  RECEIPT_NUMBER,
  RECEIPT_NUMBER_BYTES,
  RECEIPT_NUMBER_COMMANDS,
  RECEIPT_NUMBER_MAX,
  RECEIPT_SLOT,
  assignReceiptNumber,
  receiptCounterKey,
  receiptNumberFrom,
  receiptNumberText,
  receiptNumbersKey,
} from "@/lib/receipt-number";
import { RECEIPT_PDF_MAX_BYTES, RECEIPT_PDF_UNITS, receiptFrom, receiptTexts, receiptTitle } from "@/lib/receipt-pdf";
import { claimHandle, ensureStatsId, setMailSettings, setStripeAccount, storeForEmail } from "@/lib/store";
import { TAKE_DATA, dataKey } from "@/lib/store-data";
import * as storeData from "@/lib/store-data";
import { CLOSING, COUNTED_FAMILIES } from "@/lib/data-families";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { GET as receiptFile } from "@/app/api/store/receipt-pdf/route";
import { FAMILIES } from "./store-data-registry";
import { ORIGIN_PER_BYTE, UNIT_COST, request } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const REF = "cs_test_a1B2c3D4e5F6g7H8i9J0";
const REF2 = "cs_test_k1L2m3N4o5P6q7R8s9T0";
const HANDLE = "harbornumbers";

function paidSession(id = REF, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    object: "checkout.session",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    currency: "usd",
    amount_subtotal: 4900,
    amount_total: 4900,
    total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
    customer_details: { email: "dana@example.com" },
    metadata: { store: HANDLE },
    payment_intent: {
      id: "pi_1TestNumber0001",
      object: "payment_intent",
      status: "succeeded",
      latest_charge: { id: "ch_1TestNumber0001", object: "charge", paid: true, status: "succeeded", amount: 4900, amount_refunded: 0, refunded: false, disputed: false, currency: "usd", created: 1_790_000_000 },
    },
    ...over,
  };
}
const linesPage = { object: "list", has_more: false, data: [{ id: "li_1TestNumLine01", object: "item", description: "Sourdough Course", quantity: 1, amount_subtotal: 4900, currency: "usd" }] };

const onStripe = new Map<string, { status: number; body: unknown }>();
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const kept = onStripe.get(url.pathname);
  if (kept) return new Response(JSON.stringify(kept.body), { status: kept.status });
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${url.pathname}` } }), { status: 404 });
}) as typeof fetch;
const answer = (ref: string, sale: unknown) => {
  onStripe.set(`/v1/checkout/sessions/${ref}`, { status: 200, body: sale });
  onStripe.set(`/v1/checkout/sessions/${ref}/line_items`, { status: 200, body: linesPage });
};

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.STRIPE_SECRET_KEY = "sk_test_receipt_numbers_only_a_stand_in";

  part("Written plainly");
  is("six digits at least, no other prefix", [receiptNumberText(1), receiptNumberText(123), receiptNumberText(1_234_567)], ["R-000001", "R-000123", "R-1234567"]);

  const OWNER = "numbers@example.com";
  await claimHandle(OWNER, HANDLE, "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestNumbers01", true);
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: "12 Pier Road, Portland, ME 04101, USA" });
  const store = (await storeForEmail(OWNER))!;
  const OTHER = "other-numbers@example.com";
  await claimHandle(OTHER, "othernumbers", "Other Kitchen", "");
  await ensureStatsId(OTHER);
  const other = (await storeForEmail(OTHER))!;

  part("One number a sale, the same every time");
  const first = await assignReceiptNumber(store, REF);
  is("the store's first sale numbered is R-000001", first, { ok: true, number: "R-000001" });
  is("downloaded again: the same number", await assignReceiptNumber(store, REF), { ok: true, number: "R-000001" });
  is("the next sale: the next number", await assignReceiptNumber(store, REF2), { ok: true, number: "R-000002" });
  is("the first again, after another: still its own", await assignReceiptNumber(store, REF), { ok: true, number: "R-000001" });
  const together = await Promise.all([assignReceiptNumber(store, "cs_test_together0000000001"), assignReceiptNumber(store, "cs_test_together0000000001")]);
  is("two downloads at once of a new sale: one number between them", together, [{ ok: true, number: "R-000003" }, { ok: true, number: "R-000003" }]);

  part("Each store counts its own");
  is("another store's first sale is its own R-000001", await assignReceiptNumber(other, REF), { ok: true, number: "R-000001" });
  is("and leaves this store's count where it was", await assignReceiptNumber(store, "cs_test_afterother00000001"), { ok: true, number: "R-000004" });
  is("kept under each store's own id", [receiptNumbersKey(store.sid), receiptCounterKey(store.sid)], [`nl:rcpt:n:${store.sid}`, `nl:rcpt:seq:${store.sid}`]);
  is("a store without a proper id is given no number", await assignReceiptNumber({ ...store, sid: "" }, REF), { ok: false, reason: "unknown" });
  is("a reference that is not a checkout's is given no number", await assignReceiptNumber(store, "not-a-checkout"), { ok: false, reason: "unknown" });

  part("Taken from the store's data room as it is written, once");
  const roomKey = dataKey(store)!;
  const slot = async () => Number((await redis.pipeline([["HGET", roomKey, RECEIPT_SLOT]]))[0] ?? 0);
  const before = await slot();
  is("what a new number takes is at most its ceiling", before > 0 && before <= RECEIPT_NUMBER_BYTES * 4 + 2 * RECEIPT_NUMBER_BYTES, true);
  await assignReceiptNumber(store, REF);
  is("a download again takes nothing more", await slot(), before);
  await assignReceiptNumber(store, "cs_test_onemore00000000001");
  is("a new sale takes at most RECEIPT_NUMBER_BYTES", (await slot()) - before > 0 && (await slot()) - before <= RECEIPT_NUMBER_BYTES, true);
  await redis.pipeline([["HSET", roomKey, "#", "999999999999"]]);
  const full = await assignReceiptNumber(store, "cs_test_roomisfull00000001");
  is("a full room: said so, and no number given", [full.ok, !full.ok && full.reason], [false, "full"]);
  is("nothing counted for it", (await redis.pipeline([["GET", receiptCounterKey(store.sid)]]))[0], "5");
  is("a number already given is still read when the room is full", await assignReceiptNumber(store, REF), { ok: true, number: "R-000001" });
  await redis.pipeline([["HSET", roomKey, "#", "0"]]);

  part("A reply that is not the script's own is never a number");
  for (const [what, reply] of [
    ["nothing", null],
    ["text", "R-000001"],
    ["a number as text", [2, "5"]],
    ["zero", [3, 0]],
    ["below zero", [2, -1]],
    ["a fraction", [3, 1.5]],
    ["another state", [9, 1]],
    ["an extra item", [2, 5, 1]],
    ["the room unreadable", [-1, 0]],
    ["too large", [3, Number.MAX_SAFE_INTEGER + 1]],
  ] as const) {
    is(`${what}: unknown`, receiptNumberFrom(store, reply), { ok: false, reason: "unknown" });
  }
  is("an old number read: a number", receiptNumberFrom(store, [2, 41]), { ok: true, number: "R-000041" });
  is("a new number: a number", receiptNumberFrom(store, [3, 42]), { ok: true, number: "R-000042" });
  const fullRead = receiptNumberFrom(store, [0, 5000]);
  is("the room full: full, with words to act on", [fullRead.ok, !fullRead.ok && fullRead.reason, !fullRead.ok && fullRead.reason === "full" && fullRead.message.length > 0], [false, "full", true]);
  const pipeline = redis.pipeline;
  redis.pipeline = async () => [["unexpected"]];
  is("the database answering otherwise: unknown, never a guess", await assignReceiptNumber(store, "cs_test_odd0000000000000001"), { ok: false, reason: "unknown" });
  redis.pipeline = async () => {
    throw new Error("down");
  };
  is("the database not answering: unknown", await assignReceiptNumber(store, "cs_test_down000000000000001"), { ok: false, reason: "unknown" });
  redis.pipeline = pipeline;

  part("On the receipt");
  const read = receiptFrom({ name: "Harbor Kitchen", address: null, handles: new Set([HANDLE]) }, REF, paidSession(), linesPage);
  if (!read.ok) throw new Error("no receipt");
  const numbered = { ...read.receipt, number: "R-000001" };
  is("said under the sale, before when it was paid", receiptTexts(numbered).slice(1, 3).map((t) => `${t.role}:${t.text}`), ["H2:Sale", "P:Receipt number R-000001"]);
  is("and in the file's title", receiptTitle(numbered), "Receipt R-000001 from Harbor Kitchen — September 21, 2026");

  part("Downloaded from the studio");
  const session = await openSession(OWNER);
  const get = (ref: string) => receiptFile(new NextRequest(`https://marktmorgen.com/api/store/receipt-pdf?reference=${ref}`, { headers: { cookie: `${SESSION_COOKIE}=${session}` } }));
  const title = async (response: Response) => (await PDFDocument.load(new Uint8Array(await response.arrayBuffer()))).getTitle();
  answer(REF, paidSession());
  const once = await get(REF);
  is("the file carries the sale's number, in its name too", [once.status, once.headers.get("content-disposition"), await title(once)], [200, 'attachment; filename="receipt-R-000001.pdf"', "Receipt R-000001 from Harbor Kitchen — September 21, 2026"]);
  const again = await get(REF);
  is("downloaded again: the same number", [again.status, await title(again)], [200, "Receipt R-000001 from Harbor Kitchen — September 21, 2026"]);
  const UNPAID = "cs_test_unpaid000000000001";
  answer(UNPAID, paidSession(UNPAID, { status: "open", payment_status: "unpaid" }));
  is("a sale with no receipt takes no number", [(await get(UNPAID)).status, (await redis.pipeline([["HGET", receiptNumbersKey(store.sid), UNPAID]]))[0]], [409, null]);
  const FRESH = "cs_test_fresh0000000000001";
  answer(FRESH, paidSession(FRESH));
  const fresh = await get(FRESH);
  is("a new sale downloaded: the next number", [fresh.status, fresh.headers.get("content-disposition")], [200, 'attachment; filename="receipt-R-000006.pdf"']);
  const LATER = "cs_test_later0000000000001";
  answer(LATER, paidSession(LATER));
  redis.pipeline = async (commands) => (commands.some((c) => String(c[0]) === "EVAL" && String(c[1]).startsWith("-- marktmorgen:receipt-number:v1")) ? [[7]] : pipeline(commands));
  const odd = await get(LATER);
  is("the number's reply not understood: 503, no PDF", [odd.status, odd.headers.get("content-type")?.startsWith("application/pdf") ?? false], [503, false]);
  redis.pipeline = pipeline;
  await redis.pipeline([["HSET", roomKey, "#", "999999999999"]]);
  const noRoom = await get(LATER);
  is("the store full: said so, no PDF", [noRoom.status, noRoom.headers.get("content-type")?.startsWith("application/pdf") ?? false], [409, false]);
  is("a sale numbered before still downloads", (await get(REF)).status, 200);
  await redis.pipeline([["HSET", roomKey, "#", "0"]]);

  part("Kept, bounded and erased with the store");
  for (const family of ["nl:rcpt:n:", "nl:rcpt:seq:"]) {
    is(`${family} is counted in the room where it is written`, FAMILIES[`${family}@lib/receipt-number.ts`]?.room, ["lib/receipt-number.ts"]);
    is(`${family} is measured as the room's`, COUNTED_FAMILIES.includes(family), true);
    is(`${family} is erased with the store`, CLOSING[family], { how: "erase" });
  }
  is("the script reads first and writes only a sale not yet numbered", RECEIPT_NUMBER.indexOf("HGET', KEYS[2]") < RECEIPT_NUMBER.indexOf("INCR"), true);

  part("A store idle for years: one numbering clears every expired month, in two commands");
  // Review of #3001 (M1): the data room's script cleared every expired month in one call, two commands each, and a
  // workflow's run is kept well past 400 days (lib/flows.ts, runGoneBy), so a store idle long enough lists dozens of
  // expired months: 13 measured 37 commands on a real Redis, past RECEIPT_NUMBER_COMMANDS. Forty listed here.
  // Changed (rule 23): b518e114f bounded it by clearing at most two months a call, which kept the rest counted, so the
  // room looked fuller than it was and refused writes that fitted (scripts/test_order_admission_redis.py: +1,690 bytes
  // after three passes). Now one HMGET reads every expired month and one HDEL removes them: exact at once, and still
  // two commands however many (at most DATA_MONTHS_CLEARED_MOST a call, so the arguments stay bounded too).
  const idleRoom = dataKey(other)!;
  const expired = Array.from({ length: 40 }, (_, i) => `${2020 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`);
  const hget = async (key: string, field: string) => (await redis.pipeline([["HGET", key, field]]))[0];
  const slotBefore = Number((await hget(idleRoom, RECEIPT_SLOT)) ?? 0);
  await redis.pipeline([["HSET", idleRoom, "#", String(expired.length * 164), "~", expired.join(","), ...expired.flatMap((m) => [`~${m}`, "100"])]]);
  const fields = async (months: string[]) => Promise.all(months.map(async (m) => (await redis.pipeline([["HEXISTS", idleRoom, `~${m}`]]))[0]));
  is("the idle store's next sale is numbered", await assignReceiptNumber(other, "cs_test_idlestore000000001"), { ok: true, number: "R-000002" });
  is("every expired month came off the list in that one call", await hget(idleRoom, "~"), null);
  is("and their own fields with them", (await fields(expired)).every((n) => n === 0), true);
  const slotAfter = Number(await hget(idleRoom, RECEIPT_SLOT));
  // Exact: the expired months' 40 × 164 bytes are all gone; only the number's own growth is left.
  is("the room's total is exactly what is left, never fuller", Number(await hget(idleRoom, "#")), slotAfter - slotBefore + (slotBefore === 0 ? 64 : 0));
  await assignReceiptNumber(other, "cs_test_idlestore000000002");
  is("the next number finds nothing left to clear", [await hget(idleRoom, "~"), Number(await hget(idleRoom, "#"))], [null, Number(await hget(idleRoom, RECEIPT_SLOT)) - slotBefore + (slotBefore === 0 ? 64 : 0)]);
  const cleared = (storeData as Record<string, unknown>).DATA_MONTHS_CLEARED_MOST;
  is("the data room names how many expired months a call clears at the most", cleared, 512);
  is("and its script clears no more than that", TAKE_DATA.includes(`#over < ${String(cleared)}`), true);
  is("reading them with one HMGET and removing them with one HDEL, never a command a month", [TAKE_DATA.includes("'HMGET'"), TAKE_DATA.includes("HGET', KEYS[1], '~' .. m")], [true, false]);
  // Measured with INFO commandstats on a real Redis (review of #3001): 10 commands with no expired month, 13 with any number
  // (their read, their removal and the list written back). scripts/test_store_data_redis.py measures the script itself
  // against RECEIPT_NUMBER_COMMANDS in CI (first number, again, next, full; 0 to 520 expired months), so the ceiling is
  // held by a count and not only by this figure.
  is("RECEIPT_NUMBER_COMMANDS covers the most the script can bill", RECEIPT_NUMBER_COMMANDS >= 13, true);

  part("A count that is not a whole number takes no room and gives no number");
  // Review of #3001 (Claude 2, L1, comment 6704251804): the room was taken before the INCR, so a count Redis cannot
  // add to failed the script after its room was spent, and every try took one more number's room. The in-memory
  // model read such a count as 0 and gave R-000001 again. The count is read before anything is taken.
  const THIRD = "third-numbers@example.com";
  await claimHandle(THIRD, "thirdnumbers", "Third Kitchen", "");
  await ensureStatsId(THIRD);
  const third = (await storeForEmail(THIRD))!;
  const thirdRoom = dataKey(third)!;
  const counter = receiptCounterKey(third.sid);
  const roomNow = async () => (await redis.pipeline([["HGET", thirdRoom, "#"], ["HGET", thirdRoom, RECEIPT_SLOT]])).map((v) => Number(v ?? 0));
  is("the store's first sale is numbered", await assignReceiptNumber(third, "cs_test_thirdstore00000001"), { ok: true, number: "R-000001" });
  for (const bad of ["abc", "1.5", "007", "-3", String(RECEIPT_NUMBER_MAX), "9999999999999"]) {
    await redis.pipeline([["SET", counter, bad]]);
    const held = await roomNow();
    const tries = [await assignReceiptNumber(third, "cs_test_thirdstore00000002"), await assignReceiptNumber(third, "cs_test_thirdstore00000002")];
    is(`a count of "${bad}": no number, twice`, tries, [{ ok: false, reason: "unknown" }, { ok: false, reason: "unknown" }]);
    is(`a count of "${bad}": the room untouched by either try`, await roomNow(), held);
    is(`a count of "${bad}": nothing written for the sale, the count left as it was`, await redis.pipeline([["HEXISTS", receiptNumbersKey(third.sid), "cs_test_thirdstore00000002"], ["GET", counter]]), [0, bad]);
  }
  await redis.pipeline([["DEL", counter], ["HSET", counter, "n", "1"]]);
  const heldTyped = await roomNow();
  is("a count of another type: no number", await assignReceiptNumber(third, "cs_test_thirdstore00000002"), { ok: false, reason: "unknown" });
  is("and the room untouched", await roomNow(), heldTyped);
  await redis.pipeline([["DEL", counter], ["SET", counter, "7"]]);
  is("a whole count still gives the next number", await assignReceiptNumber(third, "cs_test_thirdstore00000002"), { ok: true, number: "R-000008" });
  is("its bound on the count is RECEIPT_NUMBER_MAX's", [RECEIPT_NUMBER.includes(`#count <= ${String(RECEIPT_NUMBER_MAX).length} and tonumber(count) < ${RECEIPT_NUMBER_MAX}`), readFileSync("lib/redis-memory.ts", "utf8").includes(`\\d{0,${String(RECEIPT_NUMBER_MAX).length - 1}}$/.test(count) && Number(count) < ${RECEIPT_NUMBER_MAX.toLocaleString("en-US").replaceAll(",", "_")})`)], [true, true]);
  is("the script reads the count before it takes any room", RECEIPT_NUMBER.indexOf("'GET', KEYS[3]") > 0 && RECEIPT_NUMBER.indexOf("'GET', KEYS[3]") < RECEIPT_NUMBER.indexOf("receiptRoom(ARGV[1]"), true);

  part("Its cost: inside the receipt's studio requests");
  const worst = request("step", 40 + RECEIPT_NUMBER_COMMANDS, 200_000 + 2 * RECEIPT_NUMBER_BYTES) + RECEIPT_PDF_MAX_BYTES * ORIGIN_PER_BYTE;
  is(`${RECEIPT_PDF_UNITS} studio requests ($${(RECEIPT_PDF_UNITS * UNIT_COST.studio).toFixed(6)}) still cover the worst file with its number ($${worst.toFixed(6)})`, RECEIPT_PDF_UNITS * UNIT_COST.studio >= worst, true);
  done();
}
void main();
