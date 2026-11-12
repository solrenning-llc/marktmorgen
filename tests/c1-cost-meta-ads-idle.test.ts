/**
 * The five-minute import job's Meta pass (lib/meta-ads.ts readMetaDue) costs
 * O(1) Redis commands on a run with nothing to read.
 *
 * Every connected store is read once a UTC day; the job runs 288 times a day.
 * Before this test, every run read two keys of every connected store (the
 * connection and the day's read), 1 + 2M commands, to learn that each was
 * already read today. Now a run that walked every store and found nothing due
 * keeps a pass mark until the next moment one can be due (the next UTC day, or
 * the earliest wait out of a problem), tied to a generation that a new
 * connection or a newly chosen account moves on, so such a store is read on
 * the very next run. Checked here:
 *
 *   - with 500 stores all read today, the run after the first sends at most 5
 *     commands (it sent 1,001);
 *   - choosing another account (a store due now) makes the next run walk again
 *     and ask for that store;
 *   - a run that did not see every store (a store not read, or out of time)
 *     leaves no mark;
 *   - the mark runs out by the next UTC day, so the daily read is never lost;
 *   - a store whose plan's costs are paused waits for the next day, as the
 *     pass says, instead of being looked up every five minutes.
 */
import { chooseAccount, readMetaDue } from "@/lib/meta-ads";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail, storeForId } from "@/lib/store";
import { costsPaused } from "@/lib/plan-standing";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

process.env.META_APP_ID = "123456789012345";
process.env.META_APP_SECRET = "meta-app-secret-for-tests-0123456789";

const today = new Date().toISOString().slice(0, 10);
const M = 500;

let commands = 0;
const original = redis.pipeline;
redis.pipeline = async (batch: (string | number)[][]) => {
  commands += batch.length;
  return original(batch);
};
const counted = async <T>(work: () => Promise<T>): Promise<{ value: T; commands: number }> => {
  const before = commands;
  const value = await work();
  return { value, commands: commands - before };
};

const statsIdOf = (i: number) => `s${String(i).padStart(10, "0")}`;
const connection = (i: number) =>
  JSON.stringify({
    user: `1015000000000${String(i).padStart(4, "0")}`,
    token: "sealed-token-not-read-here",
    expires: 0,
    accounts: [
      { id: "act_111", name: "Harbor Ads", currency: "usd" },
      { id: "act_222", name: "Second", currency: "usd" },
    ],
    account: "act_111",
    connectedAt: 1,
    by: "owner@example.com",
    sid: `sid${i}`,
    owner: { email: "owner@example.com", handle: `h${i}` },
    broken: "",
  });
const readToday = JSON.stringify({ day: today, at: Math.floor(Date.now() / 1000), problem: "", after: 0, lines: 0, cents: 0, campaigns: 0 });

async function main(): Promise<void> {
await redis.pipeline(
  Array.from({ length: M }, (_, i) => [
    ["SET", `nl:metaads:conn:${statsIdOf(i)}`, connection(i)],
    ["SET", `nl:metaads:read:${statsIdOf(i)}`, readToday],
    ["SADD", "nl:metaads:stores", statsIdOf(i)],
  ]).flat(),
);

const asked: string[] = [];
const noStore = async (sid: string) => {
  asked.push(sid);
  return null;
};

const first = await counted(() => readMetaDue(Date.now() + 60_000, noStore));
is("the first run reads nobody: every store was read today", [first.value.read, asked.length], [0, 0]);
const second = await counted(() => readMetaDue(Date.now() + 60_000, noStore));
is(`with ${M} stores all read today, the next run sends at most 5 Redis commands (it sent ${second.commands})`, second.commands <= 5, true);
const third = await counted(() => readMetaDue(Date.now() + 60_000, noStore));
is("and so does every run after it", third.commands <= 5, true);

// A store due now: another account chosen, its day's read forgotten.
is("choosing another account is taken", await chooseAccount(statsIdOf(7), "act_222"), true);
const afterChoice = await counted(() => readMetaDue(Date.now() + 60_000, noStore));
is("the run after a new account walks again and asks for that store", [afterChoice.commands > M, asked], [true, ["sid7"]]);
const stillDue = await counted(() => readMetaDue(Date.now() + 60_000, noStore));
is("a store that could not be looked up keeps every run walking (no mark on what was not seen)", [stillDue.commands > M, asked.length], [true, 2]);

// The store read again: the walk is whole and the mark comes back.
await redis.pipeline([["SET", `nl:metaads:read:${statsIdOf(7)}`, readToday]]);
await readMetaDue(Date.now() + 60_000, noStore);
const quiet = await counted(() => readMetaDue(Date.now() + 60_000, noStore));
is("once every store is settled again, the run is O(1) again", quiet.commands <= 5, true);

// A run out of time sees only part of the list: no mark.
await redis.pipeline([["DEL", "nl:metaads:pass"], ["INCR", "nl:metaads:gen"]]);
await readMetaDue(Date.now() - 1, noStore);
const afterShort = await counted(() => readMetaDue(Date.now() + 60_000, noStore));
is("a run that ran out of time leaves no mark: the next one walks", afterShort.commands > M, true);

// The mark runs out by the next UTC day.
const ttl = Number((await original([["TTL", "nl:metaads:pass"]]))[0]);
const nextDay = Math.ceil((Date.parse(`${today}T00:00:00Z`) + 86_400_000 - Date.now()) / 1000);
is("the mark lasts no longer than the rest of the UTC day", ttl > 0 && ttl <= nextDay, true);
redis.advance((ttl + 1) * 1000);
const tomorrow = await counted(() => readMetaDue(Date.now() + 60_000, noStore));
is("once it runs out, the next run walks every store again", tomorrow.commands > M, true);
redis.clear();

// A store waiting out a problem an hour from now: the mark lasts no longer than that.
await redis.pipeline([
  ["SET", `nl:metaads:conn:${statsIdOf(1)}`, connection(1)],
  ["SET", `nl:metaads:read:${statsIdOf(1)}`, JSON.stringify({ day: "", at: 0, problem: "busy", after: Math.floor(Date.now() / 1000) + 3600, lines: 0, cents: 0, campaigns: 0 })],
  ["SADD", "nl:metaads:stores", statsIdOf(1)],
]);
await readMetaDue(Date.now() + 60_000, noStore);
const waitTtl = Number((await original([["TTL", "nl:metaads:pass"]]))[0]);
is("a store waiting out a problem bounds the mark to its wait", waitTtl > 0 && waitTtl <= 3601, true);
redis.clear();

// A store whose plan's costs are paused: looked up once, then tried again the next day, not every five minutes.
const OWNER = "paused-meta@example.com";
await claimHandle(OWNER, "paused-meta-shop", "Paused Meta Shop", "");
await ensureStatsId(OWNER);
await setSubscription(OWNER, { customerId: "cus_PausedMetaCost01", subscriptionId: "sub_PausedMetaCost01", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: true });
const paused = (await storeForEmail(OWNER))!;
is("the store's costs are paused", costsPaused(paused), true);
await redis.pipeline([
  ["SET", `nl:metaads:conn:${paused.statsId}`, JSON.stringify({ ...JSON.parse(connection(3)), sid: paused.sid })],
  ["SADD", "nl:metaads:stores", paused.statsId!],
  ...Array.from({ length: M }, (_, i) => [
    ["SET", `nl:metaads:conn:${statsIdOf(i)}`, connection(i)],
    ["SET", `nl:metaads:read:${statsIdOf(i)}`, readToday],
    ["SADD", "nl:metaads:stores", statsIdOf(i)],
  ]).flat(),
]);
let lookups = 0;
const counting = async (sid: string) => {
  lookups += 1;
  return storeForId(sid);
};
const pausedRun = await readMetaDue(Date.now() + 60_000, counting);
is("the paused store is skipped, looked up once", [pausedRun.read, pausedRun.skipped, lookups], [0, 1, 1]);
const afterPaused = await counted(() => readMetaDue(Date.now() + 60_000, counting));
is("the next run is O(1) and does not look it up again", [afterPaused.commands <= 5, lookups], [true, 1]);

done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
