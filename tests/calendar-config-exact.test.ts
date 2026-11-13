/**
 * A store's calendar settings read in an unknown shape (rule 24) are never
 * "this store has no calendars".
 *
 * Read as none, every change that follows rewrote the settings from nothing:
 * opening the studio (ensureFeedToken), a new subscription address
 * (newFeedToken) or adding a calendar (addFeed) erased the creator's
 * calendars, and the studio showed none. Now an unknown read throws and
 * nothing is written; settings Redis confirms absent stay "none".
 *
 * Synthetic only: the Redis stub and a made-up store.
 */
import type { Store } from "@/lib/store";
import { addFeed, calendarView, ensureFeedToken, newFeedToken, removeFeed } from "@/lib/calendar-sync";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";

const STATS = "0123456789abcdef0123";
const STORE = { statsId: STATS, handle: "rhea-studio", callsId: null } as unknown as Store;
const cfgKey = `nl:cal:cfg:${STATS}`;
const TOKEN = "a".repeat(48);
const FEEDS = [
  { id: "1111111111111111", url: "https://calendar.example.test/one.ics", addedAt: "2026-11-01T00:00:00.000Z" },
  { id: "2222222222222222", url: "https://calendar.example.test/two.ics", addedAt: "2026-11-02T00:00:00.000Z" },
];
const KEPT = JSON.stringify({ handle: STORE.handle, feeds: FEEDS, token: TOKEN, tokenAt: "2026-11-01T00:00:00.000Z", callsId: null });

/** No real address is ever looked up: a calendar read fails before any request. */
const NO_NETWORK = { resolve: async () => { throw new Error("no network in tests"); } };

const real = redis.pipeline.bind(redis);
type Commands = (string | number)[][];
const writes: Commands = [];

/** Runs `body` with the settings' GET answered by `reply`; every other command runs for real. */
async function outcome<T>(reply: unknown[] | null, body: () => Promise<T>): Promise<T | "rejected"> {
  writes.length = 0;
  redis.pipeline = (async (c: Commands) => {
    for (const one of c) if (one[0] !== "GET") writes.push(one);
    return reply && c.length === 1 && c[0][0] === "GET" && c[0][1] === cfgKey ? [...reply] : real(c);
  }) as typeof redis.pipeline;
  try {
    return await body();
  } catch {
    return "rejected";
  } finally {
    redis.pipeline = real;
  }
}

const keptNow = async () => (await real([["GET", cfgKey]]))[0];

const MALFORMED: [string, unknown[]][] = [
  ["no reply", []],
  ["undefined", [undefined]],
  ["a number", [9]],
  ["an object", [{}]],
  ["two replies", [KEPT, KEPT]],
];
/** Text no writer stores: written to Redis itself, so the read is real. */
const ODD_TEXT = ["", "{", "[1]", "5", "null", '"x"', JSON.stringify({ ...JSON.parse(KEPT), feeds: { one: FEEDS[0] } })];

async function each(label: string, reply: unknown[] | null): Promise<void> {
  const changes: [string, () => Promise<unknown>][] = [
    ["opening the studio (ensureFeedToken)", () => ensureFeedToken(STORE)],
    ["a new subscription address (newFeedToken)", () => newFeedToken(STORE)],
    ["adding a calendar (addFeed)", () => addFeed(STORE, "https://calendar.example.com/three.ics", Date.now(), NO_NETWORK)],
    ["removing a calendar (removeFeed)", () => removeFeed(STORE, FEEDS[0].id)],
    ["the studio's view (calendarView)", () => calendarView(STORE)],
  ];
  for (const [what, run] of changes) {
    const before = await keptNow();
    is(`${label}: ${what} is not done on a guess`, await outcome(reply, run), "rejected");
    is(`${label}: ${what} wrote nothing, and what is kept stays`, [writes.length, await keptNow()], [0, before]);
  }
}

async function main(): Promise<void> {
  console.error = () => {};
  redis.clear();

  for (const [label, reply] of MALFORMED) {
    part(`The calendar settings answer ${label}`);
    redis.clear();
    await real([["SET", cfgKey, KEPT]]);
    await each(label, reply);
  }

  for (const text of ODD_TEXT) {
    part(`The calendar settings are kept as ${JSON.stringify(text).slice(0, 40)}`);
    redis.clear();
    await real([["SET", cfgKey, text]]);
    await each(JSON.stringify(text).slice(0, 40), null);
  }

  part("Controls");
  redis.clear();
  await real([["SET", cfgKey, KEPT]]);
  is("kept settings: the calendars are shown", (await calendarView(STORE)).feeds.map((f) => f.id), FEEDS.map((f) => f.id));
  await ensureFeedToken(STORE);
  is("kept settings: opening the studio keeps them", JSON.parse(String(await keptNow())).feeds, FEEDS);
  await newFeedToken(STORE);
  const rotated = JSON.parse(String(await keptNow())) as { feeds: unknown; token: string };
  is("a new address keeps the calendars", [rotated.feeds, rotated.token !== TOKEN], [FEEDS, true]);
  const removed = await removeFeed(STORE, FEEDS[0].id);
  is("removing one keeps the other", removed.feeds.map((f) => f.id), [FEEDS[1].id]);

  redis.clear();
  is("no settings yet: none, not an error", await calendarView(STORE), { feeds: [], subscribeUrl: null, stoppedAt: null });
  await ensureFeedToken(STORE);
  const made = JSON.parse(String(await keptNow())) as { feeds: unknown; token: string };
  is("no settings yet: opening the studio makes them, with no calendars", [made.feeds, /^[0-9a-f]{48}$/.test(made.token)], [[], true]);
  done();
}

void main();
