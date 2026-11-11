import { addNote, MAX_NOTES, noteText, parseNotes, readNotes } from "@/lib/stats-notes";
import { changeKeyReading, changeReading, commands, reset, store } from "./stats-notes-read-world";
import { done, is, part } from "./check";

const stats = "a".repeat(32);
const key = `nl:stats:${stats}:notes`;
const now = Date.UTC(2026, 10, 5, 12);
const value = JSON.stringify({ day: "2026-11-04", text: "Published the course" });
const pair = ["00000001", value];
function refuses(action: () => unknown): boolean {
  try { action(); return false; } catch { return true; }
}
async function refusesRead(): Promise<boolean> {
  try { await readNotes(stats); return false; } catch { return true; }
}

async function main() {
  part("A note written at the text boundary never poisons its history");
  reset();
  await store.pipeline([["HSET", key, "00000001", value, "00000002", value, "00000003", value]]);
  const boundary = "a".repeat(79) + " launch";
  let added = null;
  let addFailed = false;
  try { added = await addNote(stats, "2026-11-04", boundary, now); } catch { addFailed = true; }
  is("the real writer accepts a cut immediately after a space", [addFailed, added?.length], [false, 4]);
  let history = null;
  try { history = await readNotes(stats); } catch { /* Recorded by the assertion below. */ }
  is("the original three notes and the boundary note stay readable", history?.length, 4);
  is("new boundary notes are canonical on every normalization", [noteText(boundary), noteText(noteText(boundary))], ["a".repeat(79), "a".repeat(79)]);
  reset();
  const legacy = "a".repeat(79) + " ";
  await store.pipeline([["HSET", key, "00000001", value, "00000002", JSON.stringify({ day: "2026-11-04", text: legacy })]]);
  let legacyHistory = null;
  try { legacyHistory = await readNotes(stats); } catch { /* Recorded by the assertion below. */ }
  is("the previous writer's exact boundary form remains readable without rewriting it", legacyHistory, [{ id: "00000001", day: "2026-11-04", text: "Published the course" }, { id: "00000002", day: "2026-11-04", text: legacy }]);
  for (const text of ["Short ", "a".repeat(79) + "\t"]) {
    is("unwritten whitespace forms remain unknown: " + JSON.stringify(text), refuses(() => parseNotes(["00000001", JSON.stringify({ day: "2026-11-04", text })])), true);
  }

  part("Only complete inert chart-note records describe the stored history");
  is("confirmed empty hash stays empty", parseNotes([]), []);
  is("confirmed record stays unchanged", parseNotes(pair), [{ id: "00000001", day: "2026-11-04", text: "Published the course" }]);
  is("frozen confirmed hash remains valid", parseNotes(Object.freeze([...pair])), parseNotes(pair));
  for (const raw of [null, {}, "", ["00000001"], ["00000001", null], ["00000001", {}], ["00000001", "{"], ["00000001", "null"], ["invalid!", value], [...pair, ...pair]]) {
    is("unknown hash shape is refused: " + JSON.stringify(raw), refuses(() => parseNotes(raw)), true);
  }
  for (const stored of [{ day: "2026-02-30", text: "Impossible day" }, { day: "2026-11-04", text: 1 }, { day: "2026-11-04", text: "" }, { day: "2026-11-04", text: "x".repeat(81) }, { day: "2026-11-04", text: "Known", extra: true }, ["2026-11-04", "Known"]]) {
    is("unknown JSON schema is refused: " + JSON.stringify(stored), refuses(() => parseNotes(["00000001", JSON.stringify(stored)])), true);
  }
  let conversions = 0;
  is("a foreign value is never converted", refuses(() => parseNotes(["00000001", { toString() { conversions++; return value; } }])), true);
  is("no conversion hook ran", conversions, 0);
  let getters = 0;
  const accessor = ["00000001", value];
  Object.defineProperty(accessor, "1", { get() { getters++; return value; } });
  is("accessor hash is unknown", refuses(() => parseNotes(accessor)), true);
  is("accessor is not executed", getters, 0);
  const inherited = new Array(2);
  inherited[1] = value;
  Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 0: "00000001" }));
  is("inherited slot is unknown", refuses(() => parseNotes(inherited)), true);
  for (const stored of [
    '{"day":"2026-11-03","day":"2026-11-04","text":"Published the course"}',
    '{"day":"2026-11-04","text":"An earlier note","text":"Published the course"}',
  ]) is("duplicate JSON members cannot choose a note's history", refuses(() => parseNotes(["00000001", stored])), true);
  let proxyTraps = 0;
  const executable = new Proxy([...pair], {
    get(target, field, receiver) { proxyTraps++; return Reflect.get(target, field, receiver); },
    getOwnPropertyDescriptor(target, field) { proxyTraps++; return Reflect.getOwnPropertyDescriptor(target, field); },
  });
  is("an executable hash proxy is unknown", refuses(() => parseNotes(executable)), true);
  is("no hash proxy trap ran", proxyTraps, 0);

  part("The actual reader requires one complete response, including an empty hash");
  for (const reply of [[], [null], [[] , []], [["00000001"]]]) {
    reset();
    changeReading(() => reply);
    is("unknown pipeline is refused: " + JSON.stringify(reply), await refusesRead(), true);
  }
  reset();
  is("actual confirmed missing hash remains empty", await readNotes(stats), []);
  is("no statistics id performs no read", await readNotes(null), []);
  is("only the configured read ran", commands.length, 1);
  reset();
  let envelopeTraps = 0;
  let transportThenReads = 0;
  changeReading(() => new Proxy([[]], {
    get(target, field, receiver) {
      // Promise resolution probes "then" inside the async transport fixture,
      // before the consumer receives its result. Count that separately.
      if (field === "then") { transportThenReads++; return undefined; }
      envelopeTraps++;
      return Reflect.get(target, field, receiver);
    },
    getOwnPropertyDescriptor(target, field) { envelopeTraps++; return Reflect.getOwnPropertyDescriptor(target, field); },
  }));
  is("an executable response proxy is unknown", await refusesRead(), true);
  is("no consumer envelope proxy trap ran", envelopeTraps, 0);
  is("the transport's Promise probe is explicitly accounted for", transportThenReads, 1);

  part("An incomplete read must never authorize deletion of existing chart notes");
  const corruptions = [
    (reply: unknown[]) => [(reply[0] as string[]).slice(0, 2)],
    (reply: unknown[]) => [(reply[0] as string[]).slice(0, -1)],
    (reply: unknown[]) => { const flat = [...reply[0] as string[]]; flat[1] = "{"; return [flat]; },
    (reply: unknown[]) => [reply[0], []],
  ];
  for (let variant = 0; variant < corruptions.length; variant++) {
    reset();
    const original: (string | number)[] = ["HSET", key];
    for (let i = 0; i <= MAX_NOTES; i++) original.push(i.toString(16).padStart(8, "0"), value);
    await store.pipeline([original]);
    changeReading(corruptions[variant]);
    let refused = false;
    try { await addNote(stats, "2026-11-05", "Added during the reading", now); } catch { refused = true; }
    is(`variant ${variant}: incomplete history refuses success`, refused, true);
    is(`variant ${variant}: no cleanup is authorized`, commands.filter(c => c[0] === "HDEL").length, 0);
    const [after] = await store.pipeline([["HGETALL", key]]);
    const kept = new Map<string, string>();
    const flat = after as string[];
    for (let i = 0; i < flat.length; i += 2) kept.set(flat[i], flat[i + 1]);
    is(`variant ${variant}: every original note remains`, Array.from({ length: MAX_NOTES + 1 }, (_, i) => kept.get(i.toString(16).padStart(8, "0")) === value).every(Boolean), true);
  }

  part("A later incomplete or changed key list never authorizes cleanup");
  const keyCorruptions = [
    () => [],
    () => [null],
    (reply: unknown[]) => [(reply[0] as string[]).slice(0, -1)],
    (reply: unknown[]) => { const keys = [...reply[0] as string[]]; keys[0] = keys[1]; return [keys]; },
    (reply: unknown[]) => { const keys = [...reply[0] as string[]]; keys[0] = "ffffffff"; return [keys]; },
  ];
  for (let variant = 0; variant < keyCorruptions.length; variant++) {
    reset();
    const seed: (string | number)[] = ["HSET", key];
    for (let i = 0; i <= MAX_NOTES; i++) seed.push(i.toString(16).padStart(8, "0"), value);
    await store.pipeline([seed]);
    changeKeyReading(keyCorruptions[variant]);
    let refused = false;
    try { await addNote(stats, "2026-11-05", "Keep the history", now); } catch { refused = true; }
    is(`key variant ${variant}: unknown cleanup refuses success`, refused, true);
    is(`key variant ${variant}: no note is deleted`, commands.filter(c => c[0] === "HDEL").length, 0);
    is(`key variant ${variant}: original oldest note remains`, await store.pipeline([["HGET", key, "00000000"]]), [value]);
  }

  reset();
  const seed: (string | number)[] = ["HSET", key];
  for (let i = 0; i < MAX_NOTES; i++) seed.push(i.toString(16).padStart(8, "0"), value);
  await store.pipeline([seed]);
  const notes = await addNote(stats, "2026-11-05", "A confirmed new note", now);
  is("confirmed overflow keeps the existing count", notes?.length, MAX_NOTES);
  is("confirmed overflow keeps the requested new note", notes?.some(n => n.text === "A confirmed new note"), true);
  is("confirmed overflow removes exactly the oldest note", await store.pipeline([["HLEN", key], ["HGET", key, "00000000"]]), [MAX_NOTES, null]);
  done();
}
main().catch(error => { console.error(error); process.exit(1); });
