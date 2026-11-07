/**
 * A person's deletion reads what each script answered only from a complete
 * reply (Codex G's review of #2576): a pipeline that answers fewer replies
 * than it was sent, or a reply of the wrong shape, leaves the outcome
 * unknown. Then the eraser throws (lib/person-erasure.ts reports the module
 * as incomplete), the person's record is not taken for gone, and no room is
 * given back. A confirmed empty answer is still a valid absence.
 */
import { createECDH, randomBytes } from "node:crypto";
import { forgetPushPerson, rememberDevice } from "@/lib/community-push";
import { forgetImportedPerson, grantImported, importedKey } from "@/lib/imported-purchases";
import { forgetQuizPerson, markPassed, readQuiz, saveQuiz, submitQuiz } from "@/lib/quiz";
import { forgetWaitlistPerson, joinWaitlist, setSoon } from "@/lib/waitlist";
import { addProduct, claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { dataUsed, type DataStore } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

globalThis.fetch = (async (input: string | URL | Request) =>
  new URL(String(input)).hostname === "api.resend.com" ? new Response(JSON.stringify({ id: "email_1" })) : new Response("{}", { status: 404 })) as typeof fetch;

type Pipeline = typeof redis.pipeline;
const real = redis.pipeline.bind(redis) as Pipeline;
const used = async (room: DataStore = ROOM) => (await dataUsed(room))?.used ?? 0;
const BAD: unknown[][] = [[], [undefined]];

/** Runs `erase` while every pipeline holding `script` is answered `bad` (and not applied); whether it threw. */
async function refused(script: string, bad: (commands: (string | number)[][]) => unknown[], erase: () => Promise<unknown>): Promise<boolean> {
  redis.pipeline = (async (commands: (string | number)[][]) =>
    commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith(`-- marktmorgen:${script}:`)) ? bad(commands) : real(commands)) as Pipeline;
  try {
    await erase();
    return false;
  } catch {
    return true;
  } finally {
    redis.pipeline = real;
  }
}

async function push(): Promise<void> {
  part("Community devices: an unknown reply is never taken for none");
  const ID = "cmexact";
  const ana = "a1a1a1a1a1a1";
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const device = { endpoint: "https://fcm.googleapis.com/fcm/send/exact-1", keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
  is("Ana's device", await rememberDevice(ID, ana, device, ROOM), "added");
  const before = await used();
  for (const bad of [...BAD, [{ endpoint: "x" }], [["odd"]], [[1, 2]]]) {
    is(`refused on ${JSON.stringify(bad)}`, await refused("hash-take-all", () => bad, () => forgetPushPerson(ID, ana, ROOM)), true);
    is(`no room given back on ${JSON.stringify(bad)}`, await used(), before);
  }
  is("the device is still kept", ((await real([["HLEN", `nl:cm:${ID}:ps:${ana}`]]))[0] as number) > 0, true);
  is("then deleted for real", await forgetPushPerson(ID, ana, ROOM), 1);
  is("a confirmed empty hash is none", await forgetPushPerson(ID, ana, ROOM), 0);
}

async function imported(): Promise<void> {
  part("Imported purchases: an unknown reply is never taken for none");
  const STATS = "x".repeat(16);
  await grantImported(STATS, "e".repeat(24), [{ email: "ana@example.com", productId: "prodone", items: null }], 1_700_000_000, "", ROOM);
  const before = await used();
  for (const bad of [...BAD, [[], undefined], [undefined, 0], [[], "1"]]) {
    is(`refused on ${JSON.stringify(bad)}`, await refused("hash-take-all", () => bad, () => forgetImportedPerson(STATS, "ana@example.com", ROOM)), true);
    is(`no room given back on ${JSON.stringify(bad)}`, await used(), before);
  }
  is("the grant is still kept", (await real([["HLEN", importedKey(STATS, "ana@example.com")]]))[0], 1);
  is("then deleted for real", await forgetImportedPerson(STATS, "ana@example.com", ROOM), 2);
  is("a confirmed empty hash is none", await forgetImportedPerson(STATS, "ana@example.com", ROOM), 0);
}

async function waitlist(): Promise<void> {
  part("Waitlist: an unknown reply is never taken for none");
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  await claimHandle("exact@example.com", "exactly", "Exact Kitchen", "");
  await ensureStatsId("exact@example.com");
  await ensureListId("exact@example.com");
  const made = await addProduct("exact@example.com", "The Exact Book", "", "39", null);
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail("exact@example.com"))!;
  const product = (await readListing(store, made.product.id))!;
  await setSoon(store, product.id, true);
  is("Ana joins", await joinWaitlist({ store, product, email: "ana@example.com", consent: false, clicks: false, ip: "3.3.3.3", origin: "https://marktmorgen.com" }), "sent");
  const before = await used(store);
  for (const bad of [...BAD, [1], [["a"]]]) {
    is(`refused on ${JSON.stringify(bad)}`, await refused("hash-take-field", () => bad, () => forgetWaitlistPerson(store.statsId, [product.id], "ana@example.com", store)), true);
    is(`no room given back on ${JSON.stringify(bad)}`, await used(store), before);
  }
  is("refused when one product of two has no reply", await refused("hash-take-field", () => [null], () => forgetWaitlistPerson(store.statsId, [product.id, "other1"], "ana@example.com", store)), true);
  is("her place is still kept", (await real([["HLEN", `nl:wl:${store.statsId}:${product.id}`]]))[0], 1);
  is("then deleted for real", await forgetWaitlistPerson(store.statsId, [product.id], "ana@example.com", store), 1);
  is("a confirmed missing place is none", await forgetWaitlistPerson(store.statsId, [product.id], "ana@example.com", store), 0);
}

async function quiz(): Promise<void> {
  part("Quiz: an unknown reply is never taken for none");
  const course = "q".repeat(32);
  const read = readQuiz({ passPercent: 70, required: true, attempts: 3, questions: [{ text: "Which is correct?", choices: ["Yes", "No"], correct: [0], explanation: "Yes." }] }, null);
  if (!read.ok) throw new Error(read.reason);
  const q = read.quiz;
  await saveQuiz(course, "lesson000001", q, ROOM);
  const tried = await submitQuiz(course, "lesson000001", "ana-learner", q, { [q.questions[0].id]: [1] }, "b".repeat(32), undefined, ROOM);
  is("Ana's try is kept", tried.ok, true);
  await markPassed(course, "ana-learner", "lesson000002", ROOM);
  const courses = [{ courseId: course, lessonIds: ["lesson000001", "lesson000002"] }];
  const before = await used();
  for (const bad of [...BAD, [[]], [[[], [], undefined]], [[["lesson000002"], [null, null], 3]], [[["lesson000002"], [null, null, 1, null], "3"]], [[{}, [null, null, null, null], 1]],
    // A count that contradicts the rest of the same reply, or is not a safe count (Codex G on #2576): the set and each
    // non-null value are exactly the keys the same DEL could take.
    [[["lesson000002"], [null, null, null, null], 0]], [[["lesson000002"], [null, null, null, null], 2]], [[["lesson000002"], [null, null, null, null], 99]],
    [[["lesson000002"], [null, null, null, null], 2 ** 53]], [[[], ["1", "x", null, null], 1]], [[["lesson000002"], [null, null, null, null], 1.5]]]) {
    is(`refused on ${JSON.stringify(bad)}`, await refused("set-and-values-take", () => bad, () => forgetQuizPerson(courses, "ana-learner", ROOM)), true);
    is(`no room given back on ${JSON.stringify(bad)}`, await used(), before);
  }
  is("her pass is still kept", (await real([["SISMEMBER", `nl:course:${course}:passed:ana-learner`, "lesson000002"]]))[0], 1);
  is("then deleted for real", await forgetQuizPerson(courses, "ana-learner", ROOM), 3);
  is("confirmed nothing left is none", await forgetQuizPerson(courses, "ana-learner", ROOM), 0);
}

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await push();
  await imported();
  await waitlist();
  await quiz();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
