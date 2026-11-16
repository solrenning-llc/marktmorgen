/**
 * Claude 6's review of #3461 (5831329612, MEDIUM 2 and 3, corroborated by Codex L 6758703456 and Codex G 6778372918),
 * against the real lib/assignment.ts and the in-memory Redis:
 *
 *   - M2: a second door for a name already listed moved its time on (ZADD without NX), so doors asked again and again
 *     kept an unused file out of the sweep for good; a listed name keeps the time it was first listed at;
 *   - M3: taking a file from the doors read the ZREM's answer loosely: a lost answer after it ran ("null") was "not
 *     taken", and the hold was taken back, so the file was in neither list and never swept; "1", true or [1] were
 *     "taken". Only an exact 0 or 1 is known; anything else throws, and the hold stays for the sweep.
 */
import { listTaskDoor, takeTaskUpload } from "@/lib/assignment";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DOORS = "nl:tasks:doors";
const HELD = "nl:tasks:held";
const path = (n: number) => `stores/abc/tasks/course01/lesson01/${"a".repeat(16)}/file-${n}.pdf`;
const score = async (key: string, member: string) => (await redis.pipeline([["ZSCORE", key, member]]))[0];

async function main(): Promise<void> {
  redis.clear();
  const t0 = Date.UTC(2026, 10, 11, 8) as number;

  part("M2: a second door for a listed name keeps the time it was first listed at");
  is("listed anew", await listTaskDoor(path(1), t0), true);
  is("listed already, twenty hours on", await listTaskDoor(path(1), t0 + 20 * 3_600_000), false);
  is("and its time is not moved on, so the sweep still finds it a day after the first door", Number(await score(DOORS, path(1))), Math.floor(t0 / 1000));

  part("M3: a taking whose answer is not exactly 0 or 1 is not known: it throws, and the hold stays for the sweep");
  const real = redis.pipeline.bind(redis);
  for (const [what, bent] of [["a lost answer after it ran", null], ["the text \"1\"", "1"], ["true", true], ["[1]", [1]]] as const) {
    const p = path(10 + what.length);
    await real([["ZADD", DOORS, Math.floor(t0 / 1000), p]]);
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const replies = await real(commands);
      return commands.length === 1 && commands[0][0] === "ZREM" && commands[0][1] === DOORS ? [bent] : replies;
    }) as typeof redis.pipeline;
    let answer: unknown;
    try {
      answer = await takeTaskUpload(p, t0);
    } catch {
      answer = "throws";
    } finally {
      redis.pipeline = real;
    }
    is(`${what}: not known, never taken nor not taken`, answer, "throws");
    is(`${what}: the hold stays, so the sweep reads it a day on`, (await score(HELD, p)) !== null, true);
  }

  part("Controls: an exact 1 takes it, an exact 0 does not and takes its own hold back");
  await real([["ZADD", DOORS, Math.floor(t0 / 1000), path(2)]]);
  is("taken", await takeTaskUpload(path(2), t0), true);
  is("not listed: not taken", await takeTaskUpload(path(3), t0), false);
  is("and the hold it wrote is taken back", await score(HELD, path(3)), null);
  done();
}

void main();
