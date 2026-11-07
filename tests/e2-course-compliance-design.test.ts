/**
 * The design for 102 [E2-COURSE-COMPLIANCE] (docs/e2-course-compliance-design.md)
 * stays coherent before any unit is built from it (Codex J's review of #3032,
 * 6 November 2026). Read from the document, because nothing of the design is
 * code yet:
 *
 * 1. The heartbeat cadence must be able to reach the required coverage at 2x
 *    playback: one beat per bucket the reported position enters, and a pace
 *    that refills one credit every `interval / 2` with a burst of 2. A
 *    simulation of exactly that protocol checks 2x passes, 3x in one pass does
 *    not, and no rate beats the bound.
 * 2. One Redis representation: every key family has one type, and every
 *    command named for it is a command of that type (SETBIT on a string, never
 *    on a hash field). Every family that holds a person is erased.
 * 3. The worst request admits every operation it promises, inside an envelope
 *    priced with the registry's own unit prices; no superseded margin figure is
 *    cited as current.
 * 4. One sequence for the units, with no "can run now" beside "nothing starts".
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";
import { request } from "./plan-cost-registry";
import { paidVideoSeconds } from "@/lib/video-admission-rules";
import { TIERS } from "@/lib/plan";

const doc = readFileSync("docs/e2-course-compliance-design.md", "utf8");
const flat = doc.replace(/\s+/g, " ");
const section = (heading: string): string => {
  const start = doc.indexOf(`\n${heading}`);
  if (start < 0) return "";
  const level = heading.match(/^#+/)?.[0] ?? "##";
  const rest = doc.slice(start + 1);
  const next = rest.slice(1).search(new RegExp(`\\n${level} `));
  return next < 0 ? rest : rest.slice(0, next + 1);
};

part("Finding 1: the cadence can reach the required coverage at 2x");
is("no wall-clock cadence (one beat per `interval` seconds of wall time cannot cover 90% at 2x)", /POSTs every `interval` seconds/.test(flat), false);
is("one beat each time the reported position enters a bucket", flat.includes("one beat each time the reported position enters a bucket"), true);
is("pace: a burst of 2, one credit every `interval / 2`", [flat.includes("burst of 2"), flat.includes("one credit every `interval / 2`")], [true, true]);
is("the worked example: 15 minutes at 2x is 60 beats in 450 seconds against 54 required", flat.includes("60 beats in 450 seconds") && flat.includes("54 required"), true);

const intervalOf = (length: number) => Math.max(15, Math.ceil(length / 960));
/** The protocol as the document states it, with each beat's network delay up to `jitter` seconds. */
function simulate(length: number, rate: number, jitter: number): { accepted: number; buckets: number; elapsed: number; interval: number } {
  const interval = intervalOf(length);
  const buckets = Math.ceil(length / interval);
  const sent: number[] = [];
  const tick = 0.25; // the player's timeupdate cadence, wall seconds
  let last = -1;
  let wall = 0;
  for (; wall * rate < length; wall += tick) {
    const bucket = Math.floor((wall * rate) / interval);
    if (bucket !== last && bucket < buckets) { sent.push(wall); last = bucket; }
  }
  let seed = 7;
  const arrivals = sent.map((t) => { seed = (seed * 1103515245 + 12345) % 2147483648; return t + (seed / 2147483648) * jitter; }).sort((a, b) => a - b);
  let credit = 2;
  let at = 0;
  let accepted = 0;
  for (const t of arrivals) {
    credit = Math.min(2, credit + (t - at) / (interval / 2));
    at = t;
    if (credit >= 1) { credit -= 1; accepted += 1; }
  }
  return { accepted, buckets, elapsed: wall, interval };
}
for (const length of [20, 900, 4 * 3600]) {
  const run = simulate(length, 2, 1);
  is(`${length} s at 2x with up to 1 s of network delay covers the 90% (${run.accepted} of ${run.buckets})`, run.accepted >= Math.ceil(0.9 * run.buckets), true);
}
const fast = simulate(900, 3, 0);
is(`15 minutes at 3x in one pass stays below the 90% (${fast.accepted} of ${fast.buckets})`, fast.accepted < Math.ceil(0.9 * fast.buckets), true);
is("no rate covers more than 2 * elapsed / interval + 2 buckets", [1, 2, 3, 10].every((rate) => { const r = simulate(900, rate, 1); return r.accepted <= (2 * (r.elapsed + 1)) / r.interval + 2; }), true);

part("Finding 2: one Redis representation, erased whole");
is("no hash per student and course holding the bitmap", /one hash per student and course/.test(flat), false);
const commandsOf: Record<string, string[]> = {
  string: ["GET", "SET", "INCR", "EXPIRE", "PEXPIRE", "SETBIT", "GETBIT", "BITCOUNT", "DEL"],
  hash: ["HGET", "HMGET", "HSET", "HINCRBY", "PEXPIRE", "EXPIRE", "DEL"],
  set: ["SADD", "SISMEMBER", "SMEMBERS", "DEL"],
};
const storage = section("### 4.2");
const families = [...storage.matchAll(/^\| `(nl:[^`]+)` \| (string|hash|set)\b[^|]*\| ([A-Z, ]+) \| (yes|no) \|/gm)].map((m) => ({ key: m[1], type: m[2], commands: m[3].split(",").map((c) => c.trim()), person: m[4] === "yes" }));
is("a key-family table with each family's type, commands and whether it holds a person", families.length >= 6, true);
is("every command is a command of its family's type", families.filter((f) => f.commands.some((c) => !commandsOf[f.type].includes(c))).map((f) => f.key), []);
is("the bitmap is one string per student and lesson, read with BITCOUNT", families.some((f) => f.key === "nl:course:<course>:watch:<lessonId>:<emailKey>" && f.type === "string" && f.commands.includes("SETBIT") && f.commands.includes("BITCOUNT")), true);
is("SETBIT only on a string", families.filter((f) => f.commands.includes("SETBIT") && f.type !== "string").map((f) => f.key), []);
const privacy = section("## 5.");
is("every family that holds a person is named in the erasure (section 5)", families.filter((f) => f.person && !privacy.includes(`\`${f.key}\``)).map((f) => f.key), []);
is("the writes are atomic scripts whose reply is read exactly; any other reply records nothing", [flat.includes("EVAL"), flat.includes("any other reply is read as not recorded")], [true, true]);

part("Finding 3: every operation admitted, priced from the registry, no superseded figure");
is("no superseded or unfrozen margin figure cited", /65\.39|66\.39|65\.67|6\.32/.test(doc), false);
const cost = section("## 4.");
const envelope = cost.match(/request\("(\w+)", (\d+), ([\d_]+)\)/);
is("an admitted envelope per heartbeat, in the registry's request() shape", envelope !== null, true);
const shape = (envelope?.[1] ?? "light") as Parameters<typeof request>[0];
const commands = Number(envelope?.[2] ?? 0);
const bytes = Number((envelope?.[3] ?? "0").replace(/_/g, ""));
const perBeat = request(shape, commands, bytes);
is(`the per-heartbeat figure is the registry's (${(perBeat * 1e6).toFixed(2)} µ$)`, flat.includes(`${(perBeat * 1e6).toFixed(2)} µ$`), true);
const admission = [...cost.matchAll(/^\| ([A-E]) \| ([^|]+) \| (\d+) \|$/gm)];
is("an admission table, step by step", admission.length >= 4, true);
is("its commands fit the envelope", admission.reduce((sum, m) => sum + Number(m[3]), 0) <= commands && commands > 0, true);
const admitted = admission.map((m) => m[2]).join(" ");
is("it admits access, course, gate, student share, per-lesson cap, data room, pace, pool, duplicate and fallback", ["access", "course", "heldBack", "student share", "per-lesson cap", "data room", "pace", "pool", "duplicate", "fallback"].filter((w) => !admitted.includes(w)), []);
is("a duplicate takes a pool unit: the pool bounds every request that reaches Redis", [flat.includes("a duplicate beat takes one pool unit"), /costs no pool after the first/.test(flat)], [true, false]);
for (const tier of TIERS) {
  const pool = (2 * paidVideoSeconds(tier)) / 15;
  is(`${tier}: pool ${pool} at ${(perBeat * 1e6).toFixed(2)} µ$ is in the table`, flat.includes(`| ${pool.toLocaleString("en-US")} | US$${(pool * perBeat).toFixed(3)} | US$${(pool * perBeat * 12).toFixed(2)} |`), true);
}

part("Finding 4: one sequence for the units");
is("no \"can run now\" beside \"nothing starts\"", [/Units 1 and 2 can run now/.test(flat), /none blocks units 1 and 2/.test(flat), /nothing below starts before their PRs merge/.test(flat)], [false, false, false]);
const units = section("## 6.");
const unit2 = units.split("\n").find((l) => l.startsWith("| 2 |")) ?? "";
is("unit 2 waits for unit 1, its reservations and a current MR model line", [unit2.includes("after unit 1 merges"), unit2.includes("reserve"), unit2.includes("MR")], [true, true, true]);
is("unit 1 is the only unit that can start now", units.includes("Only unit 1 can start now"), true);

done();
