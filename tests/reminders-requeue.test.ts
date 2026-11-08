/**
 * A reminder the buyer asked for (lib/checkout-ask.ts) and the Store
 * assistant's checkout reminder (lib/assistant-reminder.ts) are taken off
 * their queue before anything is sent, so two runs never send the same one.
 * One whose send failed for a reason that may pass (a store that could not
 * be read, an error on the way) is put back once with a wait, a few times at
 * the most and only while it is still worth sending; a decision (another
 * store, too late) still drops it. The send itself stays once only: the same
 * name for each (askKey, the checkout), so a retry is never a second email.
 * The welcome offer's retry, at its own hour so an erasure still finds it,
 * is held in tests/welcome-offer.test.ts; the assistant's retry without a
 * second model call in tests/assistant-reminder.test.ts.
 */
import { askKey, askMember, parseAsk, sendAsked } from "@/lib/checkout-ask";
import { sendAssistReminders } from "@/lib/assistant-reminder";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ASKS = "nl:recover:asks";
const ASSIST = "nl:assist:remindq";
const SIX_HOURS = 6 * 3600;

/** A store loader that fails, as a Redis or network error would. */
const broken = async (): Promise<Store | null> => {
  throw new Error("synthetic: the store could not be read just now");
};
/** A store loader that finds another store now at the handle: a decision, never retried. */
const another = async (): Promise<Store | null> => ({ statsId: "stats-other", handle: "harbor" }) as unknown as Store;

async function queued(key: string): Promise<{ member: string; score: number }[]> {
  const [flat] = await redis.pipeline([["ZRANGEBYSCORE", key, "-inf", "+inf", "WITHSCORES"]]);
  const list = (flat as string[]) ?? [];
  const out: { member: string; score: number }[] = [];
  for (let i = 0; i + 1 < list.length; i += 2) out.push({ member: list[i], score: Number(list[i + 1]) });
  return out;
}

async function main(): Promise<void> {
  const realNow = Date.now;
  const now = Math.floor(realNow() / 1000);
  const ask = { statsId: "stats1", handle: "harbor", productId: "plan", email: "ana@example.com", askedAt: now - 3_700, from: "checkout" as const, after: 3_600 };

  part("An ask keeps how many times it was tried, and nothing else changes");
  is("tried twice, read back the same", parseAsk(askMember({ ...ask, tries: 2 })), { ...ask, tries: 2 });
  is("an ask never tried reads as it always did", parseAsk(askMember(ask)), ask);
  is("the same name however many times it was tried, so it is never sent twice", askKey({ ...ask, tries: 3 } as typeof ask), askKey(ask));

  part("A buyer's own ask: a passing error puts it back once, five minutes later");
  redis.clear();
  await redis.pipeline([["ZADD", ASKS, ask.askedAt + ask.after, askMember(ask)]]);
  await sendAsked(broken, realNow() + 10_000);
  const back = await queued(ASKS);
  is("back in the queue, once", back.length, 1);
  is("tried once, with the same name", [parseAsk(back[0]?.member)?.tries, back[0] ? askKey(parseAsk(back[0].member)!) : null], [1, askKey(ask)]);
  is("due again in about five minutes, not at once", back[0] ? back[0].score >= now + 300 && back[0].score <= now + 310 : false, true);

  part("A buyer's own ask: tried a few times at the most");
  redis.clear();
  await redis.pipeline([["ZADD", ASKS, ask.askedAt + ask.after, askMember(ask)]]);
  const tries: (number | null)[] = [];
  for (let run = 0; run < 5; run += 1) {
    Date.now = () => realNow() + run * 3_600_000;
    await sendAsked(broken, Date.now() + 10_000);
    const left = await queued(ASKS);
    tries.push(left.length ? (parseAsk(left[0].member)?.tries ?? null) : null);
  }
  Date.now = realNow;
  is("tried again three times, then dropped", tries, [1, 2, 3, null, null]);

  part("A buyer's own ask: a decision still drops it");
  redis.clear();
  await redis.pipeline([["ZADD", ASKS, ask.askedAt + ask.after, askMember(ask)]]);
  await sendAsked(another, realNow() + 10_000);
  is("another store at the handle now: not put back", (await queued(ASKS)).length, 0);
  const stale = { ...ask, askedAt: now - SIX_HOURS - 3_600 - 60 };
  await redis.pipeline([["ZADD", ASKS, stale.askedAt + stale.after, askMember(stale)]]);
  await sendAsked(broken, realNow() + 10_000);
  is("too late to be worth sending: not put back", (await queued(ASKS)).length, 0);
  const edge = { ...ask, askedAt: now - SIX_HOURS - 3_600 + 100 };
  await redis.pipeline([["ZADD", ASKS, edge.askedAt + edge.after, askMember(edge)]]);
  await sendAsked(broken, realNow() + 10_000);
  is("a retry that would land past its six hours: not put back", (await queued(ASKS)).length, 0);
  const spent = { ...ask, tries: 3 };
  await redis.pipeline([["ZADD", ASKS, spent.askedAt + spent.after, askMember(spent)]]);
  await sendAsked(broken, realNow() + 10_000);
  is("already tried three times: not put back", (await queued(ASKS)).length, 0);

  const session = "cs_test_requeue0000000001";
  const due = now - 60;
  const member = JSON.stringify(["stats1", "harbor", session, due]);

  part("The Store assistant's reminder: a passing error puts it back once, five minutes later");
  redis.clear();
  await redis.pipeline([["ZADD", ASSIST, due, member]]);
  const first = await sendAssistReminders(broken, realNow() + 10_000);
  const again = await queued(ASSIST);
  is("not sent", first.sent, 0);
  is("back in the queue for the same checkout and hour, tried once", again.map((e) => JSON.parse(e.member)), [["stats1", "harbor", session, due, 1]]);
  is("due again in about five minutes, not at once", again[0] ? again[0].score >= now + 300 && again[0].score <= now + 310 : false, true);
  is("the queue still never holds an address", JSON.stringify(again).includes("@"), false);

  part("The Store assistant's reminder: tried a few times at the most");
  redis.clear();
  await redis.pipeline([["ZADD", ASSIST, due, member]]);
  const seen: (number | null)[] = [];
  for (let run = 0; run < 5; run += 1) {
    Date.now = () => realNow() + run * 3_600_000;
    await sendAssistReminders(broken, Date.now() + 10_000);
    const left = await queued(ASSIST);
    seen.push(left.length ? ((JSON.parse(left[0].member) as unknown[])[4] as number) : null);
  }
  Date.now = realNow;
  is("tried again three times, then dropped", seen, [1, 2, 3, null, null]);

  part("The Store assistant's reminder: a decision still drops it");
  redis.clear();
  await redis.pipeline([["ZADD", ASSIST, due, member]]);
  await sendAssistReminders(another, realNow() + 10_000);
  is("another store at the handle now: not put back", (await queued(ASSIST)).length, 0);
  const late = now - SIX_HOURS - 60;
  await redis.pipeline([["ZADD", ASSIST, late, JSON.stringify(["stats1", "harbor", session, late])]]);
  await sendAssistReminders(broken, realNow() + 10_000);
  is("too late to be worth sending: not put back", (await queued(ASSIST)).length, 0);
  const near = now - SIX_HOURS + 100;
  await redis.pipeline([["ZADD", ASSIST, near, JSON.stringify(["stats1", "harbor", session, near])]]);
  await sendAssistReminders(broken, realNow() + 10_000);
  is("a retry that would land past its six hours: not put back", (await queued(ASSIST)).length, 0);
  await redis.pipeline([["ZADD", ASSIST, due, JSON.stringify(["stats1", "harbor", session, due, 3])]]);
  await sendAssistReminders(broken, realNow() + 10_000);
  is("already tried three times: not put back", (await queued(ASSIST)).length, 0);
  await redis.pipeline([["ZADD", ASSIST, due, JSON.stringify(["stats1", "harbor", session, due, "x"])]]);
  await sendAssistReminders(broken, realNow() + 10_000);
  is("a count of tries of no known shape: not put back", (await queued(ASSIST)).length, 0);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
