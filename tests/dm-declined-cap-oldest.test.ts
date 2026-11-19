/**
 * The declined-senders cap drops the oldest person, never one at random.
 *
 * lib/community-dm.ts decline() keeps at most MAX_DECLINED people a member
 * has declined, and its comment says "Dropping the oldest is the right way
 * round". It drops with SPOP, which removes a RANDOM member of the set. So
 * once the cap is reached, declining one more person may let anybody back in,
 * including the harasser declined a moment ago, while the oldest stays.
 *
 * The in-memory stand-in (lib/redis-memory.ts) answers SPOP with the first
 * member inserted, which hides this. Real Redis answers any member; this test
 * makes SPOP answer the newest one, an outcome real Redis can and will give
 * (500 times in 501). Then the cap is filled and one more person is declined
 * (the 501st): exactly the oldest must be let back in; every other, above all
 * the newest, must still be refused.
 */
import { MAX_DECLINED, decline, parseDmSetting, send } from "@/lib/community-dm";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const hex = (n: number) => n.toString(16).padStart(16, "0");

async function main() {
  redis.clear();
  const original = redis.pipeline.bind(redis);
  // Real Redis SPOP: "removes and returns one or more RANDOM members". Pick the newest, a legal answer.
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 1 && commands[0][0] === "SPOP") {
      const key = String(commands[0][1]);
      const [members] = (await original([["SMEMBERS", key]])) as [string[]];
      const pick = members[members.length - 1];
      if (pick === undefined) return [null];
      await original([["SREM", key, pick]]);
      return [pick];
    }
    return original(commands);
  }) as typeof redis.pipeline;
  const id = "cmhuntdecl01";
  const setting = parseDmSetting({ on: true, between: true, ask: true });
  const me = "f".repeat(16);
  const senders = Array.from({ length: MAX_DECLINED + 1 }, (_, i) => hex(i + 1));
  for (const s of senders) {
    const sent = await send(id, setting, s, me, "hello", ROOM);
    if (!sent.ok) throw new Error(`setup send failed: ${JSON.stringify(sent)}`);
    const { pairOf } = await import("@/lib/community-dm");
    if (!(await decline(id, me, pairOf(s, me), ROOM))) throw new Error("setup decline failed");
  }

  part("Past the cap, the oldest decline is the one that goes");
  const oldest = senders[0];
  const newest = senders[senders.length - 1];
  is("the newest declined person is still refused", await send(id, setting, newest, me, "again", ROOM), { ok: false, reason: "declined" });
  const stillRefused: string[] = [];
  for (const s of senders.slice(1)) {
    const r = await send(id, setting, s, me, "again", ROOM);
    if (!r.ok && r.reason === "declined") stillRefused.push(s);
  }
  is("every decline but the oldest still holds", stillRefused.length, MAX_DECLINED);
  is("the oldest is the one let back in", await send(id, setting, oldest, me, "again", ROOM), { ok: true, asked: true });
  done();
}
void main();
