/**
 * 249 [ST2], unit 2: a store's learning paths, kept (lib/learning-paths.ts),
 * on the Redis stub with a synthetic store. The whole list is saved at once
 * or not at all; each path keeps its id across saves; its room is taken in
 * the store's data room before it is written; a list that does not read is
 * an error, never an empty list, and is never written over.
 */
import { MAX_PATHS, PathsUnreadable, readPaths, savePaths } from "@/lib/learning-paths";
import { parseStoredPaths, readPathsInput } from "@/lib/learning-path-rules";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

type Command = (string | number)[];
const NOW = 1_800_000_000_000;
const statsId = "0123456789abcdef0123456789abcdef";
const STORE = { ...ROOM, statsId };
const KEY = `nl:paths:${statsId}`;
const COURSES = new Set(["c1", "c2", "c3", "c4"]);
const real = redis.pipeline.bind(redis);
let seen: string[] = [];
let room: unknown[] | null = null;
let getReply: unknown[] | null = null;
let writeReply: unknown[] | null = null;
redis.pipeline = (async (batch: Command[]) => {
  for (const c of batch) seen.push(c[0] === "EVAL" ? String(c[1]).split("\n")[0] : `${c[0]} ${c[1]}`);
  if (room && batch.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:store-data:"))) return room;
  if (getReply && batch.some((c) => c[0] === "GET" && c[1] === KEY)) return getReply;
  if (writeReply && batch.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:fenced-set:"))) return writeReply;
  return real(batch);
}) as typeof redis.pipeline;

const two = (name: string, extra: Record<string, unknown> = {}) => ({ name, courses: ["c1", "c2"], order: "sequence", ...extra });

async function main(): Promise<void> {
  redis.clear();

  part("The pure rules: a whole list, all or nothing");
  is("a list reads", readPathsInput([two("Start"), { name: "More", courses: ["c3", "c4"], order: "free" }], [], COURSES).ok, true);
  const bad = readPathsInput([two("Start"), { name: "", courses: ["c1", "c2"], order: "free" }], [], COURSES);
  is("one bad path refuses the whole list, saying which", bad.ok ? null : [bad.problem, bad.index], ["name", 1]);
  const many = readPathsInput(Array.from({ length: MAX_PATHS + 1 }, (_, i) => two(`P${i}`)), [], COURSES);
  is("more than MAX_PATHS is refused", many.ok ? null : many.problem, "too_many");
  is("not a list is refused", readPathsInput({ name: "x" }, [], COURSES).ok, false);
  is("stored paths that read", parseStoredPaths(JSON.stringify([{ id: "abcd2345", name: "A", courses: ["c1", "c2"], order: "free" }]))?.length, 1);
  is("a stored list with one path that does not read is not read at all", parseStoredPaths(JSON.stringify([{ id: "abcd2345", name: "A", courses: ["c1"], order: "free" }])), null);
  is("a stored list that is not JSON is not read", parseStoredPaths("{"), null);
  is("a stored list with the same id twice is not read", parseStoredPaths(JSON.stringify([
    { id: "abcd2345", name: "A", courses: ["c1", "c2"], order: "free" },
    { id: "abcd2345", name: "B", courses: ["c3", "c4"], order: "free" },
  ])), null);

  part("Kept and read back");
  is("no paths yet: an empty list", await readPaths(statsId), []);
  seen = [];
  const saved = await savePaths(STORE, [two("Start here"), { name: "Go further", courses: ["c3", "c4", "c1"], order: "free" }], COURSES, NOW);
  is("saved", saved.state, "saved");
  const ids = saved.state === "saved" ? saved.paths.map((p) => p.id) : [];
  is("each path is given its own id", ids.every((id) => /^[a-z0-9]{8}$/.test(id)) && new Set(ids).size === 2, true);
  is("read back as saved", (await readPaths(statsId)).map((p) => [p.name, p.courses, p.order]), [["Start here", ["c1", "c2"], "sequence"], ["Go further", ["c3", "c4", "c1"], "free"]]);
  const takeAt = seen.findIndex((s) => s.startsWith("-- marktmorgen:store-data:"));
  const writeAt = seen.findIndex((s) => s.startsWith("-- marktmorgen:fenced-set:"));
  is("the room is taken before the list is written", takeAt >= 0 && writeAt > takeAt, true);

  part("An id is kept across saves; a new path never takes an old id");
  const again = await savePaths(STORE, [{ id: ids[1], name: "Go further", courses: ["c3", "c4"], order: "free" }, { id: "zzzz9999", name: "New one", courses: ["c2", "c4"], order: "sequence" }], COURSES, NOW + 1);
  const kept = again.state === "saved" ? again.paths.map((p) => p.id) : [];
  is("the kept path keeps its id; an id the store does not have is not taken", [kept[0], kept[1] !== "zzzz9999", ids.includes(kept[1])], [ids[1], true, false]);

  part("Refused as a whole: nothing written");
  const before = await redis.pipeline([["GET", KEY]]);
  const refused = await savePaths(STORE, [two("Fine"), { name: "Bad", courses: ["c1", "nope"], order: "free" }], COURSES, NOW + 2);
  is("a course the store does not have refuses the list", refused.state === "refused" ? [refused.problem, refused.index] : refused.state, ["courses", 1]);
  is("nothing written", await redis.pipeline([["GET", KEY]]), before);

  part("A full room refuses, and nothing is written");
  room = [[0, 999]];
  is("full", (await savePaths(STORE, [two("Only")], COURSES, NOW + 3)).state, "full");
  room = null;
  is("still the list before", await redis.pipeline([["GET", KEY]]), before);

  part("Unknown is never an empty list, and never written over (rule 24)");
  getReply = [];
  let threw: unknown = null;
  await readPaths(statsId).catch((e) => {
    threw = e;
  });
  is("a read with no answer is an error", threw instanceof PathsUnreadable, true);
  is("a save over a list that could not be read is unknown", (await savePaths(STORE, [two("X")], COURSES, NOW + 4)).state, "unknown");
  getReply = [7];
  is("a read that is not text or null is unknown", (await savePaths(STORE, [two("X")], COURSES, NOW + 4)).state, "unknown");
  getReply = null;
  is("still the list before", await redis.pipeline([["GET", KEY]]), before);
  await real([["SET", KEY, "{broken"]]);
  threw = null;
  await readPaths(statsId).catch((e) => {
    threw = e;
  });
  is("a broken list is an error", threw instanceof PathsUnreadable, true);
  is("a broken list is never written over", [(await savePaths(STORE, [two("X")], COURSES, NOW + 5)).state, (await real([["GET", KEY]]))[0]], ["unknown", "{broken"]);
  await real([["SET", KEY, before[0] as string]]);

  part("The write's answer is read exactly");
  writeReply = ["OK"];
  is("an answer that is not exactly 1 is unknown", (await savePaths(STORE, [two("Y")], COURSES, NOW + 6)).state, "unknown");
  writeReply = [0];
  is("the lock no longer ours: nothing said as saved", (await savePaths(STORE, [two("Y")], COURSES, NOW + 7)).state, "unknown");
  writeReply = null;

  part("The room is never counted as less than what is kept");
  const roomKey = `nl:data:${ROOM.sid}`;
  const slotNow = async () => Number((await real([["HGET", roomKey, "paths"]]))[0]);
  await savePaths(STORE, [two("Kept")], COURSES, NOW + 9);
  const keptSize = await slotNow();
  is("the slot counts the kept list", keptSize > 0, true);
  writeReply = [0];
  await savePaths(STORE, [two("A much longer name for a path, so the list is larger than before"), two("And another one, also long enough to grow it")], COURSES, NOW + 10);
  is("a larger list not written: the slot keeps the larger size", (await slotNow()) > keptSize, true);
  writeReply = null;
  await savePaths(STORE, [two("Kept")], COURSES, NOW + 11);
  writeReply = [0];
  await savePaths(STORE, [two("S")], COURSES, NOW + 12);
  writeReply = null;
  is("a smaller list not written: the slot is never below the kept list's size", await slotNow(), keptSize);

  part("One save at a time");
  await real([["SET", `nl:paths:lock:${statsId}`, "someone", "EX", 60]]);
  is("a save while another holds the lock is busy", (await savePaths(STORE, [two("Z")], COURSES, NOW + 8)).state, "busy");
  await real([["DEL", `nl:paths:lock:${statsId}`]]);
  is("a bad store id is unknown, nothing read", (await savePaths({ ...ROOM, statsId: "nope" }, [two("Z")], COURSES, NOW + 9)).state, "unknown");
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
