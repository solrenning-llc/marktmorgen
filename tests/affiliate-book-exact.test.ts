/**
 * The affiliate book read exactly (Claude 5's review of #2844, rule 30 sibling on main; CX-123 rule 24).
 *
 * readBook decides who is owed, and so what payWithPayPal sends, what the payday pays by itself and what the
 * payout file and "Mark as paid" write down. A payout in the book that does not read, or a HGETALL that answers in
 * an unknown shape, used to be dropped or read as an empty hash: the affiliate already paid showed as owed again,
 * and PayPal was asked for a second batch for the same commission. The same reading in idleSweep took an owed
 * affiliate for one owed nothing, and warned them out. Now each of these throws UnknownReplyError, and every path
 * that pays or removes refuses with nothing sent. Synthetic data, a stubbed Redis and the providers intercepted.
 */
import { connectPayPal, payWithPayPal, setAutoPay, settlePayPal } from "@/lib/paypal-payouts";
import { sendPaydayEmails } from "@/lib/affiliate-payday";
import { idleSweep, readAffiliate, readBook } from "@/lib/affiliates";
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "c5b0c5b0c5b0c5b0c5b0c5b0c5b0c5b0";
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";
const SCOPE = "https://uri.paypal.com/payments/payouts openid";
const OWNER = "owner-c5book@example.com";
const AFF = "aaaaaaaaaaaa";
const PEOPLE = `nl:aff:${STATS}:people`;
const SALES = `nl:aff:${STATS}:sales`;
const PAYOUTS = `nl:aff:${STATS}:payouts`;
const PAID_CLICKS = `nl:aff:${STATS}:paid`;
let itemStatus: Record<string, string> = {};
const created: Record<string, unknown>[] = [];
let emails = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") return json({ object: "list", data: [], has_more: false });
  if (url.hostname === "api.resend.com") {
    emails += 1;
    return json({ id: `synthetic-email-${emails}` });
  }
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AAtoken", token_type: "Bearer", scope: SCOPE, expires_in: 32400 });
  if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
    created.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return json({ batch_header: { payout_batch_id: `BATCH${created.length}ABC`, batch_status: "PENDING" } }, 201);
  }
  const batch = /^\/v1\/payments\/payouts\/(BATCH\d+ABC)$/.exec(url.pathname)?.[1];
  if (batch) {
    const items = created[Number(batch.slice(5, -3)) - 1].items as { sender_item_id: string }[];
    return json({
      batch_header: { payout_batch_id: batch, batch_status: "SUCCESS" },
      total_pages: 1,
      items: items.map((item, i) => ({
        payout_item_id: `ITEM${batch}${i}`,
        transaction_status: itemStatus[item.sender_item_id] ?? "PENDING",
        payout_item: { sender_item_id: item.sender_item_id },
      })),
    });
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

function shop(): Store {
  return {
    sid: "", handle: "harborb", name: "Harbor Kitchen", email: OWNER, bio: "", previousHandles: [], releasedHandles: [],
    statsId: STATS, stripeAccountId: "acct_1TestHarbor0002", currency: "usd",
    affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
  } as unknown as Store;
}

const person = (id: string, email: string, code: string) => JSON.stringify({ id, email, code, status: "approved", appliedAt: 1, decidedAt: 2, note: "" });

async function seed(store: Store): Promise<void> {
  redis.clear();
  created.length = 0;
  itemStatus = {};
  const at = Math.floor(Date.now() / 1000) - 86_400;
  const sale = (ref: string, aff: string, base: number) => JSON.stringify({ ref, pi: `pi_${ref}`, aff, at, product: "p1", title: "Guide", base, total: base, currency: "usd", rate: 30, self: false });
  await redis.pipeline([
    ["HSET", PEOPLE, AFF, person(AFF, "sara@example.com", "sara")],
    ["HSET", SALES, "cs_1", sale("cs_1", AFF, 10000)],
    ["SET", `nl:store:owner:${OWNER}`, JSON.stringify(store)],
  ]);
  const linked = await connectPayPal(store, CLIENT, SECRET);
  if (!linked.ok) throw new Error(`not linked: ${JSON.stringify(linked)}`);
}

/** Paid once by PayPal and written into the book, as a real payday leaves it. */
async function settledOnce(store: Store): Promise<void> {
  await seed(store);
  const paid = await payWithPayPal(store);
  if (!paid.ok) throw new Error(`not sent: ${paid.reason}`);
  itemStatus = { [AFF]: "SUCCESS" };
  const s = await settlePayPal(store);
  if (s.paid !== 1) throw new Error(`not settled: ${JSON.stringify(s)}`);
}

const real = redis.pipeline.bind(redis);
type Commands = (string | number)[][];
async function intercepted<T>(match: (commands: Commands) => boolean, reply: (commands: Commands) => Promise<unknown>, body: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Commands) => (match(commands) ? reply(commands) : real(commands))) as typeof redis.pipeline;
  try {
    return await body();
  } finally {
    redis.pipeline = real;
  }
}
/** The name of what was thrown, or "resolved". */
async function thrown(body: () => Promise<unknown>): Promise<string> {
  try {
    await body();
    return "resolved";
  } catch (error) {
    return error instanceof Error ? error.name : "thrown";
  }
}
const bookPipe = (c: Commands) => c.length === 7 && c[0][0] === "HGETALL" && c[3][0] === "HGETALL" && c[3][1] === PAYOUTS;
/** readBook's pipeline answered with its slot `slot` replaced by `value`. */
const slotAs = (slot: number, value: unknown) => async (c: Commands) => {
  const r = await real(c);
  r[slot] = value;
  return r;
};
async function payoutField(): Promise<string> {
  const [fields] = await real([["HKEYS", PAYOUTS]]);
  return String((fields as string[])[0]);
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_c5_book_exact_only";
  // A key the synthetic Resend fixture knows (tests/resend-fixture-credentials.ts), borrowed from the idle-sweep test.
  process.env.RESEND_API_KEY = "re_test_affiliate_idle_only";
  console.error = () => {};
  const store = shop();

  part("idleSweep: an owed affiliate is never warned out on a book read wrong");
  const IDLE_OWNER = "idle-c5book@example.com";
  const DAY = 86_400;
  const T0 = Math.floor(Date.now() / 1000) - 400 * DAY;
  const ms = (days: number) => (T0 + days * DAY) * 1000;
  const idleWorld = async (): Promise<Store> => {
    redis.clear();
    emails = 0;
    await claimHandle(IDLE_OWNER, "harboridle", "Harbor Idle", "");
    await ensureStatsId(IDLE_OWNER);
    await setStripeAccount(IDLE_OWNER, "acct_1TestIdle00002", true);
    await setAffiliateSetting(IDLE_OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true }));
    let s = (await storeForEmail(IDLE_OWNER))!;
    await setAffiliateSetting(IDLE_OWNER, parseAffiliateSetting({ ...s.affiliates, idle: 90, idleOn: T0 + 300 * DAY }));
    s = (await storeForEmail(IDLE_OWNER))!;
    const id = s.statsId!;
    await redis.pipeline([
      ["HSET", `nl:aff:${id}:people`, AFF, JSON.stringify({ id: AFF, email: "owed@example.com", code: "owed", status: "approved", appliedAt: ms(0), decidedAt: ms(0), note: "" })],
      // An old sale, never paid: they may still be owed.
      ["HSET", `nl:aff:${id}:sales`, "cs_o1", JSON.stringify({ ref: "cs_o1", pi: "pi_o1", aff: AFF, at: T0 + 10 * DAY, product: "prod01", title: "Bread", base: 1000, total: 1000, currency: "usd", rate: 20, self: false, how: "click" })],
    ]);
    return s;
  };
  const idlePipe = (c: Commands) => c.length === 4 && c[0][0] === "HGETALL" && c[1][0] === "HGETALL" && String(c[1][1]).endsWith(":sales");
  let idle = await idleWorld();
  is("control: an owed affiliate is never warned", await idleSweep(idle, ms(400)), { warned: 0, removed: 0 });
  idle = await idleWorld();
  await real([["HDEL", `nl:aff:${idle.statsId}:sales`, "cs_o1"]]);
  is("control: one owed nothing is warned (the email goes out)", [await idleSweep(idle, ms(400)), emails], [{ warned: 1, removed: 0 }, 1]);
  idle = await idleWorld();
  is("the sales in an unknown shape: throws", await intercepted(idlePipe, slotAs(1, undefined), () => thrown(() => idleSweep(idle, ms(400)))), "UnknownReplyError");
  is("so nobody is warned", [(await readAffiliate(idle, AFF))?.warned ?? 0, emails], [0, 0]);
  idle = await idleWorld();
  is("the pipeline cut short: throws", await intercepted(idlePipe, async (c) => (await real(c)).slice(0, 3), () => thrown(() => idleSweep(idle, ms(400)))), "UnknownReplyError");
  idle = await idleWorld();
  await real([["HSET", `nl:aff:${idle.statsId}:sales`, "cs_o1", "{"]]);
  is("the owed sale unreadable: throws", await thrown(() => idleSweep(idle, ms(400))), "UnknownReplyError");
  is("so nobody is warned", [(await readAffiliate(idle, AFF))?.warned ?? 0, emails], [0, 0]);
  idle = await idleWorld();
  await real([["HSET", `nl:aff:${idle.statsId}:payouts`, "po_x", "{"]]);
  is("an unreadable payout: throws", await thrown(() => idleSweep(idle, ms(400))), "UnknownReplyError");


  part("Control: paid and settled, nothing more is sent");
  await settledOnce(store);
  const book = await readBook(store);
  is("the book says the affiliate was paid", book.rows.map((r) => [r.affiliate.id, r.paid, r.payable]), [[AFF, 3000, 0]]);
  is("payWithPayPal has nothing to send", await payWithPayPal(store), { ok: false, reason: "nothing" });
  is("one PayPal batch in all", created.length, 1);

  part("A payout in the book that does not read is never dropped");
  await settledOnce(store);
  await real([["HSET", PAYOUTS, await payoutField(), "{"]]);
  is("readBook throws UnknownReplyError", await thrown(() => readBook(store)), "UnknownReplyError");
  is("and so does one affiliate's book", await thrown(() => readBook(store, AFF)), "UnknownReplyError");
  is("payWithPayPal refuses with nothing sent", await payWithPayPal(store), { ok: false, reason: "error" });
  is("never a second PayPal batch for the same commission", created.length, 1);

  part("A payout that reads as another shape (no cents) is never dropped either");
  await settledOnce(store);
  await real([["HSET", PAYOUTS, await payoutField(), JSON.stringify({ id: "x", aff: AFF })]]);
  is("readBook throws UnknownReplyError", await thrown(() => readBook(store)), "UnknownReplyError");
  await payWithPayPal(store);
  is("never a second PayPal batch", created.length, 1);

  // Codex G and Codex M on #3051: a payout's cents were read as any number, so a negative or fractional amount in
  // the book lowered what was paid and PayPal was asked for more (-3000 sent a second batch of $60.00). Every
  // writer (the route, "Mark as paid", PayPal's settlement) writes a whole number of at least one: anything else
  // is a record that does not read, never a reversal.
  part("A payout whose amount is not a whole positive number of cents is never read as one");
  const payoutAs = async (patch: Record<string, unknown>) => {
    await settledOnce(store);
    const field = await payoutField();
    const [held] = await real([["HGET", PAYOUTS, field]]);
    await real([["HSET", PAYOUTS, field, JSON.stringify({ ...(JSON.parse(String(held)) as object), ...patch })]]);
  };
  for (const [what, patch] of [
    ["cents -3000", { cents: -3000 }],
    ["cents -1", { cents: -1 }],
    ["cents 0", { cents: 0 }],
    ["cents 0.5", { cents: 0.5 }],
    ["cents 2999.5", { cents: 2999.5 }],
    ["cents past a safe integer", { cents: 2 ** 53 }],
    ["cents as a string", { cents: "3000" }],
    ["an empty affiliate id", { aff: "" }],
    ["an empty payout id", { id: "" }],
    ["a currency that is not a code", { currency: "US dollars" }],
    ["a currency that is not text", { currency: 840 }],
  ] as const) {
    await payoutAs(patch);
    is(`${what}: readBook throws UnknownReplyError`, await thrown(() => readBook(store)), "UnknownReplyError");
    is(`${what}: payWithPayPal refuses with nothing sent`, await payWithPayPal(store), { ok: false, reason: "error" });
    is(`${what}: never a second PayPal batch`, created.length, 1);
  }
  idle = await idleWorld();
  await real([["HSET", `nl:aff:${idle.statsId}:payouts`, "0123456789ab", JSON.stringify({ id: "0123456789ab", aff: AFF, cents: -3000, currency: "usd", date: "2026-11-01", reference: "x", at: 1 })]]);
  is("the same negative payout in idleSweep: throws", await thrown(() => idleSweep(idle, ms(400))), "UnknownReplyError");
  await payoutAs({ cents: 3000 });
  is("control: a whole positive payout still reads as paid", (await readBook(store)).rows.map((r) => [r.paid, r.payable]), [[3000, 0]]);
  await payoutAs({ currency: undefined });
  is("control: a payout from before the currency was written reads as US dollars", (await readBook(store)).payouts.map((p) => [p.cents, p.currency]), [[3000, "usd"]]);
  is("and nothing more is sent", [await payWithPayPal(store), created.length], [{ ok: false, reason: "nothing" }, 1]);

  part("The payouts' HGETALL in an unknown shape is not an empty book");
  for (const [what, value] of [
    ["missing (undefined)", undefined],
    ["null", null],
    ["a number", 7],
    ["an odd list", ["only-a-field"]],
    ["a list with a number in it", ["f1", 5]],
    ["an object", { f1: "{}" }],
  ] as const) {
    await settledOnce(store);
    is(`${what}: readBook throws`, await intercepted(bookPipe, slotAs(3, value), () => thrown(() => readBook(store))), "UnknownReplyError");
    await intercepted(bookPipe, slotAs(3, value), () => payWithPayPal(store));
    is(`${what}: never a second PayPal batch`, created.length, 1);
  }

  part("The book's pipeline cut short or padded is unknown");
  await settledOnce(store);
  is("six replies for seven commands: throws", await intercepted(bookPipe, async (c) => (await real(c)).slice(0, 6), () => thrown(() => readBook(store))), "UnknownReplyError");
  is("eight replies for seven commands: throws", await intercepted(bookPipe, async (c) => [...(await real(c)), []], () => thrown(() => readBook(store))), "UnknownReplyError");
  is("not a list at all: throws", await intercepted(bookPipe, async () => null, () => thrown(() => readBook(store))), "UnknownReplyError");
  await intercepted(bookPipe, async (c) => (await real(c)).slice(0, 6), () => payWithPayPal(store));
  is("never a second PayPal batch", created.length, 1);

  part("Every other hash of the book is read exactly too");
  for (const [slot, what] of [
    [0, "people"],
    [1, "clicks"],
    [2, "sales"],
    [4, "partner shares"],
    [5, "paid-search clicks"],
    [6, "leads"],
  ] as const) {
    await seed(store);
    is(`${what} in an unknown shape: throws`, await intercepted(bookPipe, slotAs(slot, undefined), () => thrown(() => readBook(store))), "UnknownReplyError");
    is(`${what} as an odd list: throws`, await intercepted(bookPipe, slotAs(slot, ["lonely"]), () => thrown(() => readBook(store))), "UnknownReplyError");
  }

  part("A record of the book that does not read is never dropped");
  await seed(store);
  await real([["HSET", SALES, "cs_bad", "{"]]);
  is("an unreadable sale: throws (never paid short)", await thrown(() => readBook(store)), "UnknownReplyError");
  await seed(store);
  await real([["HSET", PEOPLE, "bbbbbbbbbbbb", "{"]]);
  is("an unreadable person: throws (a shared address could be theirs, and its hold missed)", await thrown(() => readBook(store)), "UnknownReplyError");
  is("and nothing is sent for it", [await payWithPayPal(store), created.length], [{ ok: false, reason: "error" }, 0]);
  await seed(store);
  await real([["HSET", PAID_CLICKS, AFF, "lots"]]);
  is("a paid-search click count that is not a whole number: throws (its hold is never missed)", await thrown(() => readBook(store)), "UnknownReplyError");
  is("and nothing is sent for it", [await payWithPayPal(store), created.length], [{ ok: false, reason: "error" }, 0]);
  await seed(store);
  await real([["HSET", PAID_CLICKS, AFF, "2"]]);
  is("control: a paid-search click held, read from Redis's string", (await readBook(store)).rows.map((r) => [r.paidClicks, r.payable, r.flags]), [[2, 0, ["paid-search"]]]);

  part("Payday paying by itself: the same unreadable payout sends nothing");
  await settledOnce(store);
  await setAutoPay(store, true);
  await real([["HSET", PAYOUTS, await payoutField(), "{"]]);
  emails = 0;
  const payday = await sendPaydayEmails(Date.now() + 60_000, new Date(Date.UTC(2026, 10, 5, 13, 0, 0)));
  is("the store is counted as failed, not as sent", [payday.due, payday.sent, payday.failed], [1, 0, 1]);
  is("never a second PayPal batch", created.length, 1);
  is("and no email saying it was paid", emails, 0);
  is("the month is not spent on it", (await real([["EXISTS", `nl:aff:payday:${STATS}:2026-11`]]))[0], 0);

  done();
}

void main();
