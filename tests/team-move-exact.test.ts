/**
 * Moving a teammate's sign-in address keeps their teams when what was read is
 * not known (rule 24; Codex G's MEDIUM 4223 and 4224 on lib/team.ts
 * moveMemberships). Before, an index of their stores answered in another shape
 * read as "on no team", and a store whose record answered in another shape read
 * as "moved": either way the old address's index was deleted, so the person
 * dropped off teams they were still on. Now an index that does not read whole
 * stops the move of their teams with an error (the route logs it and the move
 * of the account stands), and a store that does not read is kept on the old
 * index; only a store whose record is confirmed gone is dropped.
 * Synthetic in-memory Redis only.
 */
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { memberStores, moveMemberships, putMember, readTeam } from "@/lib/team";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Commands = (string | number)[][];
const original = redis.pipeline.bind(redis);

/** Runs work with every `name` of `key` answered by `reply`. */
async function answering<T>(name: string, key: (k: string) => boolean, reply: unknown, work: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Commands) => {
    const replies = await original(commands);
    return commands.map((c, at) => (c[0] === name && key(String(c[1])) ? reply : replies[at]));
  }) as typeof redis.pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

/** The key of a person's index of teams, as putMember writes it. */
async function indexOf(work: () => Promise<unknown>): Promise<string> {
  let found = "";
  redis.pipeline = (async (commands: Commands) => {
    for (const c of commands) if (c[0] === "SADD" && String(c[1]).startsWith("nl:team:of:")) found = String(c[1]);
    return original(commands);
  }) as typeof redis.pipeline;
  try {
    await work();
  } finally {
    redis.pipeline = original;
  }
  if (!found) throw new Error("no index written");
  return found;
}

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "move-owner@example.com";
  await claimHandle(OWNER, "moveteam", "Move Team", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_MoveTeam0001", subscriptionId: "sub_MoveTeam0001", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const sid = store.sid!;
  const emails = async () => (await readTeam(sid)).members.map((m) => m.email);
  const indexed = (key: string) => redis.run(["SISMEMBER", key, sid]);

  part("An index of their stores that does not read whole: nothing is deleted");
  const a = "move-a@example.com";
  const aIndex = await indexOf(() => putMember(store, a, "support"));
  const thrown = await answering("SMEMBERS", (k) => k === aIndex, ["QUEUED"], () => moveMemberships(a, "move-a-new@example.com").then(() => null, (e: unknown) => e));
  is("the move of their teams stops with an unknown read", thrown instanceof UnknownReplyError, true);
  is("their old address keeps its index", indexed(aIndex), 1);
  is("and the team still names them", (await emails()).includes(a), true);
  const notList = await answering("SMEMBERS", (k) => k === aIndex, "OK", () => moveMemberships(a, "move-a-new@example.com").then(() => null, (e: unknown) => e));
  is("an answer that is not a list stops it too, the index kept", [notList instanceof UnknownReplyError, indexed(aIndex)], [true, 1]);

  part("A store whose record does not read: kept on the old index");
  const b = "move-b@example.com";
  const bIndex = await indexOf(() => putMember(store, b, "support"));
  await answering("GET", (k) => k === `nl:store:id:${sid}`, ["not", "text"], () => moveMemberships(b, "move-b-new@example.com"));
  is("their old address keeps the store in its index", indexed(bIndex), 1);
  is("and the team still names them", (await emails()).includes(b), true);
  is("so the store is still theirs to open", (await memberStores(b)).map((m) => m.store.sid), [sid]);

  part("What reads is moved as before");
  const c = "move-c@example.com";
  const cNew = "move-c-new@example.com";
  const cIndex = await indexOf(() => putMember(store, c, "support"));
  await moveMemberships(c, cNew);
  is("the team names the new address", [(await emails()).includes(c), (await emails()).includes(cNew)], [false, true]);
  is("the old index is gone, the new one has the store", [redis.run(["EXISTS", cIndex]), (await memberStores(cNew)).map((m) => m.store.sid)], [0, [sid]]);

  const d = "move-d@example.com";
  const dIndex = await indexOf(() => putMember(store, d, "support"));
  await answering("GET", (k) => k === `nl:store:id:${sid}`, null, () => moveMemberships(d, "move-d-new@example.com"));
  is("a store whose record is confirmed gone is dropped from the old index", redis.run(["EXISTS", dIndex]), 0);

  done();
}

void main();
