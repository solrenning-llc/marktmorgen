/**
 * A picture a post took (lib/community-files.ts takeCommunityUpload) is never
 * deleted by the sweep of doors never used, even when the removal of its path
 * from the doors' list failed. Before: the ZREM's failure was swallowed, the
 * path stayed listed, and a day later the sweep deleted the picture from
 * under the published post.
 */
import { picturesKept, sweepCommunityUploads, takeCommunityUpload, takePicturePlace, noteCommunityUpload } from "@/lib/community-files";
import { communityFolder } from "@/lib/community-image";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { COMMUNITY_ID, MEMBER, deleted, files } from "./community-upload-door-exact-world";

type Command = (string | number)[];
const original: typeof redis.pipeline = redis.pipeline.bind(redis);
const folder = communityFolder(COMMUNITY_ID);
const DAY = 86_400_000;
const path = `community/${folder}/${"1".padStart(32, "0")}.jpg`;

async function main(): Promise<void> {
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const quiet = console.error;
  console.error = () => {};
  try {
    part("The post takes the picture, but taking it off the doors' list fails");
    is("a place is taken", await takePicturePlace(path, 50), true);
    is("its door is noted", await noteCommunityUpload(path, MEMBER), true);
    files.add(path);
    redis.pipeline = (async (commands: Command[]) => {
      if (commands[0][0] === "ZREM") throw new Error("the connection failed before the removal was sent");
      return original(commands);
    }) as typeof redis.pipeline;
    const taken = await takeCommunityUpload(path, MEMBER).catch(() => "threw");
    redis.pipeline = original;
    // Either answer is acceptable to the post (refusing the picture, or taking it); what must
    // never happen is a picture a post took being deleted by the sweep of unused doors.
    if (taken === true) {
      await sweepCommunityUploads(Date.now() + 2 * DAY);
      is("the post's picture is still there a day on", [files.has(path), deleted.includes(path)], [true, false]);
      is("and its place is still counted", await picturesKept(folder), 1);
    } else {
      is("a picture not taken stays this member's for the next try", await takeCommunityUpload(path, MEMBER), true);
    }
  } finally {
    console.error = quiet;
    redis.pipeline = original;
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
