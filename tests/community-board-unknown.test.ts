/**
 * A lost reply of the members' records never brings a removed member back on the community leaderboard (Claude 1
 * cloud R's MÉDIO on #4546; its RED test, kept).
 *
 * readMembers turns a lost HMGET reply into an empty map, and boardShown kept every key it had no record for, so the
 * removed member came back on the board, unnamed, with their points. Now boardShown keeps only a member read as not
 * removed, and the page reads the records exactly.
 *
 * Synthetic: the in-memory Redis stand-in.
 */
import { claimHandle, setCommunity, setStripeAccount } from "@/lib/store";
import { memberKey, readMembers, touchMember } from "@/lib/community";
import { award, board, boardShown } from "@/lib/community-points";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();
  if (!(await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "")).ok) throw new Error("no store");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  const id = (await setCommunity("owner@example.com", true))?.community?.id;
  if (!id) throw new Error("no community");
  const room = { sid: "board-unknown" };
  const cy = memberKey("cy@example.com");
  await touchMember(id, "cy@example.com", null, room);
  await award(id, cy, 1, room);
  const record = JSON.parse(String(redis.run(["HGET", `nl:cm:${id}:m`, cy]))) as Record<string, unknown>;
  redis.run(["HSET", `nl:cm:${id}:m`, cy, JSON.stringify({ ...record, removed: true })]);

  part("Control: a readable record keeps the removed member off");
  const standing = await board(id, "all", null);
  is("removed member left out", boardShown(standing.top, await readMembers(id, standing.top.map((s) => s.key))).map((s) => s.key), []);

  part("A lost members reply never brings a removed member back");
  const real = redis.pipeline.bind(redis);
  (redis as unknown as { pipeline: (c: (string | number)[][]) => unknown }).pipeline = (commands) => (commands[0]?.[0] === "HMGET" ? Promise.resolve([null]) : real(commands));
  const members = await readMembers(id, standing.top.map((s) => s.key));
  (redis as unknown as { pipeline: unknown }).pipeline = real;
  is("removed member still left out", boardShown(standing.top, members).map((s) => s.key), []);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
