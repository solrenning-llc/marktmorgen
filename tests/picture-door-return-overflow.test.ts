/**
 * Codex N1 and X6 on #2843 (LOW, lib/picture-door.ts returnToDoor): notes put back on the door after a check that did
 * not finish are added with no cap, so a store's list can hold more than PICTURE_DOOR_MAX. This proves, on a synthetic
 * interleaving of takes, new doors and put-backs, that the excess is bounded by the notes in flight between a take and
 * its put-back, never more; that every new door is refused while the list is over the cap (nothing noted, nothing
 * pushed out); that no returned note is lost; that cycles of take and put-back never grow the list; and that the list
 * drains back under the cap and past the day.
 */
import { PICTURE_DOOR_MAX, PICTURE_DOOR_SECONDS, PictureDoorFull, notePictureDoor, putBackOnce, returnToDoor, takePictureDoor } from "@/lib/picture-door";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const FOLDER = "c".repeat(24);
const KEY = `nl:pictures:doors:${FOLDER}`;
const START = 1_800_000_000_000;
let made = 0;
const fresh = () => `images/${FOLDER}/${(made++).toString(16).padStart(32, "0")}.jpg`;
const card = () => Number(redis.run(["ZCARD", KEY]));

/** One door: "noted", "full" (PictureDoorFull, nothing kept) or "not" (no note). */
async function door(now: number): Promise<"noted" | "full" | "not"> {
  const path = fresh();
  try {
    return (await notePictureDoor(path, now)) ? "noted" : "not";
  } catch (error) {
    if (error instanceof PictureDoorFull) return redis.run(["ZSCORE", KEY, path]) === null ? "full" : "not";
    throw error;
  }
}

async function main(): Promise<void> {
  let now = START;
  const held: string[] = [];

  part("A store fills its door to the cap, and the next door is refused");
  for (let i = 0; i < PICTURE_DOOR_MAX; i += 1) {
    const path = fresh();
    if (await notePictureDoor(path, now + (i % 7))) held.push(path);
  }
  is("the store holds exactly PICTURE_DOOR_MAX notes", card(), PICTURE_DOOR_MAX);
  is("one more door is refused, nothing noted", await door(now + 10), "full");
  is("the list still holds PICTURE_DOOR_MAX", card(), PICTURE_DOOR_MAX);

  part("Requests take notes, new doors fill the room they left, and the checks do not finish: every note is put back");
  // Three page saves in flight at once, of 24, 24 and 13 pictures, each taking its notes from the door.
  const sizes = [24, 24, 13];
  const inFlight = sizes.reduce((sum, n) => sum + n, 0);
  const takes: Map<string, number>[] = [];
  for (const n of sizes) takes.push(await takePictureDoor(held.splice(0, n), now + 20));
  is("each save took all its notes", takes.map((taken) => taken.size), sizes);
  is("the list fell by the notes in flight", card(), PICTURE_DOOR_MAX - inFlight);
  let opened = 0;
  for (let i = 0; i < inFlight + 5; i += 1) if ((await door(now + 30)) === "noted") opened += 1;
  is("new doors filled exactly the room the takes left, and no more", opened, inFlight);
  is("the list is back at the cap", card(), PICTURE_DOOR_MAX);
  for (const taken of takes) await returnToDoor([...taken].map(([path, at]) => [path, at + 0.5] as const));
  is("the excess is exactly the notes in flight, never more", card(), PICTURE_DOOR_MAX + inFlight);
  const back = takes.flatMap((taken) => [...taken.keys()]);
  is("no returned note was lost", back.every((path) => redis.run(["ZSCORE", KEY, path]) !== null), true);
  is("each returned note carries the put-back mark", back.every((path) => putBackOnce(Number(redis.run(["ZSCORE", KEY, path])))), true);

  part("While the list is over the cap, every new door is refused and nothing it holds is pushed out");
  const refused = [];
  for (let i = 0; i < 50; i += 1) refused.push(await door(now + 40 + i));
  is("all 50 doors are refused", refused.every((answer) => answer === "full"), true);
  is("the list kept its notes, no more and no less", card(), PICTURE_DOOR_MAX + inFlight);

  part("Cycles of take and put-back never grow the list past the cap and the notes in flight");
  let highest = card();
  for (let round = 0; round < 40; round += 1) {
    now += 60_000;
    const taken = await takePictureDoor(back.slice((round * 7) % 40, (round * 7) % 40 + 21), now);
    if ((await door(now)) !== "full") highest = Infinity;
    await returnToDoor([...taken].map(([path, at]) => [path, Number.isInteger(at) ? at + 0.5 : at] as const));
    highest = Math.max(highest, card());
  }
  is("the highest count seen is the cap and the notes in flight", highest, PICTURE_DOOR_MAX + inFlight);

  part("The list drains back under the cap as pictures are put on, and only then a door opens again");
  const kept = await takePictureDoor(back.slice(0, inFlight), now + 1);
  is("the notes put on records are taken for good", kept.size, inFlight);
  is("the list is back at the cap", card(), PICTURE_DOOR_MAX);
  is("at the cap, a door is still refused", await door(now + 2), "full");
  await takePictureDoor(held.splice(0, 1), now + 3);
  is("one picture put on leaves room for one door", await door(now + 4), "noted");
  is("and no more", await door(now + 5), "full");

  part("Past the day, the old notes, put back or not, are dropped as a new door comes in");
  now += PICTURE_DOOR_SECONDS * 1000 + 60_000;
  is("a door opens on a new day", await door(now), "noted");
  is("only the new note is left", card(), 1);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
