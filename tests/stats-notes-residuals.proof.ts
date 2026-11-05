import { addNote } from "@/lib/stats-notes";
import { changeReading, reset, store } from "./stats-notes-read-world";
import { done, is, part } from "./check";

const stats = "c".repeat(32);
const key = `nl:stats:${stats}:notes`;
const now = Date.UTC(2026, 10, 5, 12);

async function attempt(text: string): Promise<boolean> {
  try { await addNote(stats, "2026-11-05", text, now); return true; } catch { return false; }
}

async function main() {
  part("Residual review case: failed post-write readings encourage a duplicate retry");
  reset();
  changeReading(() => []);
  is("first attempt reports failure", await attempt("The requested chart note"), false);
  is("first attempt already wrote the requested note", await store.pipeline([["HLEN", key]]), [1]);
  is("the same retry reports failure again", await attempt("The requested chart note"), false);
  is("a retry after reported failure must not duplicate the requested note", await store.pipeline([["HLEN", key]]), [1]);

  part("Residual review case: malformed existing history must not grow after repeated failed additions");
  reset();
  await store.pipeline([["HSET", key, "00000001", "{"]]);
  is("malformed history reports failure", await attempt("A new chart note"), false);
  is("a refused addition cannot grow the unreadable hash", await store.pipeline([["HLEN", key]]), [1]);
  done();
}
main().catch(error => { console.error(error); process.exit(1); });
