/**
 * 543 [CM2] (#3020): Claude 1's MEDIUM in the quality review at c3f0b1a435.
 *
 * hold() wrote the held record in one request and only in the next put it on
 * the member's list, the queue and the pictures list. When that second request
 * never reached Redis, the record (the whole text, kept KEEP_DAYS) was in no
 * list: its author could not see or withdraw it, the creator never saw it, and
 * erasing the author (forgetHeldPerson, which finds items only through those
 * lists) left it, and its picture, behind.
 *
 * Now the member's list and the picture's line are written before the record:
 * whatever request is lost, erasing the author finds and deletes all of it.
 *
 * Synthetic data only.
 */
import { forgetHeldPerson, heldOf, holdPost } from "@/lib/community-approval";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const id = "c".repeat(32);
const SPACE = "aaaaaaaaaaaa";
const ada = "a".repeat(31) + "1";
const folder = "f".repeat(24);
const withPicture = { space: SPACE, author: ada, title: "", text: "my private words", img: { path: `community/${folder}/held-1.png`, w: 100, h: 100, alt: "A drawing" }, kind: "post" as const, poll: null };

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

/** The pipeline holding a ZADD on the queue never reaches Redis, once. */
function dropQueueOnce(): () => void {
  const real = redis.pipeline.bind(redis);
  let once = true;
  redis.pipeline = async (commands) => {
    if (once && commands.some((command) => command[0] === "ZADD" && String(command[1]).includes(":ap:q"))) {
      once = false;
      throw new Error("fetch failed");
    }
    return real(commands);
  };
  return () => {
    redis.pipeline = real;
  };
}

/** Erases the author; with no Blob token here the picture's delete fails by design, and only that is let through. */
async function erase(): Promise<void> {
  try {
    await forgetHeldPerson(id, ada);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("a picture could not be deleted")) throw error;
  }
}

const heldRecords = () => redis.keys().filter((key) => key.startsWith(`nl:cm:${id}:ap:i:`));

async function main(): Promise<void> {
  part("A placing request that never reached Redis leaves nothing erasure cannot find");
  redis.clear();
  attempts = 0;
  const restore = dropQueueOnce();
  let thrown = false;
  try {
    await holdPost(id, withPicture, ROOM);
  } catch {
    thrown = true;
  }
  restore();
  is("the failed placing is said as a failure", thrown, true);
  await erase();
  is("after erasing the author, no held record of theirs is left", heldRecords().length, 0);
  is("and their picture is deleted (one attempt)", attempts, 1);

  part("Control: a placing that works is unchanged");
  redis.clear();
  attempts = 0;
  const kept = await holdPost(id, withPicture, ROOM);
  is("held", kept.ok, true);
  is("its author sees it", (await heldOf(id, ada)).length, 1);
  await erase();
  is("erasing the author leaves no record", heldRecords().length, 0);
  is("and deletes the picture", attempts, 1);

  done();
}

void main();
