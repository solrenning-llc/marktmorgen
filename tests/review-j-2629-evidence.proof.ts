import { chatMessagesOf } from "@/lib/community-chat";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const COMMUNITY = "c".repeat(32);
const MEMBER = "a".repeat(32);
const OTHER = "b".repeat(32);
const own = JSON.stringify({ i: 1, a: MEMBER, text: "Mine", at: 123 });
const other = JSON.stringify({ i: 2, a: OTHER, text: "Theirs", at: 124 });
const original = redis.pipeline.bind(redis);

async function read(reply: unknown): Promise<{ ok: boolean; value?: unknown }> {
  redis.pipeline = (async () => reply as unknown[]) as typeof redis.pipeline;
  try {
    return { ok: true, value: await chatMessagesOf(COMMUNITY, MEMBER) };
  } catch {
    return { ok: false };
  } finally {
    redis.pipeline = original;
  }
}

async function main(): Promise<void> {
  part("Ordinary confirmed controls");
  is("an exact empty room remains known empty", await read([[]]), { ok: true, value: [] });
  is("an exact room copies only the requested member", await read([[own, other]]), { ok: true, value: [{ text: "Mine", at: 123 }] });

  part("The nested Redis array must contain only own inert rows");
  const sparse: unknown[] = [];
  sparse.length = 1;
  is("a sparse room is unknown, never an empty room", (await read([sparse])).ok, false);

  const inherited: unknown[] = [];
  inherited.length = 1;
  Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 0: own }));
  is("an inherited row cannot become copy evidence", (await read([inherited])).ok, false);

  let getterReads = 0;
  const getter: unknown[] = [];
  getter.length = 1;
  Object.defineProperty(getter, "0", { enumerable: true, configurable: true, get: () => { getterReads += 1; return own; } });
  is("a row getter is rejected before it executes", [(await read([getter])).ok, getterReads], [false, 0]);

  let proxyReads = 0;
  const proxied = new Proxy([own], { get(target, key, receiver) { proxyReads += 1; return Reflect.get(target, key, receiver); } });
  is("a proxied room is rejected before its traps execute", [(await read([proxied])).ok, proxyReads], [false, 0]);

  let outerReads = 0;
  const outer: unknown[] = [];
  outer.length = 1;
  Object.defineProperty(outer, "0", { enumerable: true, configurable: true, get: () => { outerReads += 1; return [own]; } });
  is("an outer getter is rejected before it executes", [(await read(outer)).ok, outerReads], [false, 0]);

  part("Every author must identify a possible owner of the words");
  const whitespace = JSON.stringify({ i: 3, a: " ", text: "Unowned", at: 125 });
  const impossible = JSON.stringify({ i: 4, a: "not-a-member-key", text: "Unowned", at: 126 });
  is("whitespace and impossible authors keep the copy unknown", [(await read([[whitespace]])).ok, (await read([[impossible]])).ok], [false, false]);

  done();
}

void main();
