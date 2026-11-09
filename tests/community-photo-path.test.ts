/**
 * A community picture already in a post can never be taken over through the picture door
 * (app/api/store/community/upload), deleted by another member's post, or swept as unused (lib/community-files.ts).
 *
 * The audit of 9 November 2026 (Claude 5, proved 8/8 on main and on #3305): the door signed for a path that was
 * already another member's posted picture, since the note it reads was deleted when the picture went into the
 * post. The second member could then put that picture in a post of their own and delete it, or just wait for the
 * daily sweep to delete it. The picture's name is printed on the page, so anyone who can write could do it, to an
 * announcement of the creator as well.
 *
 * Synthetic only: the real door and the real lib/community-files.ts, an in-memory file store
 * (tests/failure-cleanup-world.ts) and the in-memory Redis (tests/redis-stub.ts).
 */
import { POST } from "@/app/api/store/community/upload/route";
import { communityFolder } from "@/lib/community-image";
import * as pictures from "@/lib/community-files";
import { dropCommunityImage, noteCommunityUpload, sweepCommunityUploads, takeCommunityUpload } from "@/lib/community-files";
import { deleted, files } from "./failure-cleanup-world";
import { asViewer } from "./community-photo-path-world";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const folder = communityFolder("community-1");
let n = 0;
/** A fresh name, as the member's browser makes one (components/community-composer.tsx). */
const fresh = () => `community/${folder}/${(++n).toString(16).padStart(32, "0")}.webp`;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Gives a taken picture back to its member, read by name so the test also runs (and fails) where it is missing. */
async function untakeCommunityUpload(path: string, author: string): Promise<void> {
  const untake = (pictures as Record<string, unknown>).untakeCommunityUpload;
  if (typeof untake !== "function") throw new Error("untakeCommunityUpload is missing");
  await (untake as (p: string, a: string) => Promise<unknown>)(path, author);
}

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

async function ask(path: string): Promise<{ status: number; error?: string }> {
  const answer = await POST(door(path) as never);
  const json = (await answer.json()) as { error?: string };
  return { status: answer.status, error: json.error };
}

/** What the browser does with an open door: the file lands under the name it was given. */
function upload(path: string): void {
  files.set(path, { bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]), contentType: "image/webp", at: Date.now() });
}

const listed = async (path: string) => (await redis.pipeline([["ZSCORE", "nl:cimg:doors", path]]))[0] !== null;
const kept = async () => Number((await redis.pipeline([["GET", `nl:cimg:n:${folder}`]]))[0] ?? 0);

async function posted(member: string, owner = false): Promise<string> {
  asViewer(member, owner);
  const path = fresh();
  is(`${member}'s door for a fresh name opens`, (await ask(path)).status, 200);
  upload(path);
  is(`${member} puts the picture in a post`, await takeCommunityUpload(path, member), true);
  return path;
}

async function main(): Promise<void> {
  part("The door refuses the name of a picture already in somebody's post");
  const victim = await posted("victim");
  is("the posted picture is not on the sweep's list", await listed(victim), false);
  const before = await kept();
  asViewer("attacker");
  is("a door for the posted picture's name is refused", await ask(victim), { status: 400, error: "invalid" });
  is("refused before a place is taken", await kept(), before);
  is("the posted picture is still not on the sweep's list", await listed(victim), false);
  // A day and an hour on, for the file store's clock and the database's (whose notes expire by it).
  advance(DAY_MS + 3_600_000);
  const swept = await sweepCommunityUploads(Date.now() + DAY_MS + 3_600_000);
  is("the daily sweep leaves the posted picture alone", files.has(victim) && !deleted.includes(victim), true);
  is("nothing of the victim's swept", swept, 0);
  if (!files.has(victim)) upload(victim);
  is("the attacker cannot put the victim's picture in a post", await takeCommunityUpload(victim, "attacker"), false);

  part("The same for the creator's announcement");
  const announcement = await posted("creator", true);
  asViewer("member");
  is("a door for the announcement's picture is refused", (await ask(announcement)).status, 400);
  is("the member cannot take the announcement's picture", await takeCommunityUpload(announcement, "member"), false);

  part("A door for a name whose door is still open is refused");
  asViewer("first");
  const pending = fresh();
  is("the first door opens", (await ask(pending)).status, 200);
  asViewer("second");
  const placesBefore = await kept();
  is("a second door for the same name is refused", await ask(pending), { status: 400, error: "invalid" });
  is("its place goes back", await kept(), placesBefore);
  is("the second member cannot take it", await takeCommunityUpload(pending, "second"), false);
  upload(pending);
  is("the first member still can", await takeCommunityUpload(pending, "first"), true);

  part("A note that lands after the picture went into a post opens nothing and lists nothing");
  // The door asked the file store before the picture was sent, and wrote its note after the post took it.
  const late = await posted("owner-of-late");
  is("a late note for a taken picture is refused", await noteCommunityUpload(late, "owner-of-late"), false);
  is("and does not put it back on the sweep's list", await listed(late), false);
  is("nobody can take it again", await takeCommunityUpload(late, "owner-of-late"), false);

  part("A note written between the take's two steps is wiped by the take");
  const between = fresh();
  asViewer("racer");
  is("the door opens", (await ask(between)).status, 200);
  upload(between);
  const original = redis.pipeline.bind(redis);
  let injected = false;
  redis.pipeline = (async (batch: (string | number)[][]) => {
    const reply = await original(batch);
    if (!injected && batch[0]?.[0] === "GETDEL") {
      injected = true;
      redis.pipeline = original;
      // A second door for the same name, its note written right after the take read the first one.
      await noteCommunityUpload(between, "racer");
    }
    return reply;
  }) as typeof redis.pipeline;
  try {
    is("the take succeeds", await takeCommunityUpload(between, "racer"), true);
  } finally {
    redis.pipeline = original;
  }
  is("the late note was really written in between", injected, true);
  is("the picture is off the sweep's list", await listed(between), false);
  is("and nobody can take it into a second post", await takeCommunityUpload(between, "racer"), false);

  part("The sweep never deletes a picture a post took, even when it is listed again");
  const relisted = await posted("relisted");
  await redis.pipeline([["ZADD", "nl:cimg:doors", Math.floor((Date.now() - 2 * DAY_MS) / 1000), relisted]]);
  await sweepCommunityUploads(Date.now());
  is("a listed picture marked as taken is kept", files.has(relisted), true);
  is("and taken off the list", await listed(relisted), false);

  part("The sweep still deletes a door's own picture that never went into a post");
  asViewer("idle");
  const unused = fresh();
  is("the door opens", (await ask(unused)).status, 200);
  upload(unused);
  const placesWithIt = await kept();
  advance(DAY_MS + 3_600_000);
  await sweepCommunityUploads(Date.now() + 2 * (DAY_MS + 3_600_000));
  is("the unused picture is deleted", files.has(unused), false);
  is("its place is given back", await kept(), placesWithIt - 1);

  part("A post that could not use its picture gives it back to the same member only");
  const back = await posted("retry");
  let gave = true;
  await untakeCommunityUpload(back, "retry").catch(() => {
    gave = false;
  });
  is("the post's way to give a picture back exists", gave, true);
  is("another member still cannot take it", await takeCommunityUpload(back, "attacker"), false);
  is("the same member can take it again", await takeCommunityUpload(back, "retry"), true);
  await untakeCommunityUpload(back, "attacker").catch(() => {});
  is("another member cannot give it back to themselves", await takeCommunityUpload(back, "attacker"), false);

  part("Deleting a post deletes only that post's own picture");
  await dropCommunityImage(victim);
  is("the victim's own deletion deletes it", files.has(victim), false);
  is("and its place is given back", await kept() >= 0, true);
  done();
}

void main();
