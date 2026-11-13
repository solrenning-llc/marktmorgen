/**
 * Codex G on #3020 @baaa18ed (6751455863, MEDIUM, privacy): when a held post's picture could not be deleted (the file
 * store did not answer), the line that names it (the pictures list) was dropped all the same, so a later erasure of its
 * author had nothing left to find it by, and the file stayed. The line goes only once the file is gone; an erasure that
 * cannot delete one says it did not finish, and a later one deletes it through that line.
 *
 * The test environment has no Blob token, so every deletion fails here, as an outage would.
 */
import { forgetHeldPerson, holdPost, removeHeld, withdrawHeld } from "@/lib/community-approval";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const id = "c".repeat(32);
const SPACE = "aaaaaaaaaaaa";
const ada = "a".repeat(31) + "1";
const folder = "f".repeat(24);
const picture = (n: number) => ({ path: `community/${folder}/held-${n}.png`, w: 100, h: 100, alt: "A drawing" });
const withPicture = (n: number) => ({ space: SPACE, author: ada, title: "", text: "", img: picture(n), kind: "post" as const, poll: null });

// The test environment has no Blob token: every attempt to delete a picture
// ends in dropCommunityImage's log line, which is what is counted here.
let attempts = 0;
const realError = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("could not delete a community picture")) {
    attempts += 1;
    return;
  }
  realError(...args);
};

async function main(): Promise<void> {
  const t0 = 1_800_000_000;
  const line = async (item: string) => (await redis.pipeline([["HGET", `nl:cm:${id}:ap:f`, item]]))[0];

  for (const [what, leave] of [
    ["the creator removes it", (item: string) => removeHeld(id, item, "", t0 + 5).then(() => undefined)],
    ["its author takes it back", (item: string) => withdrawHeld(id, item, ada).then(() => undefined)],
  ] as const) {
    part(`A held post with a picture, ${what}, and the file store does not answer`);
    redis.clear();
    const held = await holdPost(id, withPicture(1), ROOM, t0);
    if (!held.ok) throw new Error("not held");
    attempts = 0;
    await leave(held.held.id);
    is(`${what}: its picture was tried`, attempts, 1);
    is(`${what}: and the line that names it is kept, so it can be found again`, typeof (await line(held.held.id)), "string");
    attempts = 0;
    const erased = await forgetHeldPerson(id, ada).then(() => "finished", () => "not finished");
    is(`${what}: its author's erasure tries the picture again, through that line`, attempts, 1);
    is(`${what}: and says it did not finish, the line still there for the next one`, [erased, typeof (await line(held.held.id))], ["not finished", "string"]);
  }
  done();
}

void main();
