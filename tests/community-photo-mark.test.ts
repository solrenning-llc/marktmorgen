/**
 * The two security reviews of #3414 at 196721cf70 (Claude 2 and Claude 6, 9 November 2026), proved here:
 *
 * - Claude 6, MEDIUM 1: the note and its listing were two trips to the database; the member's own post taking the
 *   name between them made the door give its place back, and the sweep gave the same place back again.
 * - Claude 2 MEDIUM and Claude 6 MEDIUM 2: plan closing removes a community's files and keeps its posts; once the
 *   three-day mark had lapsed, a door opened for a surviving post's name, and an upload there showed in that post.
 * - Claude 2 LOW 1 and Claude 6 LOW 2: a listing left behind for a taken picture outlived its mark.
 * - Claude 2 LOW 2: a door for a name still listed from an earlier door kept that earlier, older time.
 * - Claude 6 LOW 3: the mark kept the member's key.
 *
 * Synthetic only: the real door and lib/community-files.ts, the in-memory file store and Redis.
 */
import { createHash } from "node:crypto";
import { POST } from "@/app/api/store/community/upload/route";
import { communityFolder } from "@/lib/community-image";
import { dropCommunityImage, forgetPictures, sweepCommunityUploads, takeCommunityUpload, untakeCommunityUpload } from "@/lib/community-files";
import { files } from "./failure-cleanup-world";
import { asViewer } from "./community-photo-path-world";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY_MS = 86_400_000;
const folder = communityFolder("community-1");
let n = 0x100;
const fresh = () => `community/${folder}/${(++n).toString(16).padStart(32, "0")}.webp`;
const upload = (path: string) => files.set(path, { bytes: new Uint8Array(16), contentType: "image/webp", at: Date.now() });
const kept = async () => Number((await redis.pipeline([["GET", `nl:cimg:n:${folder}`]]))[0] ?? 0);
const score = async (path: string) => (await redis.pipeline([["ZSCORE", "nl:cimg:doors", path]]))[0];

function door(path: string): Request {
  const body = JSON.stringify({ type: "blob.generate-presigned-url", payload: { pathname: path, clientPayload: JSON.stringify({ handle: "shop" }) } });
  const request = new Request("https://marktmorgen.com/api/store/community/upload", {
    method: "POST",
    headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/json" },
    body,
  });
  (request as unknown as { cookies: unknown }).cookies = { get: () => undefined };
  return request;
}
const ask = async (path: string) => (await POST(door(path) as never)).status;

async function posted(member: string, owner = false): Promise<string> {
  asViewer(member, owner);
  const path = fresh();
  is(`${member}'s door opens`, await ask(path), 200);
  upload(path);
  is(`${member}'s post takes it`, await takeCommunityUpload(path, member), true);
  return path;
}

async function main(): Promise<void> {
  part("Claude 6 MEDIUM 1: the member's own take inside the door never gives a place back twice");
  {
    await redis.pipeline([["DEL", `nl:cimg:n:${folder}`]]);
    await posted("first");
    is("one picture kept, one place counted", await kept(), 1);
    asViewer("member");
    const path = fresh();
    const original = redis.pipeline.bind(redis);
    let took: boolean | null = null;
    redis.pipeline = (async (batch: (string | number)[][]) => {
      const reply = await original(batch);
      const first = batch[0] ?? [];
      const note = (first[0] === "SET" && String(first[1]).startsWith("nl:cimg:") && first[3] === "NX") || (first[0] === "EVAL" && String(first[1]).includes("community-picture-note"));
      if (took === null && note) {
        redis.pipeline = original;
        // The member's post form takes the name right after the door's first step (no file yet).
        took = await takeCommunityUpload(path, "member");
      }
      return reply;
    }) as typeof redis.pipeline;
    let status = 0;
    try {
      status = await ask(path);
    } finally {
      redis.pipeline = original;
    }
    is("the take ran inside the door", took, true);
    void status;
    // The post found no file, and gave the picture back to the member.
    await untakeCommunityUpload(path, "member");
    advance(DAY_MS + 2 * 3_600_000);
    await sweepCommunityUploads(Date.now() + DAY_MS + 3 * 3_600_000);
    is("the count is the pictures really kept", await kept(), 1);
  }

  part("Claude 2 / Claude 6 MEDIUM: after plan closing removed the files, a surviving post's name opens no door");
  {
    const announcement = await posted("creator", true);
    const member = await posted("victim");
    // Plan closing in the "removed" state (lib/plan-closing.ts): every file under the folder deleted, the count
    // forgotten, the posts kept; it comes days after its notice.
    files.delete(announcement);
    files.delete(member);
    await forgetPictures(folder);
    advance(4 * DAY_MS);
    asViewer("attacker");
    is("no door for the announcement's name", await ask(announcement), 400);
    is("no door for the member's post's name", await ask(member), 400);
    is("nobody can take the announcement's name", await takeCommunityUpload(announcement, "attacker"), false);
    is("nobody can take the member's post's name", await takeCommunityUpload(member, "attacker"), false);
    is("refused without taking a place", await kept(), 0);
  }

  part("A post that drops its picture takes any listing left for it, and gives its place back once");
  {
    await redis.pipeline([["DEL", `nl:cimg:n:${folder}`]]);
    const path = await posted("dropper");
    // A listing left behind for the taken picture (the sweep's re-list racing the take).
    await redis.pipeline([["ZADD", "nl:cimg:doors", Math.floor((Date.now() - 2 * DAY_MS) / 1000), path]]);
    advance(4 * DAY_MS);
    await sweepCommunityUploads(Date.now());
    is("the sweep keeps a picture still in a post, even days on", files.has(path), true);
    await redis.pipeline([["ZADD", "nl:cimg:doors", Math.floor((Date.now() - 2 * DAY_MS) / 1000), path]]);
    await dropCommunityImage(path);
    is("deleting the post deletes the picture", files.has(path), false);
    is("and takes its listing off", await score(path), null);
    is("its place given back once", await kept(), 0);
    await sweepCommunityUploads(Date.now());
    is("a later sweep gives nothing back again", await kept(), 0);
  }

  part("Claude 2 LOW 2: a door's listing has its own time, not an earlier door's");
  {
    const path = fresh();
    const old = Math.floor((Date.now() - 2 * DAY_MS) / 1000);
    await redis.pipeline([["ZADD", "nl:cimg:doors", old, path]]);
    asViewer("fresh-door");
    is("the door opens", await ask(path), 200);
    is("listed at the door's own time", Number(await score(path)) >= Math.floor(Date.now() / 1000) - 60, true);
  }

  part("Claude 6 LOW 3: the mark of a picture in a post does not keep the member's key");
  {
    const path = await posted("a".repeat(32));
    // The picture's note key, as lib/community-files.ts names it.
    const noteKey = `nl:cimg:${createHash("sha256").update(path).digest("hex").slice(0, 32)}`;
    const [value] = await redis.pipeline([["GET", noteKey]]);
    is("the picture is marked as taken", typeof value === "string" && value.startsWith("\ttaken"), true);
    is("the mark does not hold the member's key", typeof value === "string" && value.includes("a".repeat(32)), false);
    is("only that member can give it back", await untakeCommunityUpload(path, "b".repeat(32)).then(() => takeCommunityUpload(path, "b".repeat(32))), false);
  }
  done();
}

void main();
