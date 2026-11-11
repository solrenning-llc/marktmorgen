/**
 * Who gets the weekly email too (lib/stats-report.ts, weeklyTeam) is read exactly (CX-123 rule 24, rule 30).
 * Found by Claude 3 (cloud D)'s audit of main (11 November 2026): a reply of another shape read as "nobody chosen".
 * The studio's picker (components/weekly-team-picker.tsx) then showed every box unticked as if real, and the first
 * box the creator ticked saved a list of one (setWeeklyTeam replaces the whole set), so everyone else chosen
 * stopped getting the email without anybody choosing that.
 *
 * Now weeklyTeam throws UnknownReplyError on such a reply, and the studio does not draw the picker over a list it
 * could not read (the same as when there is no team), so no click can replace it. Synthetic only.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { store as redis } from "./redis-stub";
import { setWeeklyTeam, weeklyTeam } from "@/lib/stats-report";
import { UnknownReplyError } from "@/lib/redis-reply";

const real = redis.pipeline.bind(redis);
let odd: { reply: unknown } | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  const replies = (await real(commands)) as unknown[];
  if (!odd || !commands.some((c) => c[0] === "SMEMBERS")) return replies;
  if (odd.reply === "LOST") return [];
  return commands.map((c, i) => (c[0] === "SMEMBERS" ? odd!.reply : replies[i]));
}) as typeof redis.pipeline;

beforeEach(() => {
  redis.clear();
  odd = null;
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
});

for (const reply of ["LOST", "a@example.com", 3, null, { a: 1 }, [1, 2]]) {
  test(`the weekly team read ${JSON.stringify(reply)} is unknown, never nobody chosen`, async () => {
    await setWeeklyTeam("weeklyexact", ["a@example.com", "b@example.com"]);
    odd = { reply };
    await assert.rejects(weeklyTeam("weeklyexact"), (e) => e instanceof UnknownReplyError);
  });
}

test("readable replies: the chosen members, sorted; none chosen is an empty list", async () => {
  assert.deepEqual(await weeklyTeam("weeklyexact"), []);
  await setWeeklyTeam("weeklyexact", ["b@example.com", "a@example.com"]);
  assert.deepEqual(await weeklyTeam("weeklyexact"), ["a@example.com", "b@example.com"]);
});

test("the studio never draws the picker over a team list it could not read", () => {
  const page = readFileSync("app/studio/page.tsx", "utf8");
  assert.equal(/weeklyTeam\(store\.handle\)\.catch\(\(\) => \[\]\)/.test(page), false, "an unread list must not become []");
  assert.equal(/chosen: \(await chosen\) \?\? \[\]/.test(page), false, "an unread list must not be drawn as nobody chosen");
});
