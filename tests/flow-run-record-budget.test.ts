/**
 * A run's record never holds more than the room its run is charged for (RUN_RECORD_CHARS, lib/flow-runs.ts).
 *
 * The record had 200 bytes for its fields besides the address and the note; with #4234's generation and longer
 * `open` and main's SES fields (#4246), its worst case is 230 (1,384 bytes in all, 1,354 charged), so the room charged undercounted each run
 * (Claude 3 local's LOW on #4234). RUN_RECORD_FIELDS lists every other field at its longest value; this holds the sum
 * under RUN_RECORD_CHARS, and every field name the code writes on a run's record to that list, so a new field is
 * priced or this fails.
 */
import { readFileSync } from "node:fs";
import { RUN_RECORD_CHARS, RUN_RECORD_FIELDS } from "@/lib/flow-runs";
import { done, is } from "./check";

const ADDRESS = 254, NOTE = 900;
const fields = Object.entries(RUN_RECORD_FIELDS).reduce((sum, [name, longest]) => sum + name.length + longest, 0);
const worst = "email".length + ADDRESS + "note".length + NOTE + fields;
is(`the worst record (${worst} bytes) fits the room charged (${RUN_RECORD_CHARS})`, worst <= RUN_RECORD_CHARS, true);

// Every literal field name written on a run's record (the run key in TypeScript, KEYS[1] in its scripts).
const source = readFileSync("lib/flow-runs.ts", "utf8");
const written = new Set<string>();
for (const m of source.matchAll(/redis\.call\("(?:HSET|HSETNX|HINCRBY)", KEYS\[1\],([^)]*)\)/g)) {
  for (const f of m[1].matchAll(/"([a-zA-Z]+)"\s*,/g)) written.add(f[1]);
}
for (const m of source.matchAll(/\["(?:HSET|HSETNX|HINCRBY)", run(?:Key\([^)]*\))?,([^\]]*)\]/g)) {
  const parts = m[1].split(",").map((p) => p.trim());
  for (let i = 0; i < parts.length; i += 2) {
    const name = /^"([a-zA-Z]+)"$/.exec(parts[i]);
    if (name) written.add(name[1]);
  }
}
// The two counters named through ARGV in WAIT_IF_RUN (countWaits: "waits" and "offLooks").
written.add("waits");
written.add("offLooks");
const known = new Set(["email", "note", ...Object.keys(RUN_RECORD_FIELDS)]);
is("every field the code writes on a run's record is priced", [...written].filter((f) => !known.has(f)).sort(), []);
is("and the scan found the record's fields", written.has("gen") && written.has("open") && written.has("sesAt") && written.has("status"), true);
done();
