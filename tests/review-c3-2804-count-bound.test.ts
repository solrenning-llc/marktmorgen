/**
 * Claude 3's review of #2804 (f3517cc5): a DEL reply larger than the distinct
 * keys it was sent cannot be a real receipt, yet it is returned as the count
 * of marks deleted.
 */
import { forgetFinishPerson } from "@/lib/course-finish";
import { emailKey } from "@/lib/learn";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const EMAIL = "c3-review-2804@example.com";
const COURSES = ["course_event_a", "course_event_b"];
const learner = emailKey(EMAIL);
const keys = COURSES.flatMap((c) => [`nl:course:${c}:fin:${learner}`, `nl:course:${c}:open:${learner}`]);

async function main(): Promise<void> {
  const original = redis.pipeline.bind(redis);
  part("A DEL count above the distinct keys sent is not a receipt");
  for (const reply of [5, 99, Number.MAX_SAFE_INTEGER]) {
    redis.clear();
    for (const k of keys) redis.run(["SET", k, "1"]);
    redis.pipeline = (async (commands) => (commands.length === 1 && commands[0]?.[0] === "DEL" ? [reply] : original(commands))) as typeof redis.pipeline;
    let refused = false;
    let returned: number | null = null;
    try {
      returned = await forgetFinishPerson(COURSES, EMAIL);
    } catch {
      refused = true;
    } finally {
      redis.pipeline = original;
    }
    is(`DEL answered ${reply} for ${keys.length} keys: refused as unknown, not reported as ${reply} deleted`, [refused, returned], [true, null]);
  }
  part("Controls");
  redis.clear();
  for (const k of keys) redis.run(["SET", k, "1"]);
  is("the exact four are deleted and counted", await forgetFinishPerson(COURSES, EMAIL), 4);
  redis.clear();
  for (const k of keys) redis.run(["SET", k, "1"]);
  is("the same course named twice still counts its distinct marks", await forgetFinishPerson([...COURSES, COURSES[0]], EMAIL), 4);
  done();
}
void main().catch((e) => { console.error(e); process.exit(1); });
