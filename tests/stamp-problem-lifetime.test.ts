/**
 * A file's problem note (nl:stamp:problem:) is priced for as long as it can live (Claude 5 ygH4 and iao9Ep on #5360).
 * The stamp and the preview write the same key: a stamp's problem, the preview's once-note, then "unreadable". No write
 * extends the note's time: a write to a note already there keeps its expiry (KEEPTTL), and only a new note takes
 * PROBLEM_NOTE_SECONDS. So one note lives at most PROBLEM_NOTE_SECONDS from its first write, however many failures
 * follow (a stamp note then the preview's two notes, or a PDF whose stamping fails on every download). The data
 * registry's part and the key's closing rule cover that life, tied to the constants, never a number typed beside them.
 * Synthetic Redis only; no network.
 */
import { readFileSync } from "node:fs";
import * as rules from "@/lib/stamp-cost-rules";
import * as stamp from "@/lib/pdf-stamp";
import { closingOf } from "@/lib/data-families";
import { FAMILIES } from "./store-data-registry";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 86_400;
const r = rules as { PROBLEM_NOTE_SECONDS?: number; PROBLEM_NOTE_LONGEST_DAYS?: number };
const write = (stamp as { problemNoteCommands?: (pathname: string, value: string) => (string | number)[][] }).problemNoteCommands;

async function main(): Promise<void> {
  part("The longest life of a path's problem note is named, from the note's own time");
  is("the note's time is named once (PROBLEM_NOTE_SECONDS, 60 days)", r.PROBLEM_NOTE_SECONDS, 60 * DAY);
  is("its longest life is that time, since no write extends it", r.PROBLEM_NOTE_LONGEST_DAYS, (r.PROBLEM_NOTE_SECONDS ?? 0) / DAY);

  part("The data registry and the closing rule cover that longest life");
  const family = FAMILIES["nl:stamp:problem:@lib/pdf-stamp.ts"];
  const days = (family?.parts ?? []).map((p) => ("days" in p ? Number((p as { days: number }).days) : 0));
  is("the registry prices the note per file for at least its longest life", days.length > 0 && days.every((d) => d >= (r.PROBLEM_NOTE_LONGEST_DAYS ?? Infinity)), true);
  const closing = closingOf("nl:stamp:problem:stores/abc/file.pdf");
  is("the key's closing rule says it expires within at least its longest life",
    closing?.how === "expires" && (closing as { days: number }).days >= (r.PROBLEM_NOTE_LONGEST_DAYS ?? Infinity), true);

  part("Every write of the note goes through the one write that never extends it");
  for (const file of ["lib/pdf-stamp.ts", "lib/pdf-preview.ts"]) {
    const text = readFileSync(file, "utf8");
    is(`${file}: no SET of problemKey of its own`, /\["SET",\s*problemKey\(/.test(text), false);
  }
  is("the write is shared", typeof write, "function");

  const ttl = async (key: string) => Number((await redis.pipeline([["TTL", key]]))[0]);
  const at = (path: string) => stamp.problemKey(path);
  const put = async (path: string, value: string) => { if (write) await redis.pipeline(write(path, value)); };
  const SECONDS = r.PROBLEM_NOTE_SECONDS ?? 60 * DAY;

  part("A stamp note, then the preview's once-note and unreadable: the note ends at the first note's time");
  {
    redis.clear();
    const path = "stores/aa/prod/chain.pdf";
    await put(path, "storage");
    is("a new note takes the note's whole time", await ttl(at(path)), SECONDS);
    advance(59 * DAY * 1000);
    await put(path, `unreadable-once:${Date.now()}`);
    is("the once-note keeps the stamp note's expiry", await ttl(at(path)) <= DAY, true);
    advance(2 * 3600 * 1000);
    await put(path, "unreadable");
    is("unreadable keeps it too, and says unreadable", [await ttl(at(path)) <= DAY, (await redis.pipeline([["GET", at(path)]]))[0]], [true, "unreadable"]);
    advance(DAY * 1000);
    is("60 days after its first write the note is gone", (await redis.pipeline([["GET", at(path)]]))[0], null);
  }

  part("A PDF whose stamping fails on every download: the note is never extended");
  {
    redis.clear();
    const path = "stores/aa/prod/again.pdf";
    await put(path, "storage");
    for (let day = 0; day < 59; day += 1) {
      advance(DAY * 1000);
      await put(path, "storage");
    }
    is("after 59 daily failures the note still ends at its first write's time", await ttl(at(path)) <= DAY, true);
    advance(DAY * 1000);
    is("then it is gone", (await redis.pipeline([["GET", at(path)]]))[0], null);
  }

  done();
}

void main();
