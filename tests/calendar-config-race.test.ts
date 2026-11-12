/**
 * A calendar the creator removed stays removed, whatever else changes the
 * store's calendar settings at the same time (issue #3984).
 *
 * The settings (nl:cal:cfg:<statsId>) are one JSON value. Every change read it,
 * changed its copy and wrote the whole value back, so a change that started
 * before a removal and wrote after it put the removed calendar back: adding a
 * calendar (which reads the new one for up to FEED_TIMEOUT_MS between the read
 * and the write), a second removal, or a new subscription address. The removed
 * calendar kept blocking hours and its private address stayed stored, though
 * the studio had answered "removed". A new subscription address could be undone
 * the same way, leaving the studio showing an address whose key was deleted.
 *
 * Now every write is made only over the settings it was read as, and read again
 * and redone when they changed in between.
 *
 * Synthetic only: the Redis stub, a made-up store and a calendar answered by a
 * stream in memory (no network).
 */
import { Agent } from "node:https";
import { Duplex } from "node:stream";
import type { Store } from "@/lib/store";
import { addFeed, newFeedToken, removeFeed, storeIdForToken } from "@/lib/calendar-sync";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";

const STATS = "0123456789abcdef0123";
const STORE = { statsId: STATS, handle: "rhea-studio", callsId: null, catalog: { items: [] } } as unknown as Store;
const cfgKey = `nl:cal:cfg:${STATS}`;
const TOKEN = "a".repeat(48);
const A = { id: "1111111111111111", url: "https://calendar.example.test/one.ics", addedAt: "2026-11-01T00:00:00.000Z" };
const B = { id: "2222222222222222", url: "https://calendar.example.test/two.ics", addedAt: "2026-11-02T00:00:00.000Z" };
const kept = (feeds: unknown[], token: string | null = TOKEN) => JSON.stringify({ handle: STORE.handle, feeds, token, tokenAt: "2026-11-01T00:00:00.000Z", callsId: null });

type Settings = { feeds: { id: string; url: string }[]; token: string | null };
const settings = async (): Promise<Settings> => JSON.parse(String((await redis.pipeline([["GET", cfgKey]]))[0])) as Settings;

const ICS = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:x@example.test", "DTSTART:20991201T100000Z", "DTEND:20991201T110000Z", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");

/** A calendar that answers ICS from memory, after `meanwhile` ran: what another tab did while the calendar was read. */
function calendarAnswering(meanwhile: () => Promise<unknown>) {
  class MemoryAgent extends Agent {
    createConnection(): Duplex {
      let asked = false;
      const socket = new Duplex({
        read() {},
        write(_chunk, _encoding, callback) {
          callback();
          if (asked) return;
          asked = true;
          void meanwhile().then(() => {
            const body = Buffer.from(ICS, "utf8");
            socket.push(`HTTP/1.1 200 OK\r\nContent-Type: text/calendar\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`);
            socket.push(body);
            socket.push(null);
          });
        },
      });
      return socket;
    }
  }
  return { resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new MemoryAgent({ keepAlive: false }) };
}

async function main(): Promise<void> {
  console.error = () => {};

  part("Two removals at once");
  redis.clear();
  await redis.pipeline([["SET", cfgKey, kept([A, B])]]);
  await Promise.all([removeFeed(STORE, A.id), removeFeed(STORE, B.id)]);
  is("both calendars are gone", (await settings()).feeds.map((f) => f.id), []);

  part("A removal while another tab adds a calendar");
  redis.clear();
  await redis.pipeline([["SET", cfgKey, kept([A])]]);
  const added = await addFeed(STORE, "https://calendar.example.com/three.ics", Date.parse("2026-11-12T00:00:00Z"), calendarAnswering(() => removeFeed(STORE, A.id)));
  is("the new calendar is added", added.ok ? true : added.message, true);
  const afterAdd = await settings();
  is("the removed calendar does not come back, its address with it", [afterAdd.feeds.some((f) => f.id === A.id), afterAdd.feeds.some((f) => f.url === A.url)], [false, false]);
  is("the new calendar is the one kept", afterAdd.feeds.map((f) => f.url), ["https://calendar.example.com/three.ics"]);

  part("A new subscription address while another tab adds a calendar");
  redis.clear();
  await redis.pipeline([["SET", cfgKey, kept([A])], ["SET", "nl:cal:tok:placeholder", STATS]]);
  await newFeedToken(STORE);
  const firstToken = (await settings()).token as string;
  let rotated = "";
  const addedWhileRotating = await addFeed(STORE, "https://calendar.example.com/four.ics", Date.parse("2026-11-12T00:00:00Z"), calendarAnswering(async () => {
    await newFeedToken(STORE);
    rotated = (await settings()).token as string;
  }));
  is("the calendar is added", addedWhileRotating.ok ? true : addedWhileRotating.message, true);
  const afterRotate = await settings();
  is("the new address stays the one kept", [afterRotate.token === rotated, rotated !== firstToken], [true, true]);
  is("the address the studio shows answers", (await storeIdForToken(afterRotate.token as string))?.statsId ?? null, STATS);
  is("both calendars are kept", afterRotate.feeds.map((f) => f.id).includes(A.id), true);

  part("A new subscription address while another tab removes a calendar");
  redis.clear();
  await redis.pipeline([["SET", cfgKey, kept([A, B])], ["SET", "nl:cal:tok:placeholder", STATS]]);
  const real = redis.pipeline.bind(redis);
  let raced = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    // The removal lands between the new address's read of the settings and its write.
    if (!raced && commands[0]?.[0] === "SET" && String(commands[0][1]).startsWith("nl:cal:tok:")) {
      raced = true;
      redis.pipeline = real;
      await removeFeed(STORE, A.id);
    }
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    await newFeedToken(STORE);
  } finally {
    redis.pipeline = real;
  }
  const afterBoth = await settings();
  is("the race happened", raced, true);
  is("the removed calendar stays removed", afterBoth.feeds.map((f) => f.id), [B.id]);
  is("the new address answers", (await storeIdForToken(afterBoth.token as string))?.statsId ?? null, STATS);

  part("Settings that change before every write: nothing written, nothing left behind");
  redis.clear();
  await redis.pipeline([["SET", cfgKey, kept([A])]]);
  let turn = 1;
  const tokenSets: string[] = [];
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands[0]?.[0] === "SET" && String(commands[0][1]).startsWith("nl:cal:tok:")) tokenSets.push(String(commands[0][1]));
    // Another tab changes the settings (a new time stamp) just before each conditional write.
    if (commands[0]?.[0] === "EVAL") await real([["SET", cfgKey, kept([A], TOKEN).replace("2026-11-01T00:00:00.000Z", `2026-11-01T00:00:0${turn++ % 9 + 1}.000Z`)]]);
    return real(commands);
  }) as typeof redis.pipeline;
  let addBusy: Awaited<ReturnType<typeof addFeed>> | null = null;
  let rotateBusy = "";
  try {
    addBusy = await addFeed(STORE, "https://calendar.example.com/five.ics", Date.parse("2026-11-12T00:00:00Z"), calendarAnswering(async () => {}));
    rotateBusy = await newFeedToken(STORE).then(() => "written", (error: unknown) => (error instanceof Error ? error.message : "thrown"));
  } finally {
    redis.pipeline = real;
  }
  is("adding gives up and says so", addBusy && !addBusy.ok ? addBusy.reason : "added", "unavailable");
  is("a new address gives up and says so", rotateBusy, "Your calendar settings changed at the same time. Try again.");
  const untouched = await settings();
  is("the settings keep only what the other tab wrote", [untouched.feeds.map((f) => f.id), untouched.token], [[A.id], TOKEN]);
  is("the address made for the write that never happened is let go", [tokenSets.length, (await redis.pipeline([["GET", tokenSets[0] ?? "none"]]))[0]], [1, null]);

  done();
}

void main();
