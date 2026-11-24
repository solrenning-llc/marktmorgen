/**
 * A file's problem note (nl:stamp:problem:) is priced for as long as it can live (Claude 5 ygH4 and iao9Ep on #5360).
 * The stamp writes it, and the preview writes "unreadable" there on its second failure; the preview's once-mark is its
 * own key (nl:preview:bad:, Claude 3 on #5360), priced and closed for its own longest life, below. No write
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
  // The preview's second failure writes "unreadable" fresh, once, so the studio says why as long as the preview refuses
  // the file (Claude 5 ygH4 on #5360): a stamp note, then that write just before it runs out.
  is("its longest life is twice that time: a note, then the preview's fresh unreadable", r.PROBLEM_NOTE_LONGEST_DAYS, (2 * (r.PROBLEM_NOTE_SECONDS ?? 0)) / DAY);

  part("The data registry and the closing rule cover that longest life");
  const family = FAMILIES["nl:stamp:problem:@lib/pdf-stamp.ts"];
  const days = (family?.parts ?? []).map((p) => ("days" in p ? Number((p as { days: number }).days) : 0));
  is("the registry prices the note per file for at least its longest life", days.length > 0 && days.every((d) => d >= (r.PROBLEM_NOTE_LONGEST_DAYS ?? Infinity)), true);
  const closing = closingOf("nl:stamp:problem:stores/abc/file.pdf");
  is("the key's closing rule says it expires within at least its longest life",
    closing?.how === "expires" && (closing as { days: number }).days >= (r.PROBLEM_NOTE_LONGEST_DAYS ?? Infinity), true);

  // The preview's own mark (Claude 3 and Claude 5 ygH4 on #5360): its once-mark, then "unreadable" fresh, each
  // PREVIEW_MARK_SECONDS; priced and closed for both.
  part("The preview's own mark is priced and closed for its longest life");
  const m = rules as { PREVIEW_MARK_SECONDS?: number; PREVIEW_MARK_LONGEST_DAYS?: number };
  is("its time and longest life are named (60 days, then 120)", [m.PREVIEW_MARK_SECONDS, m.PREVIEW_MARK_LONGEST_DAYS], [60 * DAY, (2 * (m.PREVIEW_MARK_SECONDS ?? 0)) / DAY]);
  const markDays = (FAMILIES["nl:preview:bad:@lib/pdf-preview.ts"]?.parts ?? []).map((p) => ("days" in p ? Number((p as { days: number }).days) : 0));
  is("the registry prices the mark per file for at least its longest life", markDays.length > 0 && markDays.every((d) => d >= (m.PREVIEW_MARK_LONGEST_DAYS ?? Infinity)), true);
  const markClosing = closingOf("nl:preview:bad:0123456789abcdef");
  is("its closing rule says it expires within at least its longest life",
    markClosing?.how === "expires" && (markClosing as { days: number }).days >= (m.PREVIEW_MARK_LONGEST_DAYS ?? Infinity), true);

  part("Every stamp write of the note goes through the one write that never extends it; the preview writes it fresh once");
  is("lib/pdf-stamp.ts: no SET of problemKey of its own", /\["SET",\s*problemKey\(/.test(readFileSync("lib/pdf-stamp.ts", "utf8")), false);
  const previewSets = readFileSync("lib/pdf-preview.ts", "utf8").match(/\["SET",\s*problemKey\([^\]]*\]/g) ?? [];
  is("lib/pdf-preview.ts: one SET of its own, \"unreadable\" for PREVIEW_MARK_SECONDS", previewSets, ['["SET", problemKey(file.pathname), "unreadable", "EX", PREVIEW_MARK_SECONDS]']);
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
