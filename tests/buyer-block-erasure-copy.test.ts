/**
 * Codex X6's two LOWs on #3839 (7059424256), answered the way the code already treats another person's protection
 * (lib/community-dm.ts: a member's choice to decline messages is kept on erasure, as a one-way key):
 *
 *   1. Deleting the person (lib/person-erasure.ts) erases the creator's reason, never the block: the one-way mark of
 *      the address stays, so the person cannot write again by asking to be deleted. The creator still lifts it.
 *   2. The person's copy of their data (lib/person-copy.ts) holds the block with the reason the creator wrote and when:
 *      a note about a person is that person's data (GDPR art. 15).
 *
 * Synthetic store, in-memory Redis.
 */
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { FORGET_REASON_LUA, blockKey, blockPerson, blockedState, forgetBlockedPerson, mayWrite, personMark, unblockPerson } from "@/lib/buyer-block";
import { COPIERS, COPY_PLAN } from "@/lib/person-copy";
import { PERSON_DATA } from "@/lib/person-data";
import type { ErasureScope } from "@/lib/erasure-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "block-erase@example.com";
const RUDE = "rude-erase@example.com";
const REASON = "sent the same insult three times";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "blockerase", "Block Erase", "");
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const scope = { store, sid: store.sid!, statsId: store.statsId!, email: RUDE } as unknown as ErasureScope;

  part("The person's copy holds the block, the creator's reason and when");
  is("blocked with a reason", await blockPerson(store, RUDE, REASON, 1_790_000_000_000), "blocked");
  is("the plan says it is copied", COPY_PLAN["lib/buyer-block.ts"]?.how, "copied");
  is("the copy", await COPIERS["lib/buyer-block.ts"]?.(scope), [{ blocked: new Date(1_790_000_000_000).toISOString(), reason: REASON }]);
  is("nobody else's block is in it", await COPIERS["lib/buyer-block.ts"]?.({ ...scope, email: "kind-erase@example.com" } as ErasureScope), []);

  part("Deleting the person erases the reason and keeps the block");
  is("one reason erased", await forgetBlockedPerson(store, RUDE), 1);
  const after = await blockedState(store, RUDE);
  // The block's own date stays: the copy says since when the store blocked them, never when they were deleted
  // (Claude 6's LEVE on #3839).
  is("still blocked, with no reason and its own date", after, { blocked: true, reason: "", at: 1_790_000_000_000 });
  is("the copy after the deletion says since when, with no reason", await COPIERS["lib/buyer-block.ts"]?.(scope), [{ blocked: new Date(1_790_000_000_000).toISOString(), reason: "" }]);
  is("still may not write", await mayWrite(store, RUDE), false);
  const raw = String((await redis.pipeline([["HGET", blockKey(store.sid!), personMark(RUDE)!]]))[0]);
  is("the reason's words are gone from the database", raw.includes("insult"), false);
  is("a second deletion has nothing left to erase", await forgetBlockedPerson(store, RUDE), 0);
  is("the creator can still lift it", [await unblockPerson(store, RUDE), await mayWrite(store, RUDE)], [true, true]);
  is("deleting someone never blocked writes nothing", [await forgetBlockedPerson(store, "never-erase@example.com"), await mayWrite(store, "never-erase@example.com")], [0, true]);

  part("An entry that changed after it was read is never written over");
  {
    await blockPerson(store, RUDE, "a new note, written after the deletion was asked", 1_790_000_200_000);
    const mark = personMark(RUDE)!;
    const [kept] = await redis.pipeline([["HGET", blockKey(store.sid!), mark]]);
    const [written] = await redis.pipeline([["EVAL", FORGET_REASON_LUA, 1, blockKey(store.sid!), mark, JSON.stringify({ r: "", at: 1 }), "an entry read before"]]);
    const [after] = await redis.pipeline([["HGET", blockKey(store.sid!), mark]]);
    is("nothing written, the entry as it is", [written, after], [0, kept]);
  }

  part("What the store's privacy page says");
  const lines = PERSON_DATA.filter((d) => d.file === "lib/buyer-block.ts").map((d) => d.how).sort();
  is("the reason erased, the mark kept", lines, ["erased", "kept"]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
