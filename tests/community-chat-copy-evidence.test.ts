import { chatMessagesOf } from "@/lib/community-chat";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const COMMUNITY = "c".repeat(32);
const MEMBER = "a".repeat(32);
const OTHER = "b".repeat(32);
const own = JSON.stringify({ i: 1, a: MEMBER, text: "Mine", at: 123, n: "Ana" });
const other = JSON.stringify({ i: 2, a: OTHER, text: "Theirs", at: 124 });

const original: typeof redis.pipeline = redis.pipeline.bind(redis);
let calls = 0;
let commands: (string | number)[][] = [];

async function read(reply: unknown): ReturnType<typeof chatMessagesOf> {
  calls = 0;
  commands = [];
  redis.pipeline = (async (batch) => {
    calls += 1;
    commands.push(...batch);
    return reply as unknown[];
  }) as typeof redis.pipeline;
  try {
    return await chatMessagesOf(COMMUNITY, MEMBER);
  } finally {
    redis.pipeline = original;
  }
}

async function refuses(reply: unknown): Promise<boolean> {
  try {
    await read(reply);
    return false;
  } catch {
    return true;
  }
}

async function main(): Promise<void> {
  part("Confirmed room evidence");
  is("a confirmed empty room gives an empty copy", await read([[]]), []);
  is("only this member's valid message is copied", await read([[own, other]]), [{ text: "Mine", at: 123 }]);
  await read([[]]);
  is("the copy uses one existing pipeline", calls, 1);
  is("the copy asks one existing room read", commands.length, 1);
  is("the room is read by score", commands[0]?.[0], "ZRANGEBYSCORE");

  part("The pipeline envelope is evidence");
  is("a non-list response is unknown", await refuses(null), true);
  is("a missing result is unknown", await refuses([]), true);
  is("an extra result is unknown", await refuses([[], "extra"]), true);
  is("a null room is unknown", await refuses([null]), true);
  is("an object room is unknown", await refuses([{}]), true);

  part("The nested room must contain only own inert rows");
  const sparse: unknown[] = [];
  sparse.length = 1;
  is("a sparse room is unknown", await refuses([sparse]), true);
  const inherited: unknown[] = [];
  inherited.length = 1;
  Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 0: own }));
  is("an inherited row is unknown", await refuses([inherited]), true);
  let getterReads = 0;
  const getter: unknown[] = [];
  getter.length = 1;
  Object.defineProperty(getter, "0", { enumerable: true, configurable: true, get: () => { getterReads += 1; return own; } });
  is("a row getter is rejected before execution", [await refuses([getter]), getterReads], [true, 0]);
  let proxyReads = 0;
  const proxied = new Proxy([own], { get(target, key, receiver) { proxyReads += 1; return Reflect.get(target, key, receiver); } });
  is("a proxied room is rejected before its traps", [await refuses([proxied]), proxyReads], [true, 0]);
  let outerReads = 0;
  const outer: unknown[] = [];
  outer.length = 1;
  Object.defineProperty(outer, "0", { enumerable: true, configurable: true, get: () => { outerReads += 1; return [own]; } });
  is("an outer getter is rejected before execution", [await refuses(outer), outerReads], [true, 0]);

  part("Every stored row must identify whose words it holds");
  for (const [name, row] of [
    ["non-string row", 7],
    ["invalid JSON", "{"],
    ["null JSON", "null"],
    ["array JSON", "[]"],
    ["missing number", JSON.stringify({ a: MEMBER, text: "Mine", at: 123 })],
    ["fractional number", JSON.stringify({ i: 1.5, a: MEMBER, text: "Mine", at: 123 })],
    ["missing author", JSON.stringify({ i: 1, text: "Mine", at: 123 })],
    ["non-string author", JSON.stringify({ i: 1, a: 7, text: "Mine", at: 123 })],
    ["whitespace author", JSON.stringify({ i: 1, a: " ", text: "Mine", at: 123 })],
    ["impossible author", JSON.stringify({ i: 1, a: "not-a-member-key", text: "Mine", at: 123 })],
    ["missing text", JSON.stringify({ i: 1, a: MEMBER, at: 123 })],
    ["non-string text", JSON.stringify({ i: 1, a: MEMBER, text: 7, at: 123 })],
    ["missing time", JSON.stringify({ i: 1, a: MEMBER, text: "Mine" })],
    ["non-number time", JSON.stringify({ i: 1, a: MEMBER, text: "Mine", at: "123" })],
    ["invalid other member row", JSON.stringify({ i: 2, a: OTHER, text: "Theirs" })],
  ] as const) {
    is(`${name} is unknown`, await refuses([[row]]), true);
  }

  is(
    "other then member duplicate authors are unknown",
    await refuses([[`{"i":3,"a":"${OTHER}","a":"${MEMBER}","text":"Ambiguous","at":125}`]]),
    true,
  );
  is(
    "member then other duplicate authors are unknown",
    await refuses([[`{"i":4,"a":"${MEMBER}","a":"${OTHER}","text":"Ambiguous","at":126}`]]),
    true,
  );

  done();
}

void main();
