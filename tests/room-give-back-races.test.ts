/**
 * What goes back to a store's data room when a waitlist place, a quiz try, an
 * event place or an API grant goes, beside a deletion of the person running
 * at the same moment: each record is written or deleted only as it was read
 * (lib/redis-take.ts), so it is never made again after a deletion and its
 * room is never counted or given back twice. Also the ways out that gave
 * nothing back before: leaving a waitlist, a launch, the API taking back
 * what it gave.
 *
 * The races are made exact by running the other side right after the first
 * side's read, through the stand-in Redis.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, renameHandle, storeForEmail, storeForHandle, HANDLE_PATTERN } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { LONGEST_HANDLE, confirmSpot, forgetWaitlistPerson, joinWaitlist, launch, leaveWaitlist, runLaunches, setSoon } from "@/lib/waitlist";
import { forgetQuizPerson, readQuiz, resetTries, saveQuiz, submitQuiz } from "@/lib/quiz";
import type { Course } from "@/lib/course";
import { forgetRsvpsPerson, rsvp, type CommunityEvent } from "@/lib/community-events";
import { forgetImportedPerson, grantImported, takeGiven } from "@/lib/imported-purchases";
import { dataUsed, type DataStore } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const mailed: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com" && url.pathname === "/emails/batch") return new Response(JSON.stringify({ data: [] }));
  if (url.hostname === "api.resend.com") {
    mailed.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

type Commands = (string | number)[][];
const original = redis.pipeline.bind(redis);
let hook: { when: (commands: Commands) => boolean; run: () => Promise<unknown> } | null = null;
/** Runs `run` once, right after the first pipeline `when` picks has been answered. */
const after = (when: (commands: Commands) => boolean, run: () => Promise<unknown>) => {
  hook = { when, run };
};
redis.pipeline = (async (commands: Commands) => {
  const out = await original(commands);
  const h = hook;
  if (h && h.when(commands)) {
    hook = null;
    await h.run();
  }
  return out;
}) as typeof redis.pipeline;
const reads = (name: string, key: string) => (commands: Commands) => commands.some((c) => c[0] === name && String(c[1]).includes(key));

const used = async (room: DataStore = ROOM) => (await dataUsed(room))?.used ?? 0;
const lastToken = (kind: "token" | "leave") => mailed.at(-1)?.match(new RegExp(`${kind}=([0-9a-f]{48})`))?.[1] ?? "";

async function waitlists(): Promise<void> {
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await ensureListId("owner@example.com");
  const product = async (title: string) => {
    const made = await addProduct("owner@example.com", title, "", "39", null);
    if (!made.ok) throw new Error("no product");
    const store = (await storeForEmail("owner@example.com"))!;
    const listing = (await readListing(store, made.product.id))!;
    await setSoon(store, listing.id, true);
    return listing;
  };
  const one = await product("The Bread Book");
  let store = (await storeForEmail("owner@example.com"))!;
  let ip = 1;
  const join = (email: string, p = one, consent = false) => joinWaitlist({ store, product: p, email, consent, clicks: consent, ip: `10.0.0.${ip++}`, origin: "https://marktmorgen.com" });
  const listKey = `nl:wl:${store.statsId}:${one.id}`;
  const exists = async (email: string) => (await redis.pipeline([["HEXISTS", listKey, email]]))[0];

  is("Ben joins", await join("ben@example.com"), "sent");
  const base = await used(store);
  const [benRaw] = await redis.pipeline([["HGET", listKey, "ben@example.com"]]);
  // An address whose place, once confirmed, weighs one step more: so counting its growth twice would show.
  const length = String(benRaw).length;
  const pad = Array.from({ length: 16 }, (_, n) => n).find((n) => {
    const e = `dana${"x".repeat(n)}@example.com`.length;
    return Math.ceil((128 + e + length) / 16) < Math.ceil((128 + e + length + 9) / 16);
  })!;
  const dana = `dana${"x".repeat(pad)}@example.com`;

  part("A place confirmed while its person is deleted is not made again");
  is("Ana joins", await join("ana@example.com"), "sent");
  const anaToken = lastToken("token");
  after(reads("HGET", listKey), () => forgetWaitlistPerson(store.statsId, [one.id], "ana@example.com", store));
  is("the confirmation finds the place gone", (await confirmSpot(anaToken, store)).ok, false);
  is("and does not make it again", await exists("ana@example.com"), 0);
  is("her room came back once", await used(store), base);

  part("Two presses of the confirm button count its growth once");
  is("Dana joins", await join(dana), "sent");
  const danaToken = lastToken("token");
  const [before] = await redis.pipeline([["HGET", listKey, dana]]);
  const joined = await used(store);
  after(reads("HGET", listKey), () => confirmSpot(danaToken, store));
  is("the outer press answers yes", (await confirmSpot(danaToken, store)).ok, true);
  const [confirmed] = await redis.pipeline([["HGET", listKey, dana]]);
  is("its growth is a step here", dataBytes([dana, String(confirmed)], 1) - dataBytes([dana, String(before)], 1), 16);
  is("counted once", (await used(store)) - joined, 16);
  await forgetWaitlistPerson(store.statsId, [one.id], dana, store);
  is("and given back whole", await used(store), base);

  part("Asking again while the person is deleted does not make the place again");
  is("Cleo joins", await join("cleo@example.com"), "sent");
  after(reads("HGET", listKey), () => forgetWaitlistPerson(store.statsId, [one.id], "cleo@example.com", store));
  is("asking again is refused", await join("cleo@example.com", one, true), "error");
  is("the place is not made again", await exists("cleo@example.com"), 0);
  is("her room came back once", await used(store), base);

  part("Leaving gives the place back, once");
  is("Eve joins", await join("eve@example.com"), "sent");
  const leave = lastToken("leave");
  // Both read the link before either takes the place.
  after((commands) => commands.some((c) => c[0] === "GET" && String(c[1]).includes(leave)), () => leaveWaitlist(leave, store));
  is("she leaves", await leaveWaitlist(leave, store), true);
  is("her place is gone", await exists("eve@example.com"), 0);
  is("her room came back once", await used(store), base);

  part("A launch with nobody confirmed gives the waitlist back");
  const two = await product("The Cake Book");
  store = (await storeForEmail("owner@example.com"))!;
  const beforeTwo = await used(store);
  is("Finn joins", await join("finn@example.com", two), "sent");
  is("launched, nobody to email", await launch(store, two, { note: "", address: "" }), { ok: true, total: 0 });
  is("the waitlist's room came back", await used(store), beforeTwo);

  part("A launch that emailed everyone gives the waitlist back when it is done");
  const three = await product("The Pie Book");
  store = (await storeForEmail("owner@example.com"))!;
  const beforeThree = await used(store);
  is("Gus joins", await join("gus@example.com", three), "sent");
  is("Gus confirms", (await confirmSpot(lastToken("token"), store)).ok, true);
  is("Hana joins and does not confirm", await join("hana@example.com", three), "sent");
  is("launched to one", await launch(store, three, { note: "Out now.", address: "1 Main St, Springfield" }), { ok: true, total: 1 });
  await runLaunches(storeForHandle, readListing, Date.now() + 10_000);
  is("the waitlist's room came back", await used(store), beforeThree);

  part("A store renamed afterwards gets back exactly what a place took");
  is("the longest handle is the pattern's", [HANDLE_PATTERN.test("a".repeat(LONGEST_HANDLE)), HANDLE_PATTERN.test("a".repeat(LONGEST_HANDLE + 1))], [true, false]);
  const beforeIvy = await used(store);
  is("Ivy joins", await join("ivy@example.com"), "sent");
  const took = (await used(store)) - beforeIvy;
  is("renamed to the longest handle", (await renameHandle("owner@example.com", "harbor-kitchen-and-bread")).ok, true);
  store = (await storeForEmail("owner@example.com"))!;
  is("the new handle is the longest", store.handle.length, LONGEST_HANDLE);
  const renamed = await used(store);
  await forgetWaitlistPerson(store.statsId, [one.id], "ivy@example.com", store);
  is("exactly what she took came back", renamed - (await used(store)), took);
}

async function quiz(): Promise<void> {
  part("Tries reset while the student is deleted come back once");
  const courseId = "q".repeat(32);
  const read = readQuiz({ passPercent: 70, required: true, attempts: 3, questions: [{ text: "Which is correct?", choices: ["Yes", "No"], correct: [0], explanation: "Yes." }] }, null);
  if (!read.ok) throw new Error(read.reason);
  const q = read.quiz;
  await saveQuiz(courseId, "lesson000001", q, ROOM);
  await submitQuiz(courseId, "lesson000001", "ben-race", q, { [q.questions[0].id]: [1] }, "b".repeat(32), undefined, ROOM);
  await submitQuiz(courseId, "lesson000001", "ana-race", q, { [q.questions[0].id]: [1] }, "b".repeat(32), undefined, ROOM);
  const [result, tries] = await redis.pipeline([
    ["GET", `nl:course:${courseId}:quiz:lesson000001:result:ana-race`],
    ["GET", `nl:course:${courseId}:quiz:lesson000001:tries:ana-race`],
  ]);
  const weight = dataBytes([String(result)], 1) + dataBytes([String(tries)], 1);
  const withAna = await used();
  const course = { id: courseId, modules: [{ id: "module000001", lessons: [{ id: "lesson000001", quiz: q }] }] } as unknown as Course;
  after((commands) => commands.some((c) => (c[0] === "GET" || c[0] === "GETDEL") && String(c[1]).includes(":result:ana-race")), () => forgetQuizPerson([{ courseId, lessonIds: ["lesson000001"] }], "ana-race", ROOM));
  await resetTries(course, "ana-race", ROOM);
  is("what her tries weighed came back once", withAna - (await used()), weight);
}

async function events(): Promise<void> {
  part("A place over the cap taken back while its member is deleted comes back once");
  const ID = "cmrace";
  const event = { id: "event000002", start: Date.now() + 86_400_000, minutes: 60, cap: 1, cancelled: false } as unknown as CommunityEvent;
  await redis.pipeline([["ZADD", `nl:cm:${ID}:evs`, event.start, event.id]]);
  is("Bia takes the one place", await rsvp(ID, event, "b2b2b2b2b2b2", ROOM), "added");
  const withBia = await used();
  after(reads("HSETNX", `:ev:${event.id}:r`), () => forgetRsvpsPerson(ID, "a1a1a1a1a1a1", "ana@example.com", ROOM));
  is("Ana finds it full", await rsvp(ID, event, "a1a1a1a1a1a1", ROOM), "full");
  is("her place's room came back once", await used(), withBia);
}

async function api(): Promise<void> {
  part("What the API gave and takes back comes back, once");
  const STATS = "t".repeat(16);
  const before = await used();
  await grantImported(STATS, "api:key123", [{ email: "ana@example.com", productId: "prodapi", items: null }], 1_700_000_000, "", ROOM);
  is("the grant takes room", (await used()) > before, true);
  after(reads("HGET", "nl:imp:buy:"), () => forgetImportedPerson(STATS, "ana@example.com", ROOM));
  is("taken back beside a deletion: the deletion had it", await takeGiven(STATS, "ana@example.com", "prodapi", "api:", ROOM), false);
  is("its room came back once", await used(), before);
  await grantImported(STATS, "api:key123", [{ email: "ben@example.com", productId: "prodapi", items: ["itema"] }], 1_700_000_000, "", ROOM);
  const [first, second] = await Promise.all([takeGiven(STATS, "ben@example.com", "prodapi", "api:", ROOM), takeGiven(STATS, "ben@example.com", "prodapi", "api:", ROOM)]);
  is("two takes at once: one took it", [first, second].filter(Boolean).length, 1);
  is("and its room came back once", await used(), before);
}

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.RESEND_API_KEY = "re_test_room_races";
  await waitlists();
  await quiz();
  await events();
  await api();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
