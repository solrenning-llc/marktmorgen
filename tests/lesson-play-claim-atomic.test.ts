/**
 * A signed-in viewer's place in a store (lib/lesson-play.ts) is taken back and replaced only while it is still the
 * press's own claim, in one step (Codex N1's LOW 1 on #3402): dropPlayingClaim read the key and then deleted it, and
 * keepPlaying wrote its token with a plain SET. If the claim ran out between the read and the delete, and another press
 * of theirs claimed the place meanwhile, the first press deleted the second's claim (or wrote over it), so two presses
 * could each hold and sign a block for the same person.
 *
 * What is held, with the stand-in Redis and a race put between the commands a press sends:
 *   - a claim replaced by another press's claim after it was read is never deleted: the new claim survives;
 *   - a token is never written over another press's claim: keepPlaying answers false and the new claim survives;
 *   - a token too short to keep lets the press's own claim go, in the same script, and is not kept;
 *   - controls: the press's own claim is let go, and its own claim is replaced by its token.
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { claimPlaying, dropPlayingClaim, keepPlaying } from "@/lib/lesson-play";
import { STREAM_PLAYER_ORIGIN } from "@/lib/stream-rules";
import { store as redis } from "./redis-stub";

const WHO = "learner:race@example.com";
const FOLDER = "store-folder-1";
const KEY = `nl:learn:playing:${createHash("sha256").update(`${WHO}\n${FOLDER}`).digest("hex").slice(0, 40)}`;
const OTHER = "claim:another-press-of-theirs";

const original = redis.pipeline;
/** After the press's next command that touches the place, another press claims it, before the press sends another. */
function raceAfterRead(): () => void {
  let armed = true;
  redis.pipeline = async (commands) => {
    const answers = await original(commands);
    if (armed && commands.some((command) => command.includes(KEY))) {
      armed = false;
      await original([["SET", KEY, OTHER, "EX", 120]]);
    }
    return answers;
  };
  return () => { redis.pipeline = original; };
}

async function ownClaim(): Promise<string> {
  await original([["DEL", KEY]]);
  const place = await claimPlaying(WHO, FOLDER);
  assert.ok(place && "claim" in place, "the press claims the free place");
  return (place as { claim: string }).claim;
}

const player = (now: number) => ({ src: `${STREAM_PLAYER_ORIGIN}/embed/1/video?token=t&expires=${Math.floor(now / 1000) + 4 * 3600}`, width: 1280, height: 720 });

test("a claim replaced by another press after it was read is never deleted", async () => {
  const claim = await ownClaim();
  // The press's claim ran out and another press of theirs claimed the place: what the race leaves.
  await original([["SET", KEY, claim, "EX", 120]]);
  const undo = raceAfterRead();
  try {
    await dropPlayingClaim(WHO, FOLDER, claim);
  } finally {
    undo();
  }
  const [left] = await original([["GET", KEY]]);
  assert.equal(left, OTHER, "the other press's claim survives");
});

test("a token is never written over another press's claim", async () => {
  const claim = await ownClaim();
  await original([["SET", KEY, OTHER, "EX", 120]]);
  const kept = await keepPlaying(WHO, FOLDER, claim, "store-folder-1/lesson.mp4", player(Date.now()));
  assert.equal(kept, false, "nothing kept: the place is another press's");
  const [left] = await original([["GET", KEY]]);
  assert.equal(left, OTHER, "the other press's claim survives");
});

test("controls: the press's own claim is let go, and its own claim is replaced by its token", async () => {
  const first = await ownClaim();
  await dropPlayingClaim(WHO, FOLDER, first);
  assert.equal((await original([["GET", KEY]]))[0], null, "its own claim is let go");
  const second = await ownClaim();
  const now = Date.now();
  assert.equal(await keepPlaying(WHO, FOLDER, second, "store-folder-1/lesson.mp4", player(now), now), true, "its token is kept");
  const [raw] = await original([["GET", KEY]]);
  assert.equal(JSON.parse(String(raw)).p, "store-folder-1/lesson.mp4", "the place holds its token now");
});

test("a token too short to keep lets the press's own claim go, and is not kept", async () => {
  const claim = await ownClaim();
  const now = Date.now();
  const short = { ...player(now), src: `${STREAM_PLAYER_ORIGIN}/embed/1/video?token=t&expires=${Math.floor(now / 1000) + 5}` };
  assert.equal(await keepPlaying(WHO, FOLDER, claim, "store-folder-1/lesson.mp4", short, now), false, "not kept");
  assert.equal((await original([["GET", KEY]]))[0], null, "its claim is let go");
});
