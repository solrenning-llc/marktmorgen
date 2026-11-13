/**
 * A point is given only to someone still in the community (Claude 7, 13 November 2026). Synthetic only: the in-memory
 * Redis, through the real lib/community-points.ts award and lib/community-erasure.ts forgetCommunityPerson.
 *
 * A like on a post or comment gives its author a point (app/api/store/community/route.ts). award gave it to any member
 * key: after a member was erased, a like on one of their posts (which are kept) wrote their points and their place on
 * the board again under their key; a removed member kept climbing the board too.
 */
import { claimHandle, setCommunity, setStripeAccount } from "@/lib/store";
import { memberKey, touchMember } from "@/lib/community";
import { award, board, pointsOf } from "@/lib/community-points";
import { forgetCommunityPerson } from "@/lib/community-erasure";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();
  if (!(await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "")).ok) throw new Error("no store");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  const id = (await setCommunity("owner@example.com", true))?.community?.id;
  if (!id) throw new Error("no community");
  const room = { sid: "points-gone" };
  const onBoard = async (key: string) => (await board(id, "all", null)).top.some((s) => s.key === key);

  part("Control: a member in the community earns a point");
  const ben = memberKey("ben@example.com");
  await touchMember(id, "ben@example.com", null, room);
  await award(id, ben, 1, room);
  is("one point", (await pointsOf(id, [ben])).get(ben), 1);
  is("and on the board", await onBoard(ben), true);

  part("An erased member earns nothing back from a like on a post they left");
  const ana = memberKey("ana@example.com");
  await touchMember(id, "ana@example.com", null, room);
  await award(id, ana, 1, room);
  await forgetCommunityPerson(id, ana, "ana@example.com", []);
  is("erased: no points", (await pointsOf(id, [ana])).get(ana), 0);
  await award(id, ana, 1, room);
  is("a like on their old post gives them no point", (await pointsOf(id, [ana])).get(ana), 0);
  is("and does not put them back on the board", await onBoard(ana), false);

  part("A removed member earns nothing more");
  const cy = memberKey("cy@example.com");
  await touchMember(id, "cy@example.com", null, room);
  await award(id, cy, 1, room);
  // As moderateMember writes it: the member's record, marked removed (its script is not in the in-memory Redis).
  const record = JSON.parse(String(redis.run(["HGET", `nl:cm:${id}:m`, cy]))) as Record<string, unknown>;
  redis.run(["HSET", `nl:cm:${id}:m`, cy, JSON.stringify({ ...record, removed: true })]);
  await award(id, cy, 1, room);
  is("their points stay where they were", (await pointsOf(id, [cy])).get(cy), 1);

  done();
}

void main();
