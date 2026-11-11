/**
 * Deleting a person (lib/person-erasure.ts) takes their form responses out
 * and gives back to the store's data room exactly what each took when it
 * was kept (lib/form-store.ts, addResponse), once.
 */
import { KEPT_RESPONSES, parseForm, type FormResponse } from "@/lib/forms";
import { addResponse, forgetFormsPerson, readResponses, writeForm } from "@/lib/form-store";
import { dataUsed, noteData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const STATS = "f".repeat(16);
const answer = (email: string, at: number, note = "Hello"): FormResponse => ({ at, page: "/apply", answers: { email1: email, note1: note }, outcome: "", joined: false });

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const used = async () => (await dataUsed(ROOM))?.used ?? 0;
  const form = parseForm({ id: "applyform1", name: "Application", fields: [{ id: "email1", type: "email", label: "Email", required: true }, { id: "note1", type: "text", label: "Note", required: false }], offerList: false })!;
  const other = parseForm({ id: "otherform1", name: "Waitlist", fields: [{ id: "email1", type: "email", label: "Email", required: true }], offerList: false })!;
  await writeForm(STATS, form);
  await writeForm(STATS, other);

  part("A deleted person's responses give their room back, exactly and once");
  await addResponse(STATS, form.id, answer("ben@example.com", 1), ROOM);
  await addResponse(STATS, other.id, answer("ben@example.com", 2), ROOM);
  const withBen = await used();
  await addResponse(STATS, form.id, answer("ana@example.com", 3, "A long note about the course and the team"), ROOM);
  await addResponse(STATS, form.id, answer("Ana@Example.com ", 4), ROOM);
  await addResponse(STATS, other.id, answer("ana@example.com", 5), ROOM);
  is("Ana's responses take room", (await used()) > withBen, true);
  is("three responses of Ana's deleted", await forgetFormsPerson(STATS, "ana@example.com", ROOM), 3);
  is("exactly their room given back", await used(), withBen);
  is("Ben's are kept", [(await readResponses(STATS, form.id)).total, (await readResponses(STATS, other.id)).total], [1, 1]);
  is("a second deletion deletes and gives back nothing", [await forgetFormsPerson(STATS, "ana@example.com", ROOM), await used()], [0, withBen]);

  part("The same response kept twice goes, and gives back, twice");
  const twice = answer("cy@example.com", 6);
  await addResponse(STATS, form.id, twice, ROOM);
  await addResponse(STATS, form.id, twice, ROOM);
  is("both deleted", await forgetFormsPerson(STATS, "cy@example.com", ROOM), 2);
  is("both given back", await used(), withBen);

  part("A deletion between a full list's read and its keep leaves the room exact");
  const full = parseForm({ id: "fullform01", name: "Full", fields: [{ id: "email1", type: "email", label: "Email", required: true }, { id: "note1", type: "text", label: "Note", required: false }], offerList: false })!;
  await writeForm(STATS, full);
  const key = `nl:form:r:${STATS}:${full.id}`;
  // A full list, its responses written directly and counted as addResponse counts them.
  const filler = Array.from({ length: KEPT_RESPONSES }, (_, i) => JSON.stringify(answer(i === 0 ? "dan@example.com" : `p${i}@example.com`, 1000 + i)));
  await redis.pipeline([["RPUSH", key, ...filler.slice().reverse()]]);
  await noteData(ROOM, [{ slot: `fr:${full.id}`, bytes: filler.reduce((sum, raw) => sum + dataBytes([raw], 1), 0) }]);
  const before = await used();
  const original = redis.pipeline;
  let raced = false;
  redis.pipeline = async (commands) => {
    if (!raced && commands[0]?.[0] === "EVAL" && String(commands[0][1]).startsWith("-- marktmorgen:form-keep:")) {
      raced = true;
      redis.pipeline = original;
      // Dan's response (the oldest, the one the keep was about to let go) is deleted in between.
      await forgetFormsPerson(STATS, "dan@example.com", ROOM);
    }
    return original.call(redis, commands);
  };
  const newest = answer("eve@example.com", 9999, "x".repeat(40));
  try {
    await addResponse(STATS, full.id, newest, ROOM);
  } finally {
    redis.pipeline = original;
  }
  is("the deletion ran in between", raced, true);
  const keptNow = (await redis.pipeline([["LRANGE", key, 0, -1]]))[0] as string[];
  const shouldBe = before - dataBytes([filler[0]], 1) + dataBytes([JSON.stringify(newest)], 1) - (keptNow.length === KEPT_RESPONSES ? 0 : 0);
  is("the list is still full, nothing else let go", keptNow.length, KEPT_RESPONSES);
  is("the room counts exactly what is kept", await used(), shouldBe);

  part("Without a room nothing is counted, and nothing breaks");
  is("Ben deleted", await forgetFormsPerson(STATS, "ben@example.com"), 2);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
