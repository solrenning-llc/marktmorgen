import { listDrafts } from "@/lib/mail-drafts";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const first = {
  id: "1111111111111111",
  subject: "First",
  body: "Content",
  productId: null,
  by: "owner@example.com",
  savedAt: "2026-10-14T00:00:00.000Z",
};
const second = {
  ...first,
  id: "2222222222222222",
  subject: "Second",
  savedAt: "2026-10-15T00:00:00.000Z",
};

type Pipeline = (commands: (string | number)[][]) => Promise<unknown[]>;

function inheritedArray<T>(length: number, entries: [number, T][]): T[] {
  const value = new Array<T>(length);
  const prototype = Object.create(Array.prototype) as Record<number, T>;
  for (const [index, item] of entries) prototype[index] = item;
  Object.setPrototypeOf(value, prototype);
  return value;
}

async function read(reply: unknown): Promise<string[] | "unavailable"> {
  const original = redis.pipeline.bind(redis) as Pipeline;
  (redis as unknown as { pipeline: Pipeline }).pipeline = async () => {
    if (reply instanceof Error) throw reply;
    return reply as unknown[];
  };
  try {
    return (await listDrafts("selected-list")).map((draft) => draft.id);
  } catch {
    return "unavailable";
  } finally {
    (redis as unknown as { pipeline: Pipeline }).pipeline = original;
  }
}

async function main(): Promise<void> {
  part("Only an exact draft hash is evidence");
  is("an exact empty hash remains empty", await read([[]]), []);
  is(
    "complete drafts remain sorted newest first",
    await read([[first.id, JSON.stringify(first), second.id, JSON.stringify(second)]]),
    [second.id, first.id],
  );
  is("a storage exception remains unavailable", await read(new Error("unavailable")), "unavailable");

  for (const [name, reply] of [
    ["a missing pipeline row", []],
    ["a non-list hash", [null]],
    ["an odd hash", [[first.id]]],
    ["a malformed saved draft", [[first.id, JSON.stringify(first), second.id, "invalid"]]],
    ["an extra pipeline row", [[first.id, JSON.stringify(first)], []]],
    ["an inherited pipeline row", inheritedArray(1, [[0, [first.id, JSON.stringify(first)]]])],
    ["inherited hash cells", [inheritedArray(2, [[0, first.id], [1, JSON.stringify(first)]])]],
  ] as [string, unknown][]) {
    is(`${name} is unavailable, never empty or partial`, await read(reply), "unavailable");
  }

  part("No list id is confirmed absence without storage");
  const original = redis.pipeline.bind(redis) as Pipeline;
  let calls = 0;
  (redis as unknown as { pipeline: Pipeline }).pipeline = async () => { calls += 1; return [[]]; };
  try {
    is("no list id remains empty", await listDrafts(null), []);
    is("no list id makes no storage call", calls, 0);
  } finally {
    (redis as unknown as { pipeline: Pipeline }).pipeline = original;
  }

  done();
}

void main();
