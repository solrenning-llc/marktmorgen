/**
 * The daily sweep never deletes a picture a post is taking (pre-review of claude5/community-photo-path at
 * ef1eaea581, 9 November 2026): the take read the note and wrote its TAKEN mark in two steps, and a sweep that read
 * the note between them found it gone and deleted the picture. The take is now one script (lib/community-files.ts,
 * TAKE_PICTURE), and the sweep deletes only a door listed more than a day and an hour ago, past any clock skew
 * between the app and the database.
 *
 * Synthetic only: the real lib/community-files.ts, the in-memory Redis (tests/redis-stub.ts) and file store
 * (tests/failure-cleanup-world.ts).
 */
import { communityFolder } from "@/lib/community-image";
import { noteCommunityUpload, sweepCommunityUploads, takeCommunityUpload } from "@/lib/community-files";
import { files } from "./failure-cleanup-world";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY_MS = 86_400_000;
const folder = communityFolder("community-1");
const named = (c: string) => `community/${folder}/${c.repeat(32)}.webp`;
const upload = (path: string) => files.set(path, { bytes: new Uint8Array(16), contentType: "image/webp", at: Date.now() });

async function main(): Promise<void> {
  part("A sweep at a day's edge never deletes the picture a post is taking");
  {
    // The pre-reviewer's proof: listed a day and a minute ago by the app's clock, its note still alive by the
    // database's (a minute's skew), and a sweep run while the member's post takes it.
    const path = named("b");
    is("door noted", await noteCommunityUpload(path, "member", Date.now() - DAY_MS - 60_000), true);
    upload(path);
    const original = redis.pipeline.bind(redis);
    const batches: string[] = [];
    let swept = false;
    redis.pipeline = (async (batch: (string | number)[][]) => {
      batches.push(batch.map((command) => String(command[0])).join("+"));
      const reply = await original(batch);
      if (!swept && batches.length === 1) {
        // Right after the take's first step, whatever it is.
        swept = true;
        redis.pipeline = original;
        await sweepCommunityUploads(Date.now());
      }
      return reply;
    }) as typeof redis.pipeline;
    let took: unknown;
    try {
      took = await takeCommunityUpload(path, "member");
    } finally {
      redis.pipeline = original;
    }
    is("the member's post takes the picture", took, true);
    is("the take is one step: a single script", batches, ["EVAL"]);
    is("the picture the post took is still in the file store", files.has(path), true);
  }

  part("The sweep waits a day and an hour after a door");
  {
    const path = named("c");
    is("door noted a day and half an hour ago", await noteCommunityUpload(path, "idle", Date.now() - DAY_MS - 1_800_000), true);
    upload(path);
    advance(DAY_MS + 1_000); // its note gone by the database's clock
    await sweepCommunityUploads(Date.now());
    is("not deleted yet", files.has(path), true);
    await sweepCommunityUploads(Date.now() + 3_600_000);
    is("deleted once a day and an hour have passed", files.has(path), false);
  }

  part("The take's script reads exactly");
  {
    const path = named("d");
    is("door noted", await noteCommunityUpload(path, "someone", Date.now()), true);
    is("another member's take is refused", await takeCommunityUpload(path, "other"), false);
    is("and the note stays the member's", await takeCommunityUpload(path, "someone"), true);
    is("a second take of the same picture is refused", await takeCommunityUpload(path, "someone"), false);
    const original = redis.pipeline.bind(redis);
    for (const [label, reply] of [["text", ["1"]], ["two", [2]], ["null", [null]], ["none", []]] as const) {
      const other = named(String(label.length + 4));
      await noteCommunityUpload(other, "member", Date.now());
      redis.pipeline = (async (batch: (string | number)[][]) => (batch[0]?.[0] === "EVAL" ? [...reply] : original(batch))) as typeof redis.pipeline;
      let outcome = "returned";
      try {
        await takeCommunityUpload(other, "member");
      } catch {
        outcome = "threw";
      } finally {
        redis.pipeline = original;
      }
      is(`a take answered ${label} is unknown: no post is made`, outcome, "threw");
    }
  }
  done();
}

void main();
