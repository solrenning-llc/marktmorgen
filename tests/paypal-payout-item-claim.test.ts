/**
 * A PayPal payout item is written into the affiliate book once, and a line leaves the open batch only when the book
 * is confirmed to hold it (CX-123 rule 24; Claude 2 on #3272, finding 1).
 *
 * The book write is the once-only record: the payout's id is derived from the PayPal item and written with HSETNX,
 * read exactly. 1 is written, 0 is in the book already; any other answer, an error or a data room that is full keeps
 * the affiliate on their way, so the line is never sent to PayPal again and is read again next time. A mark taken by
 * an earlier run (nl:pp:item:<item>, written before this change) drops a line only when the book holds a payout with
 * that item's reference. One line that cannot be written never stops the others. Synthetic store, synthetic PayPal
 * stand-in; every scenario counts the PayPal batches made, which must stay at one for one commission.
 */
import { connectPayPal, onTheirWay, payWithPayPal, settlePayPal } from "@/lib/paypal-payouts";
import { readBook, removePayout } from "@/lib/affiliates";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "statsclaim1";
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";
let itemStatus: Record<string, string> = {};
const created: { body: Record<string, unknown> }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") return json({ object: "list", data: [], has_more: false });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  const headers = new Headers(init?.headers);
  if (url.pathname === "/v1/oauth2/token") {
    const basic = Buffer.from(`${CLIENT}:${SECRET}`).toString("base64");
    if (headers.get("authorization") !== `Basic ${basic}`) return json({ error: "invalid_client" }, 401);
    return json({ access_token: "A21AAtoken", token_type: "Bearer", scope: "https://uri.paypal.com/payments/payouts", expires_in: 32400 });
  }
  if (headers.get("authorization") !== "Bearer A21AAtoken") return json({ name: "AUTHENTICATION_FAILURE" }, 401);
  if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    created.push({ body });
    return json({ batch_header: { payout_batch_id: `BATCH${created.length}ABC`, batch_status: "PENDING", sender_batch_header: body.sender_batch_header } }, 201);
  }
  const batch = /^\/v1\/payments\/payouts\/(BATCH\d+ABC)$/.exec(url.pathname)?.[1];
  if (batch) {
    const sent = created[Number(batch.slice(5, -3)) - 1].body.items as { sender_item_id: string; amount: unknown; receiver: string }[];
    return json({
      batch_header: { payout_batch_id: batch, batch_status: "SUCCESS" },
      total_pages: 1,
      items: sent.map((item, i) => ({
        payout_item_id: `ITEM${batch}${i}`,
        payout_batch_id: batch,
        transaction_status: itemStatus[item.sender_item_id] ?? "PENDING",
        payout_item: { sender_item_id: item.sender_item_id, amount: item.amount, receiver: item.receiver },
      })),
    });
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

function shop(): Store {
  return {
    sid: "sidclaim0001",
    handle: "claimharbor",
    name: "Claim Harbor",
    previousHandles: [],
    releasedHandles: [],
    statsId: STATS,
    stripeAccountId: "acct_1TestClaim00001",
    currency: "usd",
    affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
  } as unknown as Store;
}

const pipeline = redis.pipeline.bind(redis);
const ITEM = "nl:pp:item:ITEMBATCH1ABC0";
const PAYOUTS = `nl:aff:${STATS}:payouts`;
const SARA = "aaaaaaaaaaaa";
const BEN = "bbbbbbbbbbbb";

/** Affiliates owed $30 each (Sara, and Ben when `two`), sent in one batch, reported SUCCESS by PayPal. */
async function seed(store: Store, two = false): Promise<void> {
  redis.pipeline = pipeline;
  redis.clear();
  created.length = 0;
  itemStatus = {};
  const at = Math.floor(Date.now() / 1000) - 86_400;
  const person = (id: string, email: string, code: string) => JSON.stringify({ id, email, code, status: "approved", appliedAt: 1, decidedAt: 2, note: "" });
  const sale = (ref: string, aff: string) => JSON.stringify({ ref, pi: `pi_${ref}`, aff, at, product: "p1", title: "Guide", base: 10000, total: 10000, currency: "usd", rate: 30, self: false });
  await pipeline([
    ["HSET", `nl:aff:${STATS}:people`, SARA, person(SARA, "sara@example.com", "sara")],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_1", sale("cs_1", SARA)],
  ]);
  if (two) {
    await pipeline([
      ["HSET", `nl:aff:${STATS}:people`, BEN, person(BEN, "ben@example.com", "ben")],
      ["HSET", `nl:aff:${STATS}:sales`, "cs_2", sale("cs_2", BEN)],
    ]);
  }
  if (!(await connectPayPal(store, CLIENT, SECRET)).ok) throw new Error("synthetic PayPal app not kept");
  const sent = await payWithPayPal(store);
  if (!sent.ok) throw new Error(`not sent: ${sent.reason}`);
  itemStatus = two ? { [SARA]: "SUCCESS", [BEN]: "SUCCESS" } : { [SARA]: "SUCCESS" };
}

const paidOf = async (store: Store, email: string) => (await readBook(store)).rows.find((r) => r.affiliate.email === email)?.paid ?? -1;
const paidCents = (store: Store) => paidOf(store, "sara@example.com");
/** The payouts written in the book, by id. */
const bookIds = async () => {
  const flat = (await pipeline([["HGETALL", PAYOUTS]]))[0] as string[];
  return flat.filter((_, i) => i % 2 === 0);
};
/** Settled, or "threw" when settlePayPal let an error out. */
const settle = (store: Store) => settlePayPal(store).catch(() => "threw" as const);

/** Is this one command the book write of a payout for `aff` (HSET before this change, HSETNX after)? */
function bookWriteFor(commands: (string | number)[][], aff?: string): boolean {
  if (commands.length !== 1) return false;
  const [name, key, , value] = commands[0];
  if ((name !== "HSET" && name !== "HSETNX") || key !== PAYOUTS) return false;
  if (!aff) return true;
  try {
    return (JSON.parse(String(value)) as { aff?: unknown }).aff === aff;
  } catch {
    return false;
  }
}

/** The book write answered with `reply`; `land` first writes it for real, as a reply lost after the write. */
function bookWriteAnswers(reply: () => unknown[], land: boolean): void {
  redis.pipeline = async (commands) => {
    if (bookWriteFor(commands)) {
      if (land) await pipeline(commands);
      return reply();
    }
    return pipeline(commands);
  };
}

/** The store's data room answers full for the payouts slot (lib/store-data.ts TAKE_DATA: [0, used]). */
function roomFull(): void {
  redis.pipeline = async (commands) => {
    // ["EVAL", script, 1, key, room, always, month, "a", slot, bytes]
    const [name, , , , , always] = commands[0] ?? [];
    if (commands.length === 1 && name === "EVAL" && always === "0" && commands[0].includes("aff:payouts")) return [[0, 999_999_999]];
    return pipeline(commands);
  };
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_paypal_item_claim_only";
  process.env.RESEND_API_KEY = "re_test_only";
  const store = shop();

  const shapes: [string, () => unknown[]][] = [
    ["no envelope", () => []],
    ["undefined", () => [undefined]],
    ["null", () => [null]],
    ["empty text", () => [""]],
    ["another word", () => ["QUEUED"]],
    ["the number 2", () => [2]],
    ["an object", () => [{ result: 1 }]],
  ];

  part("Healthy: written into the book once, never sent to PayPal again");
  await seed(store);
  is("a clean settle writes the payout once", [await settle(store), await paidCents(store)], [{ paid: 1, released: 0, waiting: 0 }, 3000]);
  is("asked again, nothing written twice", [await settle(store), await paidCents(store), (await bookIds()).length], [{ paid: 0, released: 0, waiting: 0 }, 3000, 1]);
  await payWithPayPal(store);
  is("the next payday sends nothing more: one PayPal batch", created.length, 1);
  const [id] = await bookIds();
  is("the payout's id is one the creator can remove (12 hex)", /^[0-9a-f]{12}$/.test(id ?? ""), true);
  is("and it is removed", await removePayout(store, id ?? ""), true);

  part("Two settles at once: written once");
  await seed(store);
  await Promise.all([settle(store), settle(store)]);
  is("one payout in the book, $30", [(await bookIds()).length, await paidCents(store)], [1, 3000]);

  part("The book write answered in an unknown shape, not written: kept on their way, never paid twice (probe B)");
  for (const [label, reply] of shapes) {
    await seed(store);
    bookWriteAnswers(reply, false);
    const out = await settle(store);
    redis.pipeline = pipeline;
    is(`${label}: kept waiting, not counted paid`, out, { paid: 0, released: 0, waiting: 1 });
    is(`${label}: the book does not say paid`, await paidCents(store), 0);
    is(`${label}: still on their way`, (await onTheirWay(store)).size, 1);
    await payWithPayPal(store);
    is(`${label}: not sent to PayPal again`, created.length, 1);
    is(`${label}: read again with a clean answer, written once`, [await settle(store), await paidCents(store)], [{ paid: 1, released: 0, waiting: 0 }, 3000]);
    await payWithPayPal(store);
    is(`${label}: one PayPal batch in all`, created.length, 1);
  }

  part("The book write landed, its reply lost: kept on their way, then found in the book (probe A)");
  for (const [label, reply] of shapes) {
    await seed(store);
    bookWriteAnswers(reply, true);
    const out = await settle(store);
    redis.pipeline = pipeline;
    is(`${label}: kept waiting`, out, { paid: 0, released: 0, waiting: 1 });
    is(`${label}: read again, found in the book, no longer waiting`, await settle(store), { paid: 0, released: 0, waiting: 0 });
    is(`${label}: one payout, $30`, [(await bookIds()).length, await paidCents(store)], [1, 3000]);
    await payWithPayPal(store);
    is(`${label}: one PayPal batch in all`, created.length, 1);
  }

  part("Redis failing on the book write: kept on their way, the settling does not throw");
  await seed(store);
  redis.pipeline = async (commands) => {
    if (bookWriteFor(commands)) throw new Error("synthetic Redis outage");
    return pipeline(commands);
  };
  const outage = await settle(store);
  redis.pipeline = pipeline;
  is("the settling says so", outage, { paid: 0, released: 0, waiting: 1 });
  is("the book does not say paid on an outage", await paidCents(store), 0);
  await payWithPayPal(store);
  is("and the affiliate is not sent again", [(await onTheirWay(store)).size, created.length], [1, 1]);
  is("read again, written once", [await settle(store), await paidCents(store)], [{ paid: 1, released: 0, waiting: 0 }, 3000]);

  part("The store's data room full: kept on their way over paydays, never sent again (probe C)");
  await seed(store);
  for (const day of [1, 2, 3]) {
    roomFull();
    const out = await settle(store);
    await payWithPayPal(store);
    redis.pipeline = pipeline;
    is(`day ${day}: kept waiting, the book does not say paid, one PayPal batch`, [out, await paidCents(store), created.length], [{ paid: 0, released: 0, waiting: 1 }, 0, 1]);
  }
  is("room again: written once", [await settle(store), await paidCents(store)], [{ paid: 1, released: 0, waiting: 0 }, 3000]);
  await payWithPayPal(store);
  is("one PayPal batch in all", created.length, 1);

  part("One line that cannot be written does not stop the others");
  await seed(store, true);
  redis.pipeline = async (commands) => {
    if (bookWriteFor(commands, SARA)) throw new Error("synthetic Redis outage");
    return pipeline(commands);
  };
  const mixed = await settle(store);
  redis.pipeline = pipeline;
  is("Ben written, Sara kept waiting", [mixed, await paidOf(store, "ben@example.com"), await paidCents(store)], [{ paid: 1, released: 0, waiting: 1 }, 3000, 0]);
  is("read again, Sara written once, Ben not twice", [await settle(store), await paidCents(store), await paidOf(store, "ben@example.com")], [{ paid: 1, released: 0, waiting: 0 }, 3000, 3000]);
  await payWithPayPal(store);
  is("one PayPal batch in all", created.length, 1);

  part("A mark left by an earlier run, with no payout in the book: written once (not dropped)");
  await seed(store);
  await pipeline([["SET", ITEM, "BATCH1ABC", "EX", 3600]]);
  is("written into the book once", [await settle(store), await paidCents(store)], [{ paid: 1, released: 0, waiting: 0 }, 3000]);
  await payWithPayPal(store);
  is("the next payday sends nothing more", created.length, 1);

  part("A mark left by an earlier run, the payout in the book under its own id: nothing written twice");
  await seed(store);
  await pipeline([
    ["SET", ITEM, "BATCH1ABC", "EX", 3600],
    ["HSET", PAYOUTS, "0123456789ab", JSON.stringify({ id: "0123456789ab", aff: SARA, cents: 3000, currency: "usd", date: "2026-11-01", reference: "PayPal ITEMBATCH1ABC0", at: 1 })],
  ]);
  is("found by its reference, no longer waiting", [await settle(store), await paidCents(store), (await bookIds()).length], [{ paid: 0, released: 0, waiting: 0 }, 3000, 1]);

  part("A mark left by an earlier run, read in an unknown shape: kept on their way, nothing written");
  for (const [label, reply] of shapes.filter(([l]) => l !== "null" && l !== "another word")) {
    await seed(store);
    await pipeline([["SET", ITEM, "BATCH1ABC", "EX", 3600]]);
    redis.pipeline = async (commands) => {
      if (commands.length === 1 && (commands[0][0] === "GET" || commands[0][0] === "SET") && commands[0][1] === ITEM) return reply();
      return pipeline(commands);
    };
    const out = await settle(store);
    redis.pipeline = pipeline;
    is(`${label}: kept waiting, the book does not say paid`, [out, await paidCents(store)], [{ paid: 0, released: 0, waiting: 1 }, 0]);
  }

  part("A mark read back as any other text: confirmed by the book, so written once");
  await seed(store);
  redis.pipeline = async (commands) => {
    if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === ITEM) return ["QUEUED"];
    return pipeline(commands);
  };
  const other = await settle(store);
  redis.pipeline = pipeline;
  is("not in the book, so written once", [other, await paidCents(store)], [{ paid: 1, released: 0, waiting: 0 }, 3000]);

  part("A mark left by an earlier run, the book's payouts read in an unknown shape: kept on their way");
  for (const [label, reply] of [...shapes, ["an odd list", () => [["0123456789ab"]]] as [string, () => unknown[]]]) {
    await seed(store);
    await pipeline([["SET", ITEM, "BATCH1ABC", "EX", 3600]]);
    redis.pipeline = async (commands) => {
      if (commands.length === 1 && commands[0][0] === "HGETALL" && commands[0][1] === PAYOUTS) return reply();
      return pipeline(commands);
    };
    const out = await settle(store);
    redis.pipeline = pipeline;
    is(`${label}: kept waiting, the book does not say paid`, [out, await paidCents(store)], [{ paid: 0, released: 0, waiting: 1 }, 0]);
  }

  part("The affiliate's record read in an unknown shape: kept on their way, never paid twice (Claude 5 on #3272, finding 1)");
  const recordShapes: [string, () => unknown[]][] = [
    ["no envelope", () => []],
    ["undefined", () => [undefined]],
    ["the number 1", () => [1]],
    ["an object", () => [{ odd: true }]],
    ["a list", () => [["x"]]],
    ["empty text", () => [""]],
    ["text that is not JSON", () => ["not json"]],
    ["JSON that is not a record", () => ['{"id":"x"}']],
  ];
  for (const [label, reply] of recordShapes) {
    await seed(store);
    let first = true;
    redis.pipeline = async (commands) => {
      if (first && commands.length === 1 && commands[0][0] === "HGET" && commands[0][1] === `nl:aff:${STATS}:people` && commands[0][2] === SARA) {
        first = false;
        return reply();
      }
      return pipeline(commands);
    };
    const out = await settle(store);
    redis.pipeline = pipeline;
    is(`${label}: kept waiting, not counted paid`, out, { paid: 0, released: 0, waiting: 1 });
    is(`${label}: the book does not say paid, nothing written`, [await paidCents(store), (await bookIds()).length], [0, 0]);
    is(`${label}: still on their way`, (await onTheirWay(store)).size, 1);
    await payWithPayPal(store);
    is(`${label}: not sent to PayPal again`, created.length, 1);
    is(`${label}: read again with a clean answer, written once`, [await settle(store), await paidCents(store)], [{ paid: 1, released: 0, waiting: 0 }, 3000]);
    await payWithPayPal(store);
    is(`${label}: one PayPal batch in all`, created.length, 1);
  }

  part("The affiliate confirmed gone (no record): the line leaves the batch, nothing is sent again");
  await seed(store);
  await pipeline([["HDEL", `nl:aff:${STATS}:people`, SARA]]);
  is("settled as before: no longer waiting, nothing written", [await settle(store), (await bookIds()).length], [{ paid: 1, released: 0, waiting: 0 }, 0]);
  await payWithPayPal(store);
  is("no one left to pay: one PayPal batch in all", created.length, 1);

  part("Written, its reply lost, then the data room full: found in the book without new room (Claude 5 on #3272, finding 2)");
  await seed(store);
  bookWriteAnswers(() => [], true);
  is("the lost reply keeps it waiting", await settle(store), { paid: 0, released: 0, waiting: 1 });
  for (const day of [1, 2, 3]) {
    roomFull();
    const out = await settle(store);
    redis.pipeline = pipeline;
    is(`day ${day}: found in the book, no longer waiting`, [out, (await onTheirWay(store)).size], [{ paid: 0, released: 0, waiting: 0 }, 0]);
  }
  is("one payout, $30", [(await bookIds()).length, await paidCents(store)], [1, 3000]);
  await payWithPayPal(store);
  is("one PayPal batch in all", created.length, 1);

  part("Whether the book holds the payout, read in an unknown shape: kept on their way, nothing written");
  for (const [label, reply] of [...shapes.filter(([l]) => l !== "null"), ["the number 1 as text", () => ["1"]] as [string, () => unknown[]]]) {
    await seed(store);
    redis.pipeline = async (commands) => {
      if (commands.length === 1 && commands[0][0] === "HEXISTS" && commands[0][1] === PAYOUTS) return reply();
      return pipeline(commands);
    };
    const out = await settle(store);
    redis.pipeline = pipeline;
    is(`${label}: kept waiting, the book does not say paid`, [out, await paidCents(store), (await bookIds()).length], [{ paid: 0, released: 0, waiting: 1 }, 0, 0]);
    await payWithPayPal(store);
    is(`${label}: not sent to PayPal again`, created.length, 1);
  }

  done();
}

void main();
