/**
 * Deleting a person (lib/person-erasure.ts) gives back to the store's data
 * room what each of these modules removed of theirs, and only once: the
 * team's notes, quiz tries and passes, waitlist places, what an import or the
 * API gave them, and in the community their devices, private conversations,
 * the people they declined and their places at live events. Two deletions at
 * the same moment give it back once, because each record is read and deleted
 * in one step (lib/redis-take.ts).
 */
import { createECDH, randomBytes } from "node:crypto";
import { addPersonNote, forgetNotesPerson, readPersonNotes, removePersonNote } from "@/lib/buyer-profile";
import { forgetQuizPerson, markPassed, readQuiz, saveQuiz, submitQuiz } from "@/lib/quiz";
import { forgetImportedPerson, grantImported, importedKey } from "@/lib/imported-purchases";
import { fieldReleaseBytes } from "@/lib/order-data";
import { forgetPushPerson, rememberDevice } from "@/lib/community-push";
import { forgetRsvpsPerson, rsvp, type CommunityEvent } from "@/lib/community-events";
import { decline, forgetDmPerson, parseDmSetting, send } from "@/lib/community-dm";
import { addProduct, claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { confirmSpot, forgetWaitlistPerson, joinWaitlist, setSoon } from "@/lib/waitlist";
import { dataUsed, type DataStore } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const mailed: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (new URL(String(input)).hostname === "api.resend.com") {
    mailed.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const STATS = "s".repeat(16);
const ANA = "a".repeat(32);
const BEN = "b".repeat(32);
const used = async (room: DataStore = ROOM) => (await dataUsed(room))?.used ?? 0;
const twice = <T>(run: () => Promise<T>) => Promise.all([run(), run()]);

const device = (n: number) => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/erasure-${n}`, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
};

async function notes(): Promise<void> {
  part("Notes: what each note took comes back, once");
  await addPersonNote(STATS, BEN, "team@example.com", "Prefers calls in the morning", ROOM);
  const withBen = await used();
  await addPersonNote(STATS, ANA, "team@example.com", "Asked about the team plan", ROOM);
  await addPersonNote(STATS, ANA, "team@example.com", "Sent the invoice by hand", ROOM);
  const third = await addPersonNote(STATS, ANA, "team@example.com", "Wants a call next week", ROOM);
  // One taken off by hand first: only what is left is given back by the deletion.
  await removePersonNote(STATS, ANA, third?.[0]?.id, ROOM);
  is("Ana's notes take room", (await used()) > withBen, true);
  const [first, second] = await twice(() => forgetNotesPerson(STATS, ANA, ROOM));
  is("one deletion found them, the other nothing", [first + second], [1]);
  is("exactly Ana's room is given back", await used(), withBen);
  is("Ben's note is kept", (await readPersonNotes(STATS, BEN)).length, 1);
  is("without a room nothing breaks", await forgetNotesPerson(STATS, BEN), 1);
}

async function quiz(): Promise<void> {
  part("Quiz: tries, results and passes come back, once");
  const course = "c".repeat(32);
  const read = readQuiz({ passPercent: 70, required: true, attempts: 3, questions: [{ text: "Which is correct?", choices: ["Yes", "No"], correct: [0], explanation: "Yes." }] }, null);
  if (!read.ok) throw new Error(read.reason);
  const q = read.quiz;
  await saveQuiz(course, "lesson000001", q, ROOM);
  await submitQuiz(course, "lesson000001", "ben-learner", q, { [q.questions[0].id]: [1] }, "b".repeat(32), undefined, ROOM);
  await markPassed(course, "ben-learner", "lesson000002", ROOM);
  const before = await used();
  // A try on a fresh room slot is counted at its worst; the deletion gives back what it left, as resetTries does.
  const tried = await submitQuiz(course, "lesson000001", "ana-learner", q, { [q.questions[0].id]: [1] }, "b".repeat(32), undefined, ROOM);
  is("Ana's try is kept", tried.ok, true);
  await markPassed(course, "ana-learner", "lesson000002", ROOM);
  const kept = await redis.pipeline([
    ["GET", `nl:course:${course}:quiz:lesson000001:result:ana-learner`],
    ["GET", `nl:course:${course}:quiz:lesson000001:tries:ana-learner`],
  ]);
  const withAna = await used();
  const courses = [{ courseId: course, lessonIds: ["lesson000001", "lesson000002"] }];
  const [first, second] = await twice(() => forgetQuizPerson(courses, "ana-learner", ROOM));
  is("their three keys deleted once", [first, second].sort(), [0, 3]);
  const { dataBytes } = await import("@/lib/store-data-rules");
  const weight = (kept as string[]).reduce((sum, raw) => sum + dataBytes([String(raw)], 1), 0) + dataBytes(["lesson000002"], 1);
  is("exactly what they weigh is given back", withAna - (await used()), weight);
  is("and never past what Ana's tries took", (await used()) >= before, true);
  is("Ben's pass is kept", (await redis.pipeline([["SISMEMBER", `nl:course:${course}:passed:ben-learner`, "lesson000002"]]))[0], 1);
}

async function waitlist(): Promise<void> {
  part("Waitlist: a place and its link to leave come back, once, confirmed or not");
  process.env.RESEND_API_KEY = "re_test_erasure_room";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await ensureListId("owner@example.com");
  const made = await addProduct("owner@example.com", "The Bread Book", "", "39", null);
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, made.product.id))!;
  await setSoon(store, product.id, true);
  const join = (email: string, consent: boolean, ip: string) => joinWaitlist({ store, product, email, consent, clicks: consent, ip, origin: "https://marktmorgen.com" });
  is("Ben joins", await join("ben@example.com", false, "1.1.1.1"), "sent");
  const withBen = await used(store);
  is("Ana joins", await join("ana@example.com", false, "2.2.2.2"), "sent");
  // She confirms, then asks again with both boxes checked: each rewrite is counted as it is.
  const token = mailed.at(-1)?.match(/token=([0-9a-f]{48})/)?.[1] ?? "";
  is("Ana confirms", (await confirmSpot(token, store)).ok, true);
  is("Ana asks again", await join("ana@example.com", true, "2.2.2.2"), "sent");
  is("Ana's place takes room", (await used(store)) > withBen, true);
  const [first, second] = await twice(() => forgetWaitlistPerson(store.statsId, [product.id], "Ana@Example.com", store));
  is("one deletion took her place", [first, second].sort(), [0, 1]);
  is("exactly Ana's room is given back", await used(store), withBen);
}

async function imported(): Promise<void> {
  part("Imported purchases: what an import or the API gave comes back, once");
  const ROOM_STATS = "i".repeat(16);
  await grantImported(ROOM_STATS, "f".repeat(24), [{ email: "ben@example.com", productId: "prodben", items: null }], 1_700_000_000, "", ROOM);
  const withBen = await used();
  await grantImported(ROOM_STATS, "e".repeat(24), [{ email: "ana@example.com", productId: "prodone", items: ["itema", "itemb"] }], 1_700_000_000, "", ROOM);
  await grantImported(ROOM_STATS, "api:key123", [{ email: "ana@example.com", productId: "prodtwo", items: null }], 1_700_000_100, "", ROOM);
  is("Ana's grants take room", (await used()) > withBen, true);
  const [first, second] = await twice(() => forgetImportedPerson(ROOM_STATS, "ana@example.com", ROOM));
  is("one deletion took them", [first + second], [2]);
  is("exactly Ana's room is given back", await used(), withBen);

  part("A gift written as an order's gives back its field's own share");
  const before = await used();
  await grantImported(ROOM_STATS, "gift:abc123", [{ email: "cleo@example.com", productId: "prodgift", items: null }], 1_700_000_200, ROOM.sid);
  const withGift = await used();
  is("the gift is counted with the orders", withGift > before, true);
  const [raw] = await redis.pipeline([["HGET", importedKey(ROOM_STATS, "cleo@example.com"), "prodgift"]]);
  await forgetImportedPerson(ROOM_STATS, "cleo@example.com", ROOM);
  is("its field's share comes back", withGift - (await used()), fieldReleaseBytes("prodgift", String(raw)));
  is("never more than the gift took", (await used()) >= before, true);
}

async function community(): Promise<void> {
  const ID = "cmerase";
  const ana = "a1a1a1a1a1a1";
  const bia = "b2b2b2b2b2b2";
  const carla = "c3c3c3c3c3c3";

  part("Community devices come back, once");
  is("Bia's device", await rememberDevice(ID, bia, device(1), ROOM), "added");
  const withBia = await used();
  is("Ana's first device", await rememberDevice(ID, ana, device(2), ROOM), "added");
  is("Ana's second device", await rememberDevice(ID, ana, device(3), ROOM), "added");
  const [first, second] = await twice(() => forgetPushPerson(ID, ana, ROOM));
  is("one deletion took them", [first + second], [1]);
  is("exactly Ana's room is given back", await used(), withBia);

  part("Places at live events come back, once");
  const event = { id: "event000001", start: Date.now() + 86_400_000, minutes: 60, cap: 0, cancelled: false } as unknown as CommunityEvent;
  await redis.pipeline([["ZADD", `nl:cm:${ID}:evs`, event.start, event.id]]);
  is("Bia is coming", await rsvp(ID, event, bia, ROOM), "added");
  const withBiaPlace = await used();
  is("Ana is coming", await rsvp(ID, event, ana, ROOM), "added");
  const [one, two] = await twice(() => forgetRsvpsPerson(ID, ana, "ana@example.com", ROOM));
  is("one deletion took her place", [one, two].sort(), [0, 1]);
  is("exactly her place's room is given back", await used(), withBiaPlace);

  part("Private conversations and the people declined come back, once");
  const open = parseDmSetting({ on: true, between: true, ask: true });
  const start = await used();
  await send(ID, open, bia, carla, "Hello Carla", ROOM);
  await send(ID, open, carla, bia, "Hello Bia", ROOM);
  const withTheirs = await used();
  await send(ID, open, ana, bia, "Hello Bia, it is Ana", ROOM);
  await send(ID, open, bia, ana, "Hi Ana", ROOM);
  // Carla asks Ana, and Ana declines her: one declined person in Ana's keeping.
  const asked = await send(ID, open, carla, ana, "buy my course", ROOM);
  is("Carla's request lands", asked, { ok: true, asked: true });
  const pair = [ana, carla].sort().join(".");
  is("Ana declines it", await decline(ID, ana, pair, ROOM), true);
  is("Ana's conversation and refusal take room", (await used()) > withTheirs, true);
  await twice(() => forgetDmPerson(ID, ana, ROOM));
  is("exactly Ana's room is given back", await used(), withTheirs);
  is("Bia and Carla's conversation is kept", withTheirs > start, true);
}

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await notes();
  await quiz();
  await waitlist();
  await imported();
  await community();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
