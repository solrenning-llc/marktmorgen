/** Independent focal evidence for #3011; synthetic Redis replies, no provider IO. */
import * as facts from "@/lib/course-facts";
import * as stream from "@/lib/stream";
import { streamPath } from "@/lib/stream-rules";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

type ReadLengths = (paths: string[]) => Promise<Map<string, number> | null>;
// The same proof also runs against the prior public reader without editing it.
const read = (facts as unknown as { courseVideoLengths?: ReadLengths }).courseVideoLengths
  ?? (stream as unknown as { streamLengths: ReadLengths }).streamLengths;
const folder = "0123456789abcdef0123456789abcdef";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const paths = [1, 2].map((n) => streamPath(folder, `lesson00000${n}`, id(n)));
const records = paths.map((path, i) => JSON.stringify({ id: id(i + 1), path, state: "ready", seconds: (i + 1) * 60 }));
let answer: unknown;
let calls = 0;
let traps = 0;
const original = redis.pipeline.bind(redis);
redis.pipeline = (async () => { calls++; return answer; }) as typeof redis.pipeline;

function getterList(values: unknown[]): unknown[] {
  const out = values.slice();
  Object.defineProperty(out, "0", { get() { traps++; return values[0]; } });
  return out;
}
function inheritedList(values: unknown[]): unknown[] {
  const out = values.slice();
  delete out[0];
  Object.setPrototypeOf(out, Object.assign(Object.create(Array.prototype), { 0: values[0] }));
  return out;
}
function proxied(value: unknown[]): unknown[] {
  return new Proxy(value, { get(target, key, receiver) {
    // Async mock resolution probes `then` before the product sees the reply.
    // Instrument data access separately from that Promise protocol probe.
    if (key === "then") return undefined;
    traps++;
    return Reflect.get(target, key, receiver);
  }, getOwnPropertyDescriptor(target, key) { traps++; return Reflect.getOwnPropertyDescriptor(target, key); } });
}

async function main() {
  try {
    const vectors: [string, unknown][] = [
      ["extra envelope slot", [records, records]],
      ["extra MGET slot", [[...records, records[0]]]],
      ["missing envelope slot", []],
      ["missing MGET slot", [[records[0]]]],
      ["envelope object", { 0: records, length: 1 }],
      ["MGET object", [{ 0: records[0], 1: records[1], length: 2 }]],
      ["envelope hole", new Array(1)],
      ["MGET hole", [Object.assign(new Array(2), { 1: records[1] })]],
      ["envelope inherited", inheritedList([records])],
      ["MGET inherited", [inheritedList(records)]],
      ["envelope getter", getterList([records])],
      ["MGET getter", [getterList(records)]],
      ["envelope Proxy", proxied([records])],
      ["MGET Proxy", [proxied(records)]],
      ["number record", [[records[0], 120]]],
      ["object record", [[records[0], { seconds: 120 }]]],
    ];
    for (const [name, reply] of vectors) {
      answer = reply; calls = 0; traps = 0;
      const result = await read(paths).catch(() => null);
      is(`${name}: unknown is refused`, result, null);
      is(`${name}: exactly one command`, calls, 1);
      if (/getter|Proxy/.test(name)) is(`${name}: no reply code runs`, traps, 0);
    }
    answer = Object.freeze([Object.freeze(records.slice())]);
    is("frozen exact reply retains both measurements", [...(await read(paths))!.entries()], [[paths[0], 60], [paths[1], 120]]);
    answer = [[records[0], null]];
    is("known absent record is not invented", [...(await read(paths))!.entries()], [[paths[0], 60]]);
    answer = [[records[1], records[0]]];
    is("records for the wrong paths are not believed", [...(await read(paths))!.entries()], []);
    calls = 0;
    is("no videos has a known empty map", [...(await read([]))!.entries()], []);
    is("no videos sends no command", calls, 0);
  } finally {
    redis.pipeline = original;
  }
  done();
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
