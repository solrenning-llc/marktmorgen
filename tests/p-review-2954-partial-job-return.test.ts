/** Additive focal probe: a matching id alone is not a readable send record. */
import { createHash } from "node:crypto";
import { runEventQueue } from "@/lib/community-event-mail";
import { db, event, reset, sent, store } from "./community-mail-read-world";
import { done, is, part } from "./check";
type Command = (string | number)[];
const original = db.pipeline.bind(db);
const due = `${store.community!.id}|${store.handle}|${event.id}|24|${event.start}`;
const id = createHash("sha256").update(`${store.community!.id}|${event.id}|24|${event.start}`).digest("hex").slice(0, 24);
const key = `nl:cm:evmail:${id}`, mark = `${key}:made`;
const run = () => runEventQueue(async () => store, Date.now() + 10_000, { mail: true });
const state = () => [sent.length, db.run(["ZCARD", "nl:cm:evq"])];
const seed = () => {
  reset();
  db.run(["ZADD", "nl:cm:evq", 1, due]);
  const held = `${Date.now() - 11 * 60_000}.123456789`;
  db.run(["SET", mark, held, "EX", 2592000]);
  return held;
};
async function main(): Promise<void> {
  part("Healthy aged orphan control");
  seed();
  await run();
  is("healthy recovery sends once", state(), [1, 0]);
  part("Matching id does not prove a readable send");
  for (const value of [{ id }, { id, status: 12 }]) {
    const held = seed();
    const raw = JSON.stringify(value);
    db.pipeline = async (commands: Command[]) => {
      const result = await original(commands);
      if (commands.length === 2 && commands[0][0] === "GET" && commands[0][1] === mark) return [result[0], raw];
      return result;
    };
    try { await run(); } finally { db.pipeline = original; }
    is(`partial ${raw} keeps due without sending`, state(), [0, 1]);
    is("the underlying job really is absent", db.run(["GET", key]), null);
    is("the held mark is untouched", db.run(["GET", mark]), held);
    await run();
    is("healthy retry recovers the retained reminder once", state(), [1, 0]);
  }
  done();
}
void main();
