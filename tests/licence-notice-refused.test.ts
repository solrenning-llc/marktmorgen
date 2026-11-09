/**
 * A creator's license-key notice that a sender refused for certain is owed,
 * never dropped (rule 30 of the owner's EM1, beside lib/order-mail-owed.ts;
 * Claude 5, 9 November 2026). lib/licence-keys.ts tells the creator when a
 * buyer paid as the keys ran out ("a buyer is waiting for a license key")
 * and when the pool runs low; both took the store's email figure and threw a
 * certain refusal away, so the creator never heard the keys were gone and
 * the buyer waited with no key.
 *
 *   refused    owed: tried again by the email job, under the same
 *              idempotency key, against the store's own email figure
 *              (meter "store"), until sent, uncertain, or REFUSED_TRIES
 *              refusals; never sent once it is no longer true (the buyer
 *              was given a key, the pool was topped up);
 *   uncertain  never sent again;
 *   once       the same notice is never sent twice for one sale or one
 *              low pool.
 *
 * Synthetic Redis (tests/redis-stub.ts) and a scripted sender
 * (tests/licence-notice-world.ts); no email leaves.
 */
import { addProduct, claimHandle, ensureStatsId, setProductKeys, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { addKeys, keyForSale } from "@/lib/licence-keys";
import { OWED_MAIL_RETRY_SECONDS, sendOwedOrderMail } from "@/lib/order-mail-owed";
import { REFUSED_TRIES } from "@/lib/refused-tries";
import { answers, sends } from "./licence-notice-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "keys-maker@example.com";
const clock = Date.now;
let at = clock();
Date.now = () => at;
// The synthetic Redis reads the same clock (lib/redis-memory.ts), so its expiries move with it.
const wait = (seconds: number) => {
  at += seconds * 1000;
};
const owed = () => redis.keys().filter((k) => k.startsWith("nl:owedmail:m:")).length;
const run = () => sendOwedOrderMail(storeForHandle, Date.now() + 10_000);
const keysOf = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `${tag}-${String(i + 1).padStart(4, "0")}-ABCD-EFGH`);
const notices = () => sends.filter((s) => s.to === OWNER);
const reset = () => {
  sends.length = 0;
  answers.length = 0;
};

// The stand-in database has no LPOP (lib/licence-keys.ts, keyForSale): LINDEX then LTRIM, as tests/orders-page-bounds.test.ts does.
{
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!commands.some((command) => command[0] === "LPOP")) return pipeline(commands);
    const replies: unknown[] = [];
    for (const command of commands) {
      if (command[0] !== "LPOP") {
        replies.push(...(await pipeline([command])));
        continue;
      }
      const [first] = await pipeline([["LINDEX", command[1], 0]]);
      if (first !== null && first !== undefined) await pipeline([["LTRIM", command[1], 1, -1]]);
      replies.push(first ?? null);
    }
    return replies;
  }) as typeof redis.pipeline;
}

async function main(): Promise<void> {
  await claimHandle(OWNER, "keyshop", "Key Shop", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_KeyShop0001", subscriptionId: "sub_KeyShop0001", active: true, period: paidPeriod() });
  const product = async (title: string, lowAt: number, keys: number) => {
    const made = await addProduct(OWNER, title, "", "29", null);
    await setProductKeys(OWNER, made.product.id, { source: "pool", prefix: "", groups: 4, groupLength: 4, lowAt });
    const store = (await storeForEmail(OWNER))!;
    const listing = (await readListing(store, made.product.id))!;
    if (keys) await addKeys(store, listing, keysOf(title.slice(0, 4).toUpperCase(), keys));
    return { store, listing };
  };

  part("The pool runs low and the warning is refused for certain: owed, sent by the job, against the store's figure");
  {
    const { store, listing } = await product("Lowp App", 1, 2);
    reset();
    answers.push("refused");
    const given = await keyForSale(store, listing, "cs_low_1", "buyer1@example.test");
    is("the buyer has a key", given?.state, "issued");
    is("one warning tried, to the creator, from the store's email figure", [notices().length, notices()[0]?.meter.by, notices()[0]?.meter.kind, notices()[0]?.subject], [1, "store", "email", "1 license key left for Lowp App"]);
    is("refused: kept, not dropped", owed(), 1);
    await run();
    is("not tried before its wait", notices().length, 1);
    wait(OWED_MAIL_RETRY_SECONDS[0]);
    const after = await run();
    is("tried after it and sent", [notices().length, after.sent], [2, 1]);
    is("the same warning, under the same idempotency key, from the store's figure again", [notices()[1]?.subject, notices()[1]?.idempotencyKey === notices()[0]?.idempotencyKey, Boolean(notices()[0]?.idempotencyKey), notices()[1]?.meter.by, notices()[1]?.meter.store?.handle], [notices()[0]?.subject, true, true, "store", "keyshop"]);
    is("nothing owed any more", owed(), 0);
    await keyForSale(store, listing, "cs_low_2", "buyer2@example.test");
    is("the pool's next sale under the mark sends no second warning", notices().length, 2);
  }

  part("The pool is topped up before the owed warning's turn: the warning is no longer true, never sent");
  {
    const { store, listing } = await product("Topp App", 1, 2);
    reset();
    answers.push("refused");
    await keyForSale(store, listing, "cs_top_1", "buyer3@example.test");
    is("refused and kept", [notices().length, owed()], [1, 1]);
    await addKeys(store, listing, keysOf("TOPX", 5));
    wait(OWED_MAIL_RETRY_SECONDS[0]);
    await run();
    is("the job does not send it, and lets it go", [notices().length, owed()], [1, 0]);
  }

  part("A buyer paid as the keys ran out, and the creator's notice is refused for certain: owed, sent by the job");
  {
    const { store, listing } = await product("Wait App", 0, 0);
    reset();
    answers.push("refused");
    const waiting = await keyForSale(store, listing, "cs_wait_1", "waiter@example.test");
    is("the buyer waits", waiting?.state, "waiting");
    is("one notice tried, from the store's figure", [notices().length, notices()[0]?.meter.by, notices()[0]?.subject], [1, "store", "A buyer of Wait App is waiting for a license key"]);
    is("refused: kept, not dropped", owed(), 1);
    await keyForSale(store, listing, "cs_wait_1", "waiter@example.test");
    is("the same sale asked again sends no second notice", notices().length, 1);
    wait(OWED_MAIL_RETRY_SECONDS[0]);
    await run();
    is("the job sends it, the same notice under the same key", [notices().length, notices()[1]?.idempotencyKey === notices()[0]?.idempotencyKey, notices()[1]?.text === notices()[0]?.text], [2, true, true]);
    is("nothing owed any more", owed(), 0);
  }

  part("The waiting buyer is given a key before the owed notice's turn: never sent");
  {
    const { store, listing } = await product("Serv App", 0, 0);
    reset();
    answers.push("refused");
    await keyForSale(store, listing, "cs_serve_1", "served@example.test");
    is("refused and kept", [notices().length, owed()], [1, 1]);
    const added = await addKeys(store, listing, keysOf("SERV", 3));
    is("the buyer is given a key from the upload, and emailed it", [added.served, sends.filter((s) => s.to === "served@example.test").length], [1, 1]);
    wait(OWED_MAIL_RETRY_SECONDS[0]);
    await run();
    is("the job does not send the notice, and lets it go", [notices().length, owed()], [1, 0]);
  }

  part("Uncertain: never sent again");
  {
    const { store, listing } = await product("Unkn App", 0, 0);
    reset();
    answers.push("uncertain");
    await keyForSale(store, listing, "cs_unknown_1", "unsure@example.test");
    is("tried once, nothing owed", [notices().length, owed()], [1, 0]);
    wait(OWED_MAIL_RETRY_SECONDS.at(-1)!);
    await run();
    is("and never again", notices().length, 1);
  }

  part(`Refused ${REFUSED_TRIES} times: given up, at most REFUSED_TRIES tries, and no note about the creator's own notice`);
  {
    const { store, listing } = await product("Gone App", 0, 0);
    reset();
    for (let i = 0; i < REFUSED_TRIES + 2; i += 1) answers.push("refused");
    await keyForSale(store, listing, "cs_gone_1", "gone@example.test");
    for (const seconds of [...OWED_MAIL_RETRY_SECONDS, ...OWED_MAIL_RETRY_SECONDS]) {
      wait(seconds);
      await run();
    }
    is("tried REFUSED_TRIES times in all, then given up", [notices().length, owed()], [REFUSED_TRIES, 0]);
    is("nothing else sent: no note to the creator about their own notice", sends.length, REFUSED_TRIES);
  }

  Date.now = clock;
  done();
}

void main();
