/**
 * CX-123 rule 24, lot L10b: a store's collection at the video service is made the first time it is needed and recorded
 * with a SET NX of its id (lib/stream.ts collectionFor), so a store's videos are kept together and what it holds is read
 * from the service itself. A reply to that SET in any shape but "OK" or nil is read back: our own id recorded is ours;
 * another id recorded means two uploads made one at once, so ours is taken away again and the video goes into the one
 * recorded; nothing readable opens no upload this time (ours is kept, as it may be the one recorded). The service is
 * played by a stand-in for `fetch`.
 */
import { openUpload } from "@/lib/stream";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ODD, THROWS, UNREADABLE, answer, clearAnswers, getOf, setNx } from "./l10b-replies";

process.env.BUNNY_STREAM_LIBRARY_ID = "4242";
process.env.BUNNY_STREAM_API_KEY = "stand-in-key-that-is-long-enough";
process.env.BUNNY_STREAM_TOKEN_KEY = "stand-in-token-key-long-enough";

const uuid = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
let made = 0;
const deleted: string[] = [];
const videosIn: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/library\/4242/, "");
  if (init?.method === "POST" && path === "/collections") return Response.json({ guid: uuid("cccccccc", (made += 1)) });
  if (init?.method === "DELETE" && path.startsWith("/collections/")) {
    deleted.push(path.slice("/collections/".length));
    return Response.json({});
  }
  if (init?.method === "POST" && path === "/videos") {
    videosIn.push(String((JSON.parse(String(init.body)) as { collectionId: string }).collectionId));
    return Response.json({ guid: uuid("dddddddd", videosIn.length) });
  }
  return Response.json({}, { status: 404 });
}) as typeof fetch;

let n = 0;
const folder = () => `b10b${String((n += 1)).padStart(28, "0")}`;
const upload = (f: string) => openUpload({ folder: f, lessonId: "abcdefghij12", name: "Lesson.mp4", bytes: 1_000_000, type: "video/mp4" });
const COL = "nl:stream:col:";

async function main(): Promise<void> {
  redis.clear();

  part("The plain case: one collection made, recorded and used");
  const plain = folder();
  const opened = await upload(plain);
  is("opened, its video in the collection recorded", [opened.ok, videosIn.at(-1) === redis.run(["GET", `${COL}${plain}`]), deleted.length], [true, true, 0]);

  part("Another upload recorded its own a moment earlier: ours taken away, the video in theirs");
  for (const [shape, reply] of ODD) {
    clearAnswers();
    deleted.length = 0;
    const f = folder();
    const theirs = uuid("eeeeeeee", n);
    answer(setNx(`${COL}${f}`), reply, { before: () => void redis.run(["SET", `${COL}${f}`, theirs]) });
    const got = await upload(f);
    const ours = uuid("cccccccc", made);
    is(`recorded answered with ${shape} while theirs is recorded: opened in theirs, ours taken away`, [got.ok, videosIn.at(-1), deleted, redis.run(["GET", `${COL}${f}`])], [true, theirs, [ours], theirs]);
  }

  part("Ours recorded and its answer lost: our own id read back, used, nothing taken away");
  for (const [shape, reply] of ODD) {
    clearAnswers();
    deleted.length = 0;
    const f = folder();
    answer(setNx(`${COL}${f}`), reply);
    const got = await upload(f);
    const ours = uuid("cccccccc", made);
    is(`answered with ${shape}, the write landed: opened in ours`, [got.ok, videosIn.at(-1), deleted, redis.run(["GET", `${COL}${f}`])], [true, ours, [], ours]);
  }

  part("Nothing readable: no upload opened now, nothing taken away");
  for (const [shape, reply] of [...UNREADABLE, ["the write failing too", THROWS] as const]) {
    clearAnswers();
    deleted.length = 0;
    const videos = videosIn.length;
    answer(setNx(COL), shape === "the write failing too" ? THROWS : () => ["QUEUED"]);
    answer(getOf(COL), reply);
    const got = await upload(folder()).catch(() => ({ ok: "threw" }));
    is(`recorded unknown and its read-back ${shape}: not opened, no video made, nothing taken away`, [got.ok, videosIn.length - videos, deleted], [false, 0, []]);
  }
  clearAnswers();
  done();
}

void main();
