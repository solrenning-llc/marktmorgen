/**
 * A community picture a post no longer needs (its post deleted, or the post refused) whose delete fails, a timeout
 * of the file store, is never lost: it goes to the daily sweep (sweepCommunityUploads), which deletes it and gives
 * its place back. Before, the failure was only logged: the file stayed in storage for good and its place stayed
 * counted against the community's pictures, with nothing that would ever delete it.
 */
import { dropCommunityImage, noteCommunityUpload, picturesKept, sweepCommunityUploads, takeCommunityUpload, takePicturePlace } from "@/lib/community-files";
import { files, state } from "./community-picture-drop-retry-world";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

async function main(): Promise<void> {
  redis.clear();
  const folder = "a".repeat(24);
  const path = `community/${folder}/picture-one.png`;
  const author = "member-key";
  const now = Date.now();

  part("A picture in a post whose delete fails");
  is("its place is taken before the door", await takePicturePlace(path, 5), true);
  is("its door is noted", await noteCommunityUpload(path, author, now), true);
  files.add(path);
  is("it is put in a post", await takeCommunityUpload(path, author), true);
  state.failing = true;
  await dropCommunityImage(path);
  state.failing = false;
  is("the failed delete left the file and its place", [files.has(path), await picturesKept(folder)], [true, 1]);

  part("The daily sweep finishes it");
  await sweepCommunityUploads(now + 2 * 86_400_000);
  is("the file is deleted and its place given back", [files.has(path), await picturesKept(folder)], [false, 0]);

  part("A delete that works is not listed again");
  const other = "b".repeat(24);
  const second = `community/${other}/picture-two.png`;
  await takePicturePlace(second, 5);
  await noteCommunityUpload(second, author, now);
  files.add(second);
  await takeCommunityUpload(second, author);
  await dropCommunityImage(second);
  is("deleted at once, its place back", [files.has(second), await picturesKept(other)], [false, 0]);
  is("a later sweep gives no place back twice", [await sweepCommunityUploads(now + 2 * 86_400_000), await picturesKept(other)], [0, 0]);
  done();
}

void main();
