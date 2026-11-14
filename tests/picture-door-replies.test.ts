/**
 * The picture door and a sales page's claim read Redis only in the exact shape
 * of each reply (CX-123, rule 24; Revisor 1's review of #2657, 5 November 2026).
 *
 *   - takePictureDoor takes a note only when ZREM answered the whole number 1
 *     and ZSCORE a score (a number, or a numeric string as the REST API sends
 *     it); a ZREM of 0 and a ZSCORE of null are real answers (nothing taken).
 *     Any other answer (true, "1", [1], 2, an object, a word) throws, so its
 *     caller refuses before it writes; it is never read as "taken".
 *   - claimNewPictures refuses when an owner read by HMGET is neither a name
 *     nor null, instead of taking the picture for one nobody owns, and then
 *     leaves the picture's note on the door.
 */
import { notePictureDoor, takePictureDoor } from "@/lib/picture-door";
import { claimNewPictures } from "@/lib/sales-page-store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const FOLDER = "0123456789abcdef01234567";
const DOORS = `nl:pictures:doors:${FOLDER}`;
const picture = (name: string) => `images/${FOLDER}/${name}.jpg`;

type Bend = { command: string; reply: unknown } | null;
let bend: Bend = null;
const realPipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const replies = await realPipeline(commands);
  if (!bend) return replies;
  const { command, reply } = bend;
  return replies.map((answer, i) => (commands[i][0] === command ? reply : answer));
}) as typeof redis.pipeline;

async function take(path: string, as: Bend): Promise<string> {
  bend = as;
  try {
    const taken = await takePictureDoor([path]);
    return taken.has(path) ? "taken" : "not taken";
  } catch {
    return "throws";
  } finally {
    bend = null;
  }
}

const noted = (path: string) => redis.run(["ZSCORE", DOORS, path]) !== null;

async function main(): Promise<void> {
  redis.clear();

  part("A note is taken only on the exact answers");
  const first = picture("first");
  await notePictureDoor(first);
  is("ZSCORE a number and ZREM 1, as Redis answers: taken", await take(first, null), "taken");
  const second = picture("second");
  await notePictureDoor(second);
  is("ZSCORE as a numeric string, as the REST API may answer: taken", await take(second, { command: "ZSCORE", reply: String(Date.now()) }), "taken");
  const missing = picture("missing");
  is("a name never noted (ZSCORE null, ZREM 0): not taken, no throw", await take(missing, null), "not taken");

  part("Any other ZREM answer is unknown: it throws, never taken");
  for (const [label, reply] of [["true", true], ['"1"', "1"], ["[1]", [1]], ["2", 2], ["-1", -1], ["null", null]] as const) {
    // One name per answer: "1", [1] and -1 all read "zrem-1" without the index, and a taken name is never noted again
    // (lib/picture-door.ts, takenKey).
    const path = picture(`zrem-${label.replace(/\W/g, "")}-${label.length}${typeof reply}`);
    await notePictureDoor(path);
    is(`ZREM answers ${label}: throws`, await take(path, { command: "ZREM", reply }), "throws");
  }

  part("Any other ZSCORE answer is unknown: it throws");
  for (const [label, reply] of [["an object", { score: 1 }], ["a list", [1]], ["a word", "soon"], ["true", true]] as const) {
    const path = picture(`zscore-${label.replace(/\W/g, "")}`);
    await notePictureDoor(path);
    is(`ZSCORE answers ${label}: throws`, await take(path, { command: "ZSCORE", reply }), "throws");
  }

  part("A page claim refuses an owner read in an unknown shape");
  const statsId = "s".repeat(24);
  const pageId = "p".repeat(12);
  const owned = picture("owned");
  await notePictureDoor(owned);
  bend = { command: "HMGET", reply: [5] };
  const refused = await claimNewPictures(statsId, pageId, [owned]).catch(() => "throws");
  bend = null;
  // Since Claude 4's LEVE 2 on #2156, an owner read in an unknown shape throws (server_error) instead of returning false.
  is("HMGET answers [5] for the owner: the claim is refused, as unknown (it throws)", refused, "throws");
  is("and the picture's note stays on the door", noted(owned), true);
  is("the owner read as null (nobody's): claimed", await claimNewPictures(statsId, pageId, [owned]), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
