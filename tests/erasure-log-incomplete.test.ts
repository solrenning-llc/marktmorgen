/**
 * The team's activity log never says a person was fully deleted when part of the erasure failed (#4333; Codex L,
 * transcribed by Claude 1).
 *
 * erasePerson (lib/person-erasure.ts) wrote "People: deleted a person and everything kept about them (N records)"
 * into the store's activity log for every team erasure, before it looked at what failed. The teammate who pressed
 * delete got `incomplete` at once, but the log, read later by the owner and the team, said it was complete, so
 * nobody reading it would know records remain and a retry is owed.
 *
 * Now an erasure with a part that could not finish logs that it is incomplete, with the parts still to retry; the
 * completion wording is kept for one that finished. The person's address stays out of the log either way.
 *
 * Synthetic store, in-memory Redis, one reply made to fail where the test says so. Nothing real is reached.
 */
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { erasePerson } from "@/lib/person-erasure";
import { readLog } from "@/lib/team";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
/** While set, the inbox eraser's read of its index (ZREVRANGE) fails, as a Redis timeout would. */
let failInbox = false;
redis.pipeline = (async (commands: Command[]) => {
  if (failInbox && commands.some((c) => c[0] === "ZREVRANGE" && /^nl:inbox:[^:]+:all$/.test(String(c[1] ?? "")))) throw new Error("synthetic: Redis request timed out");
  return real(commands);
}) as typeof redis.pipeline;

const quietly = async <T>(body: () => Promise<T>): Promise<T> => {
  const log = console.error;
  console.error = () => {};
  try {
    return await body();
  } finally {
    console.error = log;
  }
};

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "eraselog@example.com";
  const ERASED = "pat@example.com";
  await claimHandle(OWNER, "eraselog", "Erase Log", "");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  const now = Math.floor(Date.now() / 1000);
  await setSubscription(OWNER, { customerId: "cus_EraseLog0001", subscriptionId: "sub_EraseLog0001", active: true, tier: "pro", period: { start: now - 10 * 86_400, end: now + 20 * 86_400, renews: true } });
  const store = (await storeForEmail(OWNER))!;
  const by = { kind: "team" as const, who: OWNER, role: "owner" as const };
  const lastLine = async () => (await readLog(store.sid!))?.[0]?.what ?? "";

  part("A part that could not finish: the log says the deletion is not complete");
  failInbox = true;
  const failed = await quietly(() => erasePerson(store, ERASED, by));
  failInbox = false;
  is("the teammate is told it is incomplete", failed.ok ? "ok" : failed.reason, "incomplete");
  const line = await lastLine();
  is("the log never says everything kept was deleted", line.includes("everything kept about them"), false);
  is("it says the deletion is not complete", /not complete/i.test(line), true);
  is("and names the part still to retry", line.includes("lib/inbox.ts"), true);
  is("the person's address stays out of the log", line.includes(ERASED), false);

  part("Control: an erasure that finished keeps the completion wording");
  const whole = await erasePerson(store, ERASED, by);
  is("it finished", whole.ok, true);
  const after = await lastLine();
  is("the log says everything kept was deleted", after.includes("everything kept about them"), true);
  is("the person's address stays out of the log", after.includes(ERASED), false);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
