/**
 * Four reads take their worst from the store's window before they read
 * anything (C4-4, 4 November 2026; owner's rule MR: a ceiling before every
 * spend, an unknown cost never zero). What is checked:
 *
 *   - the community search takes its units, a member's from the buyers'
 *     window and the creator's from the studio's, before its first read, and
 *     reads nothing when refused; each step of the one-time walk takes its
 *     own before it runs;
 *   - the walk goes a step at a time, from where it stopped, and no step
 *     moves more commands than the step's priced worst (WALK_STEP_SHAPE);
 *   - the private booking calendar takes its units before the kept file is
 *     read, and more before Stripe is read to make it again; the file holds
 *     at most CALENDAR_MAX_EVENTS events;
 *   - a product update takes its units before reading the store's sales
 *     (behaviour in tests/product-updates.test.ts);
 *   - the totals page takes each store's units before reading its numbers,
 *     the page's own store included.
 *
 * Each figure is held against its worst in tests/plan-cost-registry.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { needsWalk, readPlace, walkStep } from "@/lib/community-walk";
import { search } from "@/lib/community-search";
import { bookedCalendar, CALENDAR_MAX_EVENTS } from "@/lib/calendar-sync";
import { WALK_MEMBER_PAGE, WALK_STEP_SHAPE, searchUnits, SEARCH_DM_UNITS, SEARCH_REQUEST_UNITS, SEARCH_ROOM_UNITS } from "@/lib/read-ceilings";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
/** Where `needle` first is in `source`, failing loudly when it is not there at all. */
const at = (source: string, needle: string) => {
  const found = source.indexOf(needle);
  if (found < 0) throw new Error(`not found: ${needle}`);
  return found;
};

const CM = "walk1";
const fakeStore = { handle: "walker", community: { id: CM }, catalog: { items: [], head: [], inline: [] } } as unknown as Store;

async function main(): Promise<void> {
  part("The community search takes its worst before reading");
  const page = read("app/[handle]/community/search/page.tsx");
  const charge = at(page, "await take(searchUnits({ chat: config.chat.on, dm: config.dm.on }))");
  is("its units are taken before the walk's mark, the search, the room and the messages are read", [
    charge < at(page, "needsWalk(id)"),
    charge < at(page, "searchEverything(id, asked)"),
    charge < at(page, "searchRoom(id, used)"),
    charge < at(page, "searchMessages(id, key, used)"),
    charge < at(page, "visibleSpaces(store, config"),
  ], [true, true, true, true, true]);
  const door = read("lib/community-page.ts");
  is("a member's from the buyers' window, the creator's from the studio's", [page.includes("takeCommunityRead(store, owner, units)"), door.includes('if (!owner) return (await takePublicRequest(store, "buyer", Date.now(), units))'), door.includes("countStudio(store, null, units)")], [true, true, true]);
  is("refused, it reads nothing: the member to the resting page, the creator to the paused studio", page.includes('if (!taken.ok) redirect(owner ? studioPath(store, `why=${taken.why}`, "paused") : `/@${store.handle}/resting`);'), true);
  is("a step of the walk takes its own first, and waits when there is no room", at(page, "(await take(WALK_STEP_UNITS)).ok") < at(page, "await walkStep(store)"), true);
  is("the whole walk at once is gone", page.includes("walkCommunity"), false);
  is("the room and the messages are paid for only where they are on", [searchUnits({ chat: false, dm: false }), searchUnits({ chat: true, dm: true })], [SEARCH_REQUEST_UNITS, SEARCH_REQUEST_UNITS + SEARCH_ROOM_UNITS + SEARCH_DM_UNITS]);

  part("The one-time walk goes a step at a time");
  redis.clear();
  // Ninety listed members and one who is not: the walk reaches the directory after the courses and events, which this store has none of.
  for (let i = 0; i < 91; i += 1) {
    const k = `m${String(i).padStart(3, "0")}`;
    const listed = i < 90;
    redis.run(["HSET", `nl:cm:${CM}:m`, k, JSON.stringify({ k, e: `${k}@example.com`, n: listed ? `Walker ${k}` : "", h: listed ? `walker${k}` : "", dir: listed, at: 1_000 + i })]);
    if (listed) redis.run(["ZADD", `nl:cm:${CM}:dir`, 1_000 + i, k]);
  }
  const real = redis.pipeline;
  let commands = 0;
  let most = 0;
  redis.pipeline = async (batch) => {
    commands += batch.length;
    return real(batch);
  };
  const steps: string[] = [];
  for (let n = 0; n < 10 && (await needsWalk(CM)); n += 1) {
    commands = 0;
    await walkStep(fakeStore);
    most = Math.max(most, commands);
    steps.push(readPlace(redis.run(["GET", `nl:cm:${CM}:swat`])).stage);
  }
  redis.pipeline = real;
  is("no courses, no events, then the members a page at a time, and done", [steps.length, await needsWalk(CM)], [2 + Math.ceil(90 / WALK_MEMBER_PAGE), false]);
  is("no step moves more commands than its priced worst", most <= WALK_STEP_SHAPE.commands, true);
  is("every listed member is findable, and nobody else", [(await search(CM, "walker", null, "member")).total], [90]);
  is("a step taken while another holds the walk does nothing", await (async () => {
    redis.run(["DEL", `nl:cm:${CM}:sv`]);
    redis.run(["SET", `nl:cm:${CM}:swalk`, "1", "EX", 120]);
    return walkStep(fakeStore);
  })(), false);
  is("a place written by another version starts again", readPlace("2|m|100|40").stage, "course");

  part("The private booking calendar");
  const route = read("app/api/store/calendar/[token]/route.ts");
  is("every answer takes its units before the kept file is read", at(route, "countStudio(store, null, CALENDAR_READ_UNITS)") < at(route, "cachedBookedCalendar("), true);
  is("making it again takes more before Stripe and the listings are read", [
    at(route, "countStudio(store, null, CALENDAR_BUILD_UNITS)") < at(route, "paidCalls(store)"),
    at(route, "countStudio(store, null, CALENDAR_BUILD_UNITS)") < at(route, 'readKind(store, "call")'),
  ], [true, true]);
  is("refused, the app is told to come back and nothing more is read", [route.includes("if (error instanceof WindowSpent) return later();"), route.includes('"Retry-After": "3600"')], [true, true]);
  const start = Date.now() + 86_400_000;
  const many = Array.from({ length: CALENDAR_MAX_EVENTS + 25 }, (_, i) => ({
    session: `cs_${i}`, start: start + i * 3_600_000, end: start + i * 3_600_000 + 1_800_000, product: "p1", title: "Call", email: `b${i}@example.com`, name: null,
    buyerTz: "UTC", moves: 0, answers: [], amount: 0, currency: "usd", hosts: [], claim: "", lead: "", pi: "", due: null, cancel: null,
  }));
  const ics = bookedCalendar({ name: "Walker", handle: "walker", catalog: { items: [], head: [], inline: [] } } as unknown as Store, many as never, Date.now(), []);
  is("the file holds at most CALENDAR_MAX_EVENTS events, the soonest", [ics.split("BEGIN:VEVENT").length - 1, ics.includes(`b0@example.com`), ics.includes(`b${CALENDAR_MAX_EVENTS}@example.com`)], [CALENDAR_MAX_EVENTS, true, false]);

  part("A product update and the totals page");
  const updates = read("lib/product-updates.ts");
  is("a product update takes its units before reading the sales", at(updates, "countStudio(store, null, UPDATE_READ_UNITS)") < at(updates, "readPaidSales(store, 0, ALL_TIME_PAGES)"), true);
  const totals = read("app/studio/totals/page.tsx");
  is("each store's numbers, this page's store's too, take their units before they are read", [at(totals, "countStudio(store, null, TOTALS_STORE_UNITS)") < at(totals, "readNumbers(store)"), totals.includes("alreadyCounted")], [true, false]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
