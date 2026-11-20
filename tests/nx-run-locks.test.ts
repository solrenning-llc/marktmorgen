/**
 * One run at a time, on an exact claim (CX-123 rule 24, lib/claim-mark.ts): the affiliates' payday job, a closing
 * store's refunds of unused time, and a creator's calendar read. "OK", or our own value read back, is ours; nil is
 * another run's; anything else is unknown, and nothing runs on it — and another run's lock is never deleted.
 * Synthetic data only.
 */
import { GET as affiliatesCron } from "@/app/api/cron/affiliates/route";
import { giveBackUnused } from "@/lib/closing-refunds";
import { calendarBusy } from "@/lib/calendar-sync";
import { claimHandle, ensureStatsId, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.RESEND_API_KEY = "re_test_nx_run_locks_only";
process.env.CRON_SECRET = "synthetic-cron-secret";
globalThis.fetch = (async () => {
  return Response.json({ object: "list", data: [], has_more: false, available: [] });
}) as typeof fetch;

type Command = (string | number)[];
const original = redis.pipeline.bind(redis);
/** The SET NX on `key` answered by `answer` (given whether it wrote); every other command as the stand-in answers it. */
function claimAnswers(key: string, answer: (wrote: boolean) => unknown[] | Error, read?: () => unknown[]) {
  redis.pipeline = async (commands: Command[]) => {
    const [first] = commands;
    if (commands.length === 1 && first[0] === "SET" && first[1] === key && first.includes("NX")) {
      const wrote = (await original(commands))[0] === "OK";
      const reply = answer(wrote);
      if (reply instanceof Error) throw reply;
      return reply;
    }
    if (read && commands.length === 1 && first[0] === "GET" && first[1] === key) return read();
    return original(commands);
  };
}
const restore = () => { redis.pipeline = original; };
const get = async (key: string) => (await original([["GET", key]]))[0];
const malformed = [["undefined", [undefined]], ["no reply", []], ["text", ["QUEUED"]], ["a number", [1]]] as const;

async function main(): Promise<void> {
  part("the affiliates' payday job");
  const lock = "nl:aff:payday:lock";
  const cron = async () => {
    const response = await affiliatesCron(new Request("https://example.com/api/cron/affiliates", { headers: { authorization: "Bearer synthetic-cron-secret" } }) as never);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  for (const [label, reply] of malformed) {
    redis.clear();
    await original([["SET", lock, "another-run", "EX", 300]]);
    claimAnswers(lock, () => [...reply]);
    const answer = await cron();
    restore();
    is(`${label} while another run holds it: read back as another run's, busy, nothing runs`, [answer.status, answer.body.busy, answer.body.settled === undefined], [200, true, true]);
    is(`${label} while another run holds it: its lock is left to it`, await get(lock), "another-run");
  }
  redis.clear();
  claimAnswers(lock, () => [undefined], () => [undefined]);
  const unknown = await cron();
  restore();
  is("a lock answered and read back in no known shape: nothing runs, said as not known", [unknown.status, unknown.body.ok, unknown.body.settled === undefined], [503, false, true]);
  redis.clear();
  claimAnswers(lock, () => new Error("synthetic lost reply"));
  const lost = await cron().catch(() => ({ status: "threw", body: {} as Record<string, unknown> }));
  restore();
  is("a lock taken whose reply was lost: read back as ours, the job runs and lets go after", [lost.status, lost.body.ok, await get(lock)], [200, true, null]);
  redis.clear();
  const healthy = await cron();
  is("healthy: the job runs and lets go of its lock", [healthy.status, healthy.body.ok, await get(lock)], [200, true, null]);
  redis.clear();
  await original([["SET", lock, "another-run", "EX", 300]]);
  const busy = await cron();
  is("held by another run (nil): busy, its lock kept", [busy.status, busy.body.busy, await get(lock)], [200, true, "another-run"]);

  part("a closing store's refunds of unused time");
  const email = "nx-closing@example.com";
  const seed = async () => {
    redis.clear();
    await claimHandle(email, "nxclosing", "Closing fixture", "");
    const shop = (await storeForEmail(email))!;
    return { seller: { ...shop, stripeAccountId: "acct_nxclosing" } as Store, refundLock: `nl:closing:refund:${await storeFolder(email)}` };
  };
  for (const [label, reply] of malformed) {
    const { seller, refundLock } = await seed();
    await original([["SET", refundLock, "another-run", "EX", 120]]);
    claimAnswers(refundLock, () => [...reply]);
    let out: unknown = "threw";
    try { out = await giveBackUnused(seller, Date.UTC(2026, 10, 6)); } catch { /* checked below */ }
    restore();
    is(`${label} while another run holds it: busy, nothing given back this run`, out, "busy");
    is(`${label} while another run holds it: its lock is left to it`, await get(refundLock), "another-run");
  }
  {
    const { seller, refundLock } = await seed();
    claimAnswers(refundLock, () => new Error("synthetic lost reply"));
    let out: unknown = "threw";
    try { out = await giveBackUnused(seller, Date.UTC(2026, 10, 6)); } catch { /* checked below */ }
    restore();
    is("a lock taken whose reply was lost: read back as ours, the refunds run and let go after", [typeof out, await get(refundLock)], ["object", null]);
  }
  {
    const { seller, refundLock } = await seed();
    claimAnswers(refundLock, () => [undefined], () => [undefined]);
    const out = await giveBackUnused(seller, Date.UTC(2026, 10, 6));
    restore();
    is("a lock answered and read back in no known shape: busy, tried again later", out, "busy");
  }
  {
    const { seller, refundLock } = await seed();
    is("healthy: the refunds run and let go of the lock", [typeof (await giveBackUnused(seller, Date.UTC(2026, 10, 6))), await get(refundLock)], ["object", null]);
    await original([["SET", refundLock, "another-run", "EX", 120]]);
    is("held by another run (nil): busy, its lock kept", [await giveBackUnused(seller, Date.UTC(2026, 10, 6)), await get(refundLock)], ["busy", "another-run"]);
  }

  part("a creator's calendar read");
  const feed = "0123456789abcdef";
  const calLock = `nl:cal:lock:${feed}`;
  let tries = 0;
  const hooks = { resolve: async () => { tries += 1; throw new Error("synthetic: no network in this test"); } };
  const seedCalendar = async () => {
    redis.clear();
    await claimHandle("nx-calendar@example.com", "nxcalendar", "Calendar fixture", "");
    await ensureStatsId("nx-calendar@example.com");
    const shop = (await storeForEmail("nx-calendar@example.com"))!;
    await original([["SET", `nl:cal:cfg:${shop.statsId}`, JSON.stringify({ handle: shop.handle, feeds: [{ id: feed, url: "https://calendar.nx-fixture.dev/feed.ics" }], token: null, tokenAt: "" })]]);
    tries = 0;
    return shop;
  };
  for (const [label, reply] of malformed) {
    const shop = await seedCalendar();
    await original([["SET", calLock, "another-run", "EX", 20]]);
    claimAnswers(calLock, () => [...reply]);
    await calendarBusy(shop, Date.now(), hooks);
    restore();
    is(`${label} while another run reads it: not read again`, tries, 0);
    is(`${label} while another run reads it: its lock is left to it`, await get(calLock), "another-run");
  }
  {
    const shop = await seedCalendar();
    claimAnswers(calLock, () => new Error("synthetic lost reply"));
    await calendarBusy(shop, Date.now(), hooks).catch(() => null);
    restore();
    is("a lock taken whose reply was lost: read back as ours, the calendar is read and the lock let go", [tries > 0, await get(calLock)], [true, null]);
  }
  {
    const shop = await seedCalendar();
    await calendarBusy(shop, Date.now(), hooks);
    is("healthy: the calendar is read and the lock let go", [tries > 0, await get(calLock)], [true, null]);
  }
  done();
}
void main();
