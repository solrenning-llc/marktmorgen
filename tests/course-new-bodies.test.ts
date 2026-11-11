/**
 * 260 [KJ5], unit 3a: the lesson texts of an imported course written at once
 * (lib/course.ts, saveNewBodies). The room for all of them is taken in one
 * step before anything is written, so a store that is full gets nothing
 * written; each text is written only where no text is kept yet; anything
 * that comes back otherwise takes away what this call wrote and gives its
 * room back. Never a partial import left behind.
 */
import { MAX_BODY_LENGTH, cleanBody, emptyCourse, newItemId, readBody, saveNewBodies } from "@/lib/course";
import { DataRoomError, type DataStore, dataUsed, takeData } from "@/lib/store-data";
import { ROOM } from "./data-room";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const thrown = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
};

async function main(): Promise<void> {
  redis.clear();
  part("All texts written at once, their room taken once");
  const course = emptyCourse();
  const [a, b] = [newItemId(), newItemId()];
  const before = (await dataUsed(ROOM))!.used;
  await saveNewBodies(course.id, [{ lessonId: a, text: "Clay, water and patience." }, { lessonId: b, text: "Keep your elbows in." }], ROOM);
  is("both kept", [await readBody(course.id, a), await readBody(course.id, b)], ["Clay, water and patience.", "Keep your elbows in."]);
  is("room taken for them", (await dataUsed(ROOM))!.used > before, true);

  part("Nothing to write is nothing done");
  const used = (await dataUsed(ROOM))!.used;
  await saveNewBodies(course.id, [], ROOM);
  is("room unchanged", (await dataUsed(ROOM))!.used, used);

  part("Only text as the editor keeps it; anything else is refused before any write");
  const c = newItemId();
  for (const bad of [
    [{ lessonId: c, text: "" }],
    [{ lessonId: c, text: " padded " }],
    [{ lessonId: c, text: "x".repeat(MAX_BODY_LENGTH + 1) }],
    [{ lessonId: "NOT-AN-ID", text: "ok" }],
    [{ lessonId: c, text: "one" }, { lessonId: c, text: "two" }],
  ]) {
    is(`refused: ${JSON.stringify(bad).slice(0, 40)}`, (await thrown(() => saveNewBodies(course.id, bad, ROOM))) instanceof Error, true);
  }
  is("bad course id refused", (await thrown(() => saveNewBodies("nope", [{ lessonId: c, text: "ok" }], ROOM))) instanceof Error, true);
  is("nothing written", await readBody(course.id, c), "");
  is("cleanBody keeps a clean text as it is", cleanBody("Line one\nLine two"), "Line one\nLine two");

  part("A full store gets nothing written");
  const small: DataStore = { ...ROOM, sid: "room-small-store", tier: "free", subscriptionActive: false, subscriptionId: "" };
  const room = (await dataUsed(small))!.room;
  const filled = await takeData(small, [{ slot: "test:fill", bytes: room - 100, set: true }]);
  is("filled", filled.ok, true);
  const d = newItemId();
  const full = await thrown(() => saveNewBodies(course.id, [{ lessonId: d, text: "y".repeat(5_000) }], small));
  is("said as full", full instanceof DataRoomError, true);
  is("nothing written", await readBody(course.id, d), "");

  part("A text already kept is never written over, and this call's writes are taken back");
  const [e, f] = [newItemId(), newItemId()];
  redis.run(["SET", `nl:course:${course.id}:body:${f}`, "the creator's own"]);
  const usedBefore = (await dataUsed(ROOM))!.used;
  const clash = await thrown(() => saveNewBodies(course.id, [{ lessonId: e, text: "new one" }, { lessonId: f, text: "new two" }], ROOM));
  is("refused", clash instanceof Error, true);
  is("the kept text stays", await readBody(course.id, f), "the creator's own");
  is("this call's write taken back", await readBody(course.id, e), "");
  is("its room given back", (await dataUsed(ROOM))!.used, usedBefore);

  part("A write that comes back unknown is taken back too");
  const g = newItemId();
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    // Written for real, then a reply in no known shape.
    if (commands.some((command) => command[0] === "SET")) return (await original(commands)).map(() => "QUEUED?");
    return original(commands);
  }) as typeof redis.pipeline;
  let unknown: unknown;
  try {
    unknown = await thrown(() => saveNewBodies(course.id, [{ lessonId: g, text: "maybe" }], ROOM));
  } finally {
    redis.pipeline = original;
  }
  is("refused", unknown instanceof Error, true);
  is("nothing left", await readBody(course.id, g), "");
  is("room given back", (await dataUsed(ROOM))!.used, usedBefore);
  done();
}

void main();
