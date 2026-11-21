/**
 * The note that a store was found without room (lib/pdf-stamp.ts noRoomKey) is read in its exact shape (Codex X4's LOW
 * on #3899, CX-123 rule 24): only the "1" it is written with is a note, and no key is no note. A reply in any other
 * shape was taken as a note; now it reads as the documented unknown, no note, as a reply that throws does: the store is
 * measured, and that measurement is paid for before it lists (STORAGE_MEASURE_UNITS), so an unknown never skips a
 * ceiling. Synthetic Redis; nothing is reached.
 */
import { noRoomKey, roomNotedOut } from "@/lib/pdf-stamp";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const FOLDER = "0123456789abcdef0123456789abcdef";
const file = { pathname: `stores/${FOLDER}/0000000001/book.pdf` };
type Command = (string | number)[];
const pipeline = redis.pipeline.bind(redis);
let answer: unknown = undefined;
redis.pipeline = (async (commands: Command[]) => {
  if (answer !== undefined && commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === noRoomKey(FOLDER)) return [answer];
  return pipeline(commands);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  part("The note as it is written, and no note");
  is("no key: no note", await roomNotedOut(file), false);
  await pipeline([["SET", noRoomKey(FOLDER), "1", "EX", 3600]]);
  is('"1": noted', await roomNotedOut(file), true);

  part("A reply in another shape is not a note");
  for (const odd of ["QUEUED", "0", "", 1, true, ["1"], { result: "1" }]) {
    answer = odd;
    is(`${JSON.stringify(odd)} is not a note`, await roomNotedOut(file), false);
  }
  answer = undefined;
}

void main().then(done).catch((error) => { console.error(error); process.exit(1); });
