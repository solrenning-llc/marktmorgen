/**
 * How far a store's picture-door list can pass PICTURE_DOOR_MAX, and why that never opens a door or a cost the cap does
 * not cover (Codex N1 on #2843, LOW, lib/picture-door.ts returnToDoor; Codex X6 before it).
 *
 * returnToDoor puts back, uncapped, notes a request took and could not finish checking. Interleaved with new doors, the
 * list can then hold more than PICTURE_DOOR_MAX. This drives the real notePictureDoor, takePictureDoor and returnToDoor
 * on the tests' Redis, with synthetic paths, through that interleaving at its worst, and holds the bound:
 *
 *   - a door is noted only while the whole list, put-back notes included, is at most PICTURE_DOOR_MAX, so the notes a
 *     door wrote (whole milliseconds) never pass PICTURE_DOOR_MAX, however many come back;
 *   - a note comes back only after it was taken off, at half a millisecond (putBackOnce), and only once: a note put back
 *     and taken again is not put back a second time by the list itself, so the put-back notes are at most the notes the
 *     doors wrote, and the list is at most 2 x PICTURE_DOOR_MAX;
 *   - while the list is past the cap every new door is refused (PictureDoorFull), with nothing noted;
 *   - every note, put back or not, ends with the day (EXPIRE PICTURE_DOOR_SECONDS; a note older than the day is
 *     trimmed by the next door and never returned by a take), so the overflow does not outlive its notes.
 */
import { PICTURE_DOOR_MAX, PICTURE_DOOR_SECONDS, PictureDoorFull, notePictureDoor, putBackOnce, returnToDoor, takePictureDoor } from "@/lib/picture-door";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const FOLDER = "a1b2c3d4e5f6a7b8c9d0e1f2";
const KEY = `nl:pictures:doors:${FOLDER}`;
const path = (n: number) => `images/${FOLDER}/p${n}.png`;
const T0 = 1_800_000_000_000;

async function list(): Promise<Array<[string, number]>> {
  const flat = (await redis.pipeline([["ZRANGE", KEY, 0, -1, "WITHSCORES"]]))[0] as string[];
  const out: Array<[string, number]> = [];
  for (let i = 0; i < flat.length; i += 2) out.push([flat[i], Number(flat[i + 1])]);
  return out;
}

async function refused(n: number, at: number): Promise<boolean> {
  return notePictureDoor(path(n), at).then(() => false, (error: unknown) => error instanceof PictureDoorFull);
}

async function main() {
  part("The cap holds for doors: PICTURE_DOOR_MAX notes, and one more is refused with nothing noted");
  for (let n = 0; n < PICTURE_DOOR_MAX; n += 1) await notePictureDoor(path(n), T0 + n);
  is("the list holds PICTURE_DOOR_MAX notes", (await list()).length, PICTURE_DOOR_MAX);
  is("one more door is refused", await refused(PICTURE_DOOR_MAX, T0 + PICTURE_DOOR_MAX), true);
  is("and nothing was noted for it", (await list()).length, PICTURE_DOOR_MAX);

  part("At its worst: every note taken, as many new doors opened, then every taken note put back");
  const all = Array.from({ length: PICTURE_DOOR_MAX }, (_, n) => path(n));
  const taken = await takePictureDoor(all, T0 + 2 * PICTURE_DOOR_MAX);
  is("the take took every note", taken.size, PICTURE_DOOR_MAX);
  for (let n = 0; n < PICTURE_DOOR_MAX; n += 1) await notePictureDoor(path(10_000 + n), T0 + 3 * PICTURE_DOOR_MAX + n);
  is("the room the take made was filled by new doors", (await list()).length, PICTURE_DOOR_MAX);
  // The checks did not finish: each note goes back at half a millisecond past its time, as the page save does.
  await returnToDoor([...taken].map(([p, at]) => [p, at + 0.5] as const));
  const after = await list();
  is("the list passes the cap by the notes in flight, no more: 2 x PICTURE_DOOR_MAX", after.length, 2 * PICTURE_DOOR_MAX);
  is("the notes doors wrote (whole milliseconds) never pass PICTURE_DOOR_MAX", after.filter(([, at]) => !putBackOnce(at)).length, PICTURE_DOOR_MAX);
  is("every note past the cap is one put back once", after.filter(([, at]) => putBackOnce(at)).length, PICTURE_DOOR_MAX);

  part("While past the cap, no door opens");
  is("a new door is refused", await refused(20_000, T0 + 5 * PICTURE_DOOR_MAX), true);
  is("and nothing was noted for it", (await list()).length, 2 * PICTURE_DOOR_MAX);

  part("No growth without a door: taking and putting back again does not add a note");
  const again = await takePictureDoor(after.map(([p]) => p), T0 + 6 * PICTURE_DOOR_MAX);
  is("the second take took every note", again.size, 2 * PICTURE_DOOR_MAX);
  await returnToDoor([...again].map(([p, at]) => [p, putBackOnce(at) ? at : at + 0.5] as const));
  is("put back again, the list is the same size", (await list()).length, 2 * PICTURE_DOOR_MAX);
  is("still no door opens", await refused(20_001, T0 + 7 * PICTURE_DOOR_MAX), true);

  part("The overflow ends with the day");
  const ttl = Number((await redis.pipeline([["TTL", KEY]]))[0]);
  is("the list expires within the day", ttl > 0 && ttl <= PICTURE_DOOR_SECONDS, true);
  const late = T0 + 7 * PICTURE_DOOR_MAX + PICTURE_DOOR_SECONDS * 1000 + 1;
  is("a day later a stale note is trimmed and a door opens again", await notePictureDoor(path(30_000), late), true);
  is("only that door's note is left", (await list()).length, 1);

  done();
}

void main();
