/**
 * A moved member's stop link is written only while its erasure note is still there (#5010 row 103, issue #5203;
 * Codex G, G-20261119-0934-defect-move-stop-erasure-race-fix). moveStopLink notes the link for erasure first and wrote
 * the grant, which holds the member's address, in a separate SET afterwards; an erasure of that address finishing in
 * between (forgetNoted) took the note away and the late SET put the grant back for 400 days with no note left, so no
 * later erasure could find it. Synthetic only: Redis is lib/redis-memory.ts, the address is made up.
 */
import { moveStopLink } from "@/lib/checkout-recovery";
import { forgetNoted } from "@/lib/erasure-index";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "c".repeat(32);
const store = { statsId: STATS, handle: "race-shop", name: "Race Shop" } as unknown as Store;
const member = "moved-member@example.test";

/** Runs moveStopLink with `between` run right after the pipeline that writes the erasure notes. */
async function withBetween(between: () => Promise<void>): Promise<{ threw: boolean; error: string; sent: (string | number)[][] }> {
  const original = redis.pipeline.bind(redis);
  const sent: (string | number)[][] = [];
  let noted = false;
  redis.pipeline = async (batch: (string | number)[][]) => {
    sent.push(...batch);
    const replies = await original(batch);
    if (!noted && batch.some((c) => c[0] === "ZADD" && String(c[1]).startsWith("nl:erase:ix:"))) {
      noted = true;
      redis.pipeline = original;
      await between();
      redis.pipeline = async (next: (string | number)[][]) => {
        sent.push(...next);
        return original(next);
      };
    }
    return replies;
  };
  try {
    await moveStopLink(store, member);
    return { threw: false, error: "", sent };
  } catch (error) {
    return { threw: true, error: String((error as Error)?.message ?? error), sent };
  } finally {
    redis.pipeline = original;
  }
}

/** Every stop-link grant kept, read the way Redis lists keys. */
const linkKeys = () => (redis.run(["SCAN", 0, "MATCH", "nl:recover:link:*", "COUNT", 10_000]) as [string, string[]])[1];

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_move_stop_race_only_a_stand_in";

  part("An erasure of the address that finishes between the note and the link leaves no link behind");
  {
    redis.clear();
    const got = await withBetween(async () => {
      await forgetNoted(STATS, member);
    });
    is("the link is refused: nothing is sent with it", got.threw, true);
    is("and no grant holding the address is written", linkKeys(), []);
    is("the write is one step that checks the note (no plain SET of the grant)", got.sent.some((c) => c[0] === "SET" && String(c[1]).startsWith("nl:recover:link:")), false);
  }

  part("Control: with no erasure in between, the link is written and noted");
  {
    redis.clear();
    const got = await withBetween(async () => {});
    is("the link is given", got.threw, false, got.error);
    is("one grant is written", linkKeys().length, 1);
    is("and the erasure that comes later finds it and deletes it", [await forgetNoted(STATS, member), linkKeys()], [1, []]);
  }
}

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
