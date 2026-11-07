/**
 * Codex J's second financial return on #2844 (exact 7b1baef6), three MEDIUMs:
 *
 *   1. payday: the month's claim was taken before the creator's PayPal link was
 *      read, so a link read that failed spent the month and the healthy retry
 *      paid nobody. Everything that can fail before money moves is read before
 *      the claim; the claim is still taken before anything is sent. Since
 *      Claude 5's MEDIUM on 91815567, a link that cannot be read is "not by
 *      itself": the month is claimed and the manual reminder goes.
 *   2. the link's auto-pay switch: only true or false is a switch. "false", 1,
 *      {}, [], null or a missing switch is a record in an unknown shape, never
 *      permission to pay and never "off".
 *   3. the book as proof when settling: every payout in it must read whole,
 *      under its own id, before it can say an item is already booked or not;
 *      an unreadable one stops the settle before anything is booked or taken
 *      off its way.
 *
 * Synthetic only: a stand-in for PayPal's API on api-m.paypal.com, the Redis stub.
 */
import { connectPayPal, onTheirWay, payWithPayPal, paysAutomatically, readPayPal, setAutoPay, settlePayPal } from "@/lib/paypal-payouts";
import { sendPaydayEmails } from "@/lib/affiliate-payday";
import { addPayout, paypalPayoutId, readBook } from "@/lib/affiliates";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "c0dec0dec0dec0dec0dec0dec0dec0de";
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";
const SCOPE = "https://uri.paypal.com/payments/payouts openid";
const OWNER = "owner-codexj@example.com";
const PAYOUTS = `nl:aff:${STATS}:payouts`;
const ITEM = "ITEMBATCH1ABC0";
let itemStatus: Record<string, string> = {};
const created: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") return json({ data: [], has_more: false });
  if (url.hostname === "api.resend.com") return json({ id: "synthetic-email" });
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
    sid: "", handle: "harborj", name: "Harbor Kitchen", email: OWNER, bio: "", previousHandles: [], releasedHandles: [],
    statsId: STATS, stripeAccountId: "acct_1TestHarbor0001", currency: "usd",
    affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
  } as unknown as Store;
}

async function seed(store: Store): Promise<void> {
  redis.clear();
  created.length = 0;
  itemStatus = {};
  const at = Math.floor(Date.now() / 1000) - 86_400;
  const person = (id: string, email: string, code: string) => JSON.stringify({ id, email, code, status: "approved", appliedAt: 1, decidedAt: 2, note: "" });
  const sale = (ref: string, aff: string, base: number) => JSON.stringify({ ref, pi: `pi_${ref}`, aff, at, product: "p1", title: "Guide", base, total: base, currency: "usd", rate: 30, self: false });
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, "aaaaaaaaaaaa", person("aaaaaaaaaaaa", "sara@example.com", "sara")],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_1", sale("cs_1", "aaaaaaaaaaaa", 10000)],
    ["SET", `nl:store:owner:${OWNER}`, JSON.stringify(store)],
  ]);
  const linked = await connectPayPal(store, CLIENT, SECRET);
  if (!linked.ok) throw new Error(`not linked: ${JSON.stringify(linked)}`);
}

const real = redis.pipeline.bind(redis);
type Commands = (string | number)[][];
async function intercepted<T>(match: (commands: Commands) => boolean, reply: (commands: Commands) => Promise<unknown[]>, body: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Commands) => (match(commands) ? reply(commands) : real(commands))) as typeof redis.pipeline;
  try {
    return await body();
  } finally {
    redis.pipeline = real;
  }
}
async function rejects(body: () => Promise<unknown>): Promise<boolean> {
  try {
    await body();
    return false;
  } catch {
    return true;
  }
}
const paidTo = async (store: Store) => (await readBook(store)).rows.find((r) => r.affiliate.id === "aaaaaaaaaaaa")?.paid ?? -1;
const linkRead = (c: Commands) => c.length === 1 && c[0][0] === "GET" && c[0][1] === `nl:pp:${STATS}`;
const bookRead = (c: Commands) => c.length === 1 && c[0][0] === "HGETALL" && c[0][1] === PAYOUTS;
/** Rewrites the stored link's auto-pay switch, the sealed Secret left as it is. */
async function storedAuto(value: unknown, drop = false): Promise<void> {
  const [raw] = await real([["GET", `nl:pp:${STATS}`]]);
  const link = JSON.parse(String(raw)) as Record<string, unknown>;
  if (drop) delete link.auto;
  else link.auto = value;
  await real([["SET", `nl:pp:${STATS}`, JSON.stringify(link)]]);
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_paypal_codexj_only";
  process.env.RESEND_API_KEY = "re_test_codexj_only";
  console.error = () => {};
  const store = shop();
  const payday = new Date(Date.UTC(2026, 10, 5, 9, 0, 0));
  const claimKey = `nl:aff:payday:${STATS}:2026-11`;
  const claimed = async () => (await real([["GET", claimKey]]))[0];

  // ---- 1. Payday: a link read that fails never pays, and the month still gets its reminder ----
  // Since Claude 5's MEDIUM on 91815567 the month is claimed on that same run: the job runs
  // once a day and looks at a store only on its payday, so "the next run" would never come
  // (tests/affiliate-payday-unread-link.test.ts walks the real schedule).
  for (const [label, reply] of [
    ["a number", [42]],
    ["undefined", [undefined]],
    ["no reply at all", []],
    ["unreadable JSON", ["{"]],
  ] as [string, unknown[]][]) {
    part(`Payday, auto-pay on, the link answers ${label}: nothing paid, the month claimed for the reminder`);
    await seed(store);
    await setAutoPay(store, true);
    const first = await intercepted(linkRead, async () => [...reply], () => sendPaydayEmails(Date.now() + 60_000, payday));
    is("that store did not fail", [first.due, first.failed], [1, 0]);
    is("nothing was sent to PayPal", created.length, 0);
    is("the month's claim is taken for the reminder", await claimed(), "1");
    await sendPaydayEmails(Date.now() + 60_000, payday);
    is("a healthy run the same day pays nobody again", created.length, 0);
  }

  part("Control: payday, auto-pay on, healthy: one batch, the month claimed once");
  await seed(store);
  await setAutoPay(store, true);
  await sendPaydayEmails(Date.now() + 60_000, payday);
  await sendPaydayEmails(Date.now() + 60_000, payday);
  is("one batch over two runs", [created.length, await claimed()], [1, "1"]);

  part("Control: payday, auto-pay off: no batch, the month claimed for the reminder");
  await seed(store);
  await sendPaydayEmails(Date.now() + 60_000, payday);
  is("no batch, claimed", [created.length, await claimed()], [0, "1"]);

  // ---- 2. The auto-pay switch is true or false, nothing else ----
  const badAuto: [string, unknown, boolean][] = [
    ['the string "false"', "false", false],
    ['the string "true"', "true", false],
    ["the number 1", 1, false],
    ["the number 0", 0, false],
    ["an object", {}, false],
    ["a list", [], false],
    ["null", null, false],
    ["missing", undefined, true],
  ];
  for (const [label, value, drop] of badAuto) {
    part(`The link's auto-pay switch is ${label}: neither permission nor "off"`);
    await seed(store);
    await storedAuto(value, drop);
    is("payday's auto-pay question rejects", await rejects(() => paysAutomatically(store)), true);
    is("the studio view rejects", await rejects(() => readPayPal(store)), true);
    const run = await sendPaydayEmails(Date.now() + 60_000, payday);
    is("payday sends no PayPal batch and does not fail", [created.length, run.failed], [0, 0]);
    is("and claims the month for the manual reminder", await claimed(), "1");
  }

  part("Controls: the switch stored as true and as false");
  await seed(store);
  await storedAuto(true);
  is("true: pays by itself", await paysAutomatically(store), true);
  await storedAuto(false);
  is("false: does not", [await paysAutomatically(store), (await readPayPal(store))?.auto], [false, false]);
  await sendPaydayEmails(Date.now() + 60_000, payday);
  is("payday with false: no batch", created.length, 0);

  // ---- 3. Every payout in the book reads whole before it is used as proof ----
  const sentAndPaid = async (): Promise<void> => {
    await seed(store);
    const paid = await payWithPayPal(store);
    if (!paid.ok) throw new Error(`not sent: ${paid.reason}`);
    itemStatus = { aaaaaaaaaaaa: "SUCCESS" };
  };
  const entries = async () => Number((await real([["HLEN", PAYOUTS]]))[0]);
  const stopped = async (label: string, body: () => Promise<unknown>): Promise<void> => {
    is(`${label}: settling rejects`, await rejects(body), true);
    is(`${label}: nothing more is written to the book`, await entries(), 1);
    is(`${label}: still on its way, never owed again`, [...(await onTheirWay(store))], ["aaaaaaaaaaaa"]);
    is(`${label}: no item mark`, (await real([["GET", `nl:pp:item:${ITEM}`]]))[0], null);
  };
  /** The real book's reply, with each value passed through `edit`. */
  const editedBook = (edit: (field: string, value: string) => string) => async (c: Commands) => {
    const [flat] = (await real(c)) as [string[]];
    return [flat.map((v, i) => (i % 2 ? edit(flat[i - 1], v) : v))];
  };

  part("Codex J: a real legacy payout of the item, its payload read as unreadable: never booked a second time");
  await sentAndPaid();
  await addPayout(store, { aff: "aaaaaaaaaaaa", cents: 3000, currency: "usd", date: "2026-11-01", reference: `PayPal ${ITEM}` });
  await stopped("unreadable payload", () => intercepted(bookRead, editedBook(() => "{"), () => settlePayPal(store)));
  is("the book still holds 3000 once", await paidTo(store), 3000);

  part("A legacy payout whose payload names another id than its field: not proof either way");
  await sentAndPaid();
  await addPayout(store, { aff: "aaaaaaaaaaaa", cents: 3000, currency: "usd", date: "2026-11-01", reference: `PayPal ${ITEM}` });
  await stopped("id mismatch", () =>
    intercepted(bookRead, editedBook((_, v) => JSON.stringify({ ...(JSON.parse(v) as object), id: "ffffffffffff" })), () => settlePayPal(store)),
  );

  part("A payout without an affiliate or an amount: not read as proof");
  await sentAndPaid();
  await addPayout(store, { aff: "aaaaaaaaaaaa", cents: 3000, currency: "usd", date: "2026-11-01", reference: `PayPal ${ITEM}` });
  await stopped("no amount", () => intercepted(bookRead, editedBook((_, v) => JSON.stringify({ ...(JSON.parse(v) as object), cents: "3000" })), () => settlePayPal(store)));

  part("The item's own deterministic field, its payload unreadable: not taken as 'already booked'");
  await sentAndPaid();
  await real([["HSET", PAYOUTS, paypalPayoutId(ITEM), "{"]]);
  await stopped("deterministic, unreadable", () => settlePayPal(store));

  part("The item's own deterministic field holding a payout of another reference: not taken as 'already booked'");
  await sentAndPaid();
  const other = paypalPayoutId(ITEM);
  await real([["HSET", PAYOUTS, other, JSON.stringify({ id: other, aff: "aaaaaaaaaaaa", cents: 3000, currency: "usd", date: "2026-11-01", reference: "PayPal SOMEOTHERITEM", at: 1 })]]);
  await stopped("deterministic, other reference", () => settlePayPal(store));

  part("Controls: a healthy legacy payout, and a healthy deterministic one, are proof: not booked again");
  await sentAndPaid();
  await addPayout(store, { aff: "aaaaaaaaaaaa", cents: 3000, currency: "usd", date: "2026-11-01", reference: `PayPal ${ITEM}` });
  is("legacy: settled, not booked again", await settlePayPal(store), { paid: 0, released: 0, waiting: 0 });
  is("legacy: in the book once", [await paidTo(store), await entries()], [3000, 1]);
  await sentAndPaid();
  is("new: booked by this settle", await settlePayPal(store), { paid: 1, released: 0, waiting: 0 });
  is("new: in the book once", [await paidTo(store), await entries()], [3000, 1]);
  await sentAndPaid();
  await real([["HSET", PAYOUTS, other, JSON.stringify({ id: other, aff: "aaaaaaaaaaaa", cents: 3000, currency: "usd", date: "2026-11-01", reference: `PayPal ${ITEM}`, at: 1 })]]);
  is("deterministic already there: settled, not booked again", await settlePayPal(store), { paid: 0, released: 0, waiting: 0 });
  is("deterministic: in the book once", [await paidTo(store), await entries()], [3000, 1]);
  await sentAndPaid();
  is("an empty book (confirmed): booked", (await settlePayPal(store)).paid, 1);

  done();
}

void main();
