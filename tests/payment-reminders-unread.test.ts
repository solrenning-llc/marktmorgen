/**
 * The daily payment-request reminders, when a store cannot be read just now
 * (rule 24): never taken as gone. A thrown read (a Redis timeout) used to
 * drop the reminder for good (ZREM), so the buyer was never reminded of what
 * they owe. Now only a store or request confirmed absent drops it; one not
 * read is put off a day and tried again.
 * The request's own record read in an unknown shape (no reply, a number, an
 * object, a record that does not parse) is not "gone" either (Claude 5 on
 * #2887): put off a day, never dropped; the record's own expiry (KEEP_DAYS)
 * is what at last makes it a real nil.
 * Synthetic only: the Redis stub.
 */
import { sendDueReminders } from "@/lib/payment-requests";
import { claimHandle, ensureStoreId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const SID = "0123456789abcdef0123456789abcdef";
const ID = "fedcba9876543210fedcba9876543210";
const DUE = "nl:payreq:due";
const real = redis.pipeline.bind(redis);
type Commands = (string | number)[][];

async function main(): Promise<void> {
  console.error = () => {};
  redis.clear();
  const now = Date.now();
  await real([["ZADD", DUE, String(now - 1000), `${SID}|${ID}`]]);

  part("The store's record read throws");
  const sent: Commands = [];
  redis.pipeline = (async (c: Commands) => {
    sent.push(...c);
    if (c[0]?.[0] === "GET" && c[0][1] === `nl:store:id:${SID}`) throw new Error("Synthetic: Redis timed out");
    return real(c);
  }) as typeof redis.pipeline;
  try {
    await sendDueReminders(Date.now() + 10_000, now);
  } finally {
    redis.pipeline = real;
  }
  is("the reminder is not dropped", sent.filter((c) => c[0] === "ZREM").length, 0);
  const [score] = await real([["ZSCORE", DUE, `${SID}|${ID}`]]);
  is("it waits for a later run", score !== null && Number(score) > now, true);

  part("Control: a store confirmed absent drops it");
  await real([["ZADD", DUE, String(now - 1000), `${SID}|${ID}`]]);
  await sendDueReminders(Date.now() + 10_000, now);
  is("dropped", (await real([["ZSCORE", DUE, `${SID}|${ID}`]]))[0], null);

  part("The request's record is read in an unknown shape");
  const owner = "reminders-unread@example.com";
  await claimHandle(owner, "remindunread", "Reminder Unread", "");
  await ensureStoreId(owner);
  const store = (await storeForEmail(owner))!;
  const entry = `${store.sid}|${ID}`;
  const shapes: [string, (c: Commands) => unknown[]][] = [
    ["no reply at all", () => []],
    ["a number", () => [42]],
    ["an object", () => [{ id: ID }]],
    ["a record that does not parse", () => ["{not json"]],
    ["a record the parser refuses (no store id)", () => [JSON.stringify({ id: ID })]],
  ];
  for (const [what, reply] of shapes) {
    await real([["ZADD", DUE, String(now - 1000), entry]]);
    const zrem: Commands = [];
    redis.pipeline = (async (c: Commands) => {
      for (const command of c) if (command[0] === "ZREM") zrem.push(command);
      if (c.length === 1 && c[0][0] === "GET" && c[0][1] === `nl:payreq:r:${ID}`) return reply(c);
      return real(c);
    }) as typeof redis.pipeline;
    try {
      await sendDueReminders(Date.now() + 10_000, now);
    } finally {
      redis.pipeline = real;
    }
    const [at] = await real([["ZSCORE", DUE, entry]]);
    is(`${what}: the reminder is not dropped`, zrem.length, 0);
    is(`${what}: it waits for a later run`, at !== null && Number(at) > now, true);
  }

  part("Control: the store is found, the request confirmed absent, so it is dropped");
  await real([["ZADD", DUE, String(now - 1000), entry]]);
  await sendDueReminders(Date.now() + 10_000, now);
  is("dropped", (await real([["ZSCORE", DUE, entry]]))[0], null);
  done();
}

void main();
