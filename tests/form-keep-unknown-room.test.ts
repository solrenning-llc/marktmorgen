/**
 * A form response kept at the limit, whose keep's receipt is lost after the oldest response was deleted meanwhile
 * (Codex X3's MEDIUM on #2857, confirmed by Claude 4 cloud AI): addResponse charged only the new response's bytes less
 * the oldest's, read before the keep. The deletion gave the oldest's bytes back, the keep then dropped nothing, and the
 * lost receipt kept only that charge, so the data room counted less than it held: later admissions could pass the
 * plan's room. Unknown, it must hold the most the keep can have added, the whole new response. Synthetic: the memory
 * Redis only.
 */
import { addResponse, forgetFormsPerson, writeForm, KEEP_FORM_RESPONSE } from "@/lib/form-store";
import { KEPT_RESPONSES, parseForm, type FormResponse } from "@/lib/forms";
import { dataUsed, noteData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

type Pipeline = (commands: (string | number)[][]) => Promise<unknown[]>;
const real = redis.pipeline.bind(redis) as Pipeline;
const used = async () => (await dataUsed(ROOM))?.used ?? 0;

async function main(): Promise<void> {
  redis.clear();
  const STATS = "k".repeat(16);
  const form = parseForm({ id: "keepform01", name: "Apply", fields: [{ id: "email1", type: "email", label: "Email", required: true }], offerList: false })!;
  await writeForm(STATS, form);
  const answer = (email: string, at: number): FormResponse => ({ at, page: "/apply", answers: { email1: email }, outcome: "", joined: false });
  const key = `nl:form:r:${STATS}:${form.id}`;
  // The list full, newest first: the oldest (its last) is the one a keep at the limit would let go.
  const rows = Array.from({ length: KEPT_RESPONSES }, (_, i) => JSON.stringify(answer(i === KEPT_RESPONSES - 1 ? "oldest@example.com" : `p${i}@example.com`, KEPT_RESPONSES - i)));
  await real([["RPUSH", key, ...rows]]);
  await noteData(ROOM, [{ slot: `fr:${form.id}`, bytes: rows.reduce((sum, raw) => sum + dataBytes([raw], 1), 0) }]);
  const oldestBytes = dataBytes([rows[rows.length - 1]], 1);
  const fresh = answer("new@example.com", KEPT_RESPONSES + 1);
  const freshBytes = dataBytes([JSON.stringify(fresh)], 1);
  const before = await used();

  part("At the limit: the oldest deleted meanwhile, the keep applied, its receipt lost");
  let deleted = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 1 && commands[0][0] === "EVAL" && commands[0][1] === KEEP_FORM_RESPONSE) {
      redis.pipeline = real as typeof redis.pipeline;
      // The oldest's owner is erased between the read and the keep: its bytes are given back.
      deleted = await forgetFormsPerson(STATS, "oldest@example.com", ROOM);
      await real(commands);
      return [null];
    }
    return real(commands);
  }) as typeof redis.pipeline;
  let threw = false;
  try {
    await addResponse(STATS, form.id, fresh, ROOM);
  } catch {
    threw = true;
  } finally {
    redis.pipeline = real as typeof redis.pipeline;
  }
  is("the oldest was deleted meanwhile, and the keep was said unconfirmed", [deleted, threw], [1, true]);
  const [stored] = (await real([["LLEN", key]])) as number[];
  is("the keep landed: the list holds the limit again, nothing dropped", stored, KEPT_RESPONSES);
  // What the room holds now is the full list less the oldest plus the new one: it must count at least that.
  is("the room counts at least what is held: the whole new response, never only its share past the oldest", (await used()) - before >= freshBytes - oldestBytes, true);

  // Claude 6 i51q on #2857 (LOW): the same outage that lost the receipt can refuse the very next write. The hold for the
  // whole new response must already be in place before the keep is sent (write-ahead), not written after it is lost.
  part("The same, and the next write after the lost receipt is refused too");
  const form2 = parseForm({ id: "keepform02", name: "Apply too", fields: [{ id: "email1", type: "email", label: "Email", required: true }], offerList: false })!;
  await writeForm(STATS, form2);
  const key2 = `nl:form:r:${STATS}:${form2.id}`;
  const rows2 = Array.from({ length: KEPT_RESPONSES }, (_, i) => JSON.stringify(answer(i === KEPT_RESPONSES - 1 ? "oldest2@example.com" : `q${i}@example.com`, KEPT_RESPONSES - i)));
  await real([["RPUSH", key2, ...rows2]]);
  await noteData(ROOM, [{ slot: `fr:${form2.id}`, bytes: rows2.reduce((sum, raw) => sum + dataBytes([raw], 1), 0) }]);
  const oldest2Bytes = dataBytes([rows2[rows2.length - 1]], 1);
  const fresh2 = answer("new2@example.com", KEPT_RESPONSES + 1);
  const fresh2Bytes = dataBytes([JSON.stringify(fresh2)], 1);
  const before2 = await used();
  let refusedNext = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 1 && commands[0][0] === "EVAL" && commands[0][1] === KEEP_FORM_RESPONSE) {
      await forgetFormsPerson(STATS, "oldest2@example.com", ROOM);
      await real(commands);
      // Every write after the lost receipt is refused by the same outage, once.
      redis.pipeline = (async () => {
        redis.pipeline = real as typeof redis.pipeline;
        refusedNext = true;
        throw new Error("synthetic: connection reset");
      }) as typeof redis.pipeline;
      return [null];
    }
    return real(commands);
  }) as typeof redis.pipeline;
  let threw2 = false;
  try {
    await addResponse(STATS, form2.id, fresh2, ROOM);
  } catch {
    threw2 = true;
  } finally {
    redis.pipeline = real as typeof redis.pipeline;
  }
  is("the keep was said unconfirmed", threw2, true);
  is("nothing needs writing once the receipt is lost: the next write is never attempted", refusedNext, false);
  is("the room still counts at least what is held", (await used()) - before2 >= fresh2Bytes - oldest2Bytes, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
