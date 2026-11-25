/**
 * A file's problem note (nl:stamp:problem:) is priced for as long as it can live (Claude 5 ygH4 and iao9Ep, Claude 3
 * xvBY8 on #5360). The stamp writes it through one script that keeps an existing note's expiry and never writes over
 * the preview's "unreadable" (problemNoteCommands); the preview's second failure writes "unreadable" fresh, once a
 * mark's life, so the studio says why as long as the preview refuses the file. So one note lives at most a stamp note's
 * PROBLEM_NOTE_SECONDS, then that fresh write for PREVIEW_MARK_SECONDS. The preview's own marks live in their own key
 * (nl:preview:bad:), priced and closed for their own longest life. The data registry's parts and the closing rules
 * cover both, tied to the constants. A copy that found room again clears only the stamp's "storage" note, and a closing
 * store's traces include the preview's mark. Synthetic Redis only; no network.
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
  const rp = rules as { PREVIEW_MARK_SECONDS?: number };
  is("its longest life is a stamp note's time, then the preview's fresh unreadable", r.PROBLEM_NOTE_LONGEST_DAYS, ((r.PROBLEM_NOTE_SECONDS ?? 0) + (rp.PREVIEW_MARK_SECONDS ?? 0)) / DAY);

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

  part("A stamp note, then another stamp reason: the note ends at the first note's time");
  {
    redis.clear();
    const path = "stores/aa/prod/chain.pdf";
    await put(path, "storage");
    is("a new note takes the note's whole time", await ttl(at(path)), SECONDS);
    advance(59 * DAY * 1000);
    await put(path, "too_big");
    is("the next reason keeps the first note's expiry, and says it", [await ttl(at(path)) <= DAY, (await redis.pipeline([["GET", at(path)]]))[0]], [true, "too_big"]);
    advance(DAY * 1000);
    is("60 days after its first write the note is gone", (await redis.pipeline([["GET", at(path)]]))[0], null);
  }

  // Claude 3 xvBY8 on #5360 @6c9e98a6ab: the stamp never writes over the preview's "unreadable", which a later copy
  // that found room would then delete while the preview still refused the file.
  part("The stamp never writes over the preview's unreadable");
  {
    redis.clear();
    const path = "stores/aa/prod/locked.pdf";
    await redis.pipeline([["SET", at(path), "unreadable", "EX", 3_600]]);
    await put(path, "storage");
    is("the note still says unreadable, with its own time", [(await redis.pipeline([["GET", at(path)]]))[0], await ttl(at(path))], ["unreadable", 3_600]);
  }

  part("A copy that found room again clears only the stamp's storage note");
  const clear = (stamp as { clearStorageNote?: (pathname: string) => Promise<void> }).clearStorageNote;
  is("the clear is named (clearStorageNote)", typeof clear, "function");
  for (const [value, after] of [["storage", null], ["unreadable", "unreadable"], ["too_big", "too_big"]] as [string, string | null][]) {
    redis.clear();
    const path = `stores/aa/prod/clear-${value}.pdf`;
    await redis.pipeline([["SET", at(path), value, "EX", 3_600]]);
    if (clear) await clear(path);
    is(`a "${value}" note: ${after === null ? "cleared" : "kept"}`, (await redis.pipeline([["GET", at(path)]]))[0], after);
  }
  is("the copy that found room uses it, never a plain DEL of the note", [/clearStorageNote\(file\.pathname\)/.test(readFileSync("lib/pdf-stamp.ts", "utf8")), /\["DEL",\s*problemKey\(/.test(readFileSync("lib/pdf-stamp.ts", "utf8"))], [true, false]);

  part("A closing store's traces include the preview's own mark");
  is("deleteSalesTraces deletes previewMarkKey with the note", /keys\.push\(problemKey\(file\.pathname\), previewMarkKey\(file\.pathname\)\)/.test(readFileSync("lib/closed-store-data.ts", "utf8")), true);

  part("The script Redis runs is the one the in-memory mirror copies (no test runs the Lua itself)");
  {
    const [command] = write ? write("stores/aa/prod/script.pdf", "storage") : [[]];
    const lua = String(command[1] ?? "").split("\n");
    is("it is one EVAL on the note's key alone", [command[0], command[2], command[3]], ["EVAL", 1, stamp.problemKey("stores/aa/prod/script.pdf")]);
    is("it reads the note first", lua[1], "local now = redis.call('GET', KEYS[1])");
    is("an \"unreadable\" note is left as it is, before any write", lua[2], "if now == 'unreadable' then return 0 end");
    is(
      "a note there keeps its end, a missing one gets the full lifetime",
      lua[3],
      "if now then redis.call('SET', KEYS[1], ARGV[1], 'KEEPTTL') else redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2]) end",
    );
    is("nothing else is written", [lua.length, lua[4]], [5, "return 1"]);
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
