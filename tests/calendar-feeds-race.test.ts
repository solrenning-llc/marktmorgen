/**
 * A store's calendar settings changed by two requests at once (issue #3984).
 *
 * addFeed, removeFeed and newFeedToken each read the whole settings
 * (nl:cal:cfg:<statsId>), changed them and wrote them back whole, with no
 * check that nobody wrote in between. Two removals at once lost one; a removal
 * made while an add waited up to eight seconds on the remote calendar was
 * undone by the add's stale write, so the private address the creator asked to
 * forget stayed stored and kept blocking hours while the studio said "removed";
 * a new subscription address could be overwritten the same way.
 *
 * Expected: every change is written only over the settings it read (or only
 * while they are still absent), read again and made again on a lost race, a
 * bounded number of times; the add's remote read happens before that window.
 *
 * Synthetic only: the in-memory Redis, a made-up store, and a calendar served
 * by a local server behind a stand-in public address.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Store } from "@/lib/store";
import { CalendarChangeBusyError, addFeed, newFeedToken, removeFeed, storeIdForToken } from "@/lib/calendar-sync";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";

const STATS = "0123456789abcdef0456";
const STORE = { statsId: STATS, handle: "race-studio", callsId: null, catalog: { items: [] } } as unknown as Store;
const cfgKey = `nl:cal:cfg:${STATS}`;
const FEEDS = [
  { id: "aaaaaaaaaaaaaaaa", url: "https://calendar.example.test/a.ics", addedAt: "2026-11-01T00:00:00.000Z" },
  { id: "bbbbbbbbbbbbbbbb", url: "https://calendar.example.test/b.ics", addedAt: "2026-11-02T00:00:00.000Z" },
];
const TOKEN = "c".repeat(48);

async function seed(): Promise<void> {
  await redis.pipeline([["SET", cfgKey, JSON.stringify({ handle: STORE.handle, feeds: FEEDS, token: TOKEN, tokenAt: "2026-11-01T00:00:00.000Z", callsId: null })]]);
}
async function kept(): Promise<{ feeds: { id: string; url: string }[]; token: string | null }> {
  const [raw] = await redis.pipeline([["GET", cfgKey]]);
  return JSON.parse(String(raw)) as { feeds: { id: string; url: string }[]; token: string | null };
}

const ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//synthetic//EN\r\nEND:VCALENDAR\r\n";
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/calendar" });
  response.end(ICS);
});
/** Every request leaves on a plain socket to the local server, whatever address was checked. */
class LocalAgent extends https.Agent {
  constructor(private port: number) {
    super({ keepAlive: false });
  }
  createConnection(): net.Socket {
    return net.connect(this.port, "127.0.0.1");
  }
}

async function main(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const agent = new LocalAgent(port);

  part("two calendars removed at once");
  await seed();
  await Promise.all([removeFeed(STORE, FEEDS[0].id), removeFeed(STORE, FEEDS[1].id)]);
  is("both removals stay: no calendar is left", (await kept()).feeds.map((f) => f.id), []);

  part("a calendar removed while an add waits on the remote calendar");
  await seed();
  let started!: () => void;
  const fetching = new Promise<void>((resolve) => (started = resolve));
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const adding = addFeed(STORE, "https://calendar.example.com/c.ics", Date.now(), {
    agent,
    resolve: async () => {
      started();
      await held;
      return [{ address: "93.184.216.34", family: 4 }];
    },
  });
  // The add reaches its remote read; one that never does answers first, and the race below is not run.
  const reached = await Promise.race([fetching.then(() => true), adding.then(() => false)]);
  is("the add reaches its remote read", reached, true);
  await removeFeed(STORE, FEEDS[0].id);
  release();
  const added = await adding;
  is("the add itself went through", added.ok ? true : added.message, true);
  const after = await kept();
  is("the removed calendar stays removed", after.feeds.some((f) => f.id === FEEDS[0].id), false);
  is("the other calendar and the new one are kept", after.feeds.map((f) => f.url), [FEEDS[1].url, "https://calendar.example.com/c.ics"]);

  part("a new subscription address made while a calendar is removed");
  await seed();
  const [view] = await Promise.all([newFeedToken(STORE), removeFeed(STORE, FEEDS[1].id)]);
  const now = await kept();
  is("the removal stays", now.feeds.map((f) => f.id), [FEEDS[0].id]);
  is("the address shown is the one stored", String(view.subscribeUrl).endsWith(`/${now.token}.ics`), true);
  is("the address shown answers", Boolean(now.token && (await storeIdForToken(now.token))), true);
  is("the address before it no longer answers", await storeIdForToken(TOKEN), null);

  part("two new subscription addresses at once");
  await seed();
  const views = await Promise.all([newFeedToken(STORE), newFeedToken(STORE)]);
  const last = await kept();
  const shown = views.map((v) => String(v.subscribeUrl));
  is("the last address shown is the one stored", shown.some((url) => url.endsWith(`/${last.token}.ics`)), true);
  is("the stored address answers", Boolean(last.token && (await storeIdForToken(last.token))), true);

  part("another change wins every try: busy, and nothing is changed");
  await seed();
  const real = redis.pipeline.bind(redis);
  type Commands = (string | number)[][];
  let swaps = 0;
  let rival = 0;
  const set: string[] = [];
  // Before each of the settings' swaps, another request writes them: the swap always loses.
  const racing = (async (c: Commands) => {
    for (const one of c) if (one[0] === "SET" && String(one[1]).startsWith("nl:cal:tok:")) set.push(String(one[1]));
    if (c.length === 1 && c[0][0] === "EVAL" && String(c[0][1]).startsWith("-- marktmorgen:calendar-config-swap:v1\n")) {
      swaps += 1;
      rival += 1;
      const [raw] = await real([["GET", cfgKey]]);
      await real([["SET", cfgKey, JSON.stringify({ ...JSON.parse(String(raw)), tokenAt: `rival-${rival}` })]]);
    }
    return real(c);
  }) as typeof redis.pipeline;
  redis.pipeline = racing;
  const before = await kept();
  const removed = await removeFeed(STORE, FEEDS[0].id).catch((error: unknown) => (error instanceof CalendarChangeBusyError ? "busy" : error));
  is("a removal that never wins answers busy", removed, "busy");
  is("it tried three times, no more", swaps, 3);
  is("the calendar it could not remove is still listed, so the studio does not say it was", (await kept()).feeds.map((f) => f.id), before.feeds.map((f) => f.id));
  swaps = 0;
  const rotated = await newFeedToken(STORE).catch((error: unknown) => (error instanceof CalendarChangeBusyError ? "busy" : error));
  is("a new address that never wins answers busy", rotated, "busy");
  is("again three tries", swaps, 3);
  is("the address that was not stored was let go", set.length === 1 ? await real([["GET", set[0]]]) : set, [null]);
  is("the stored address is still the one before", (await kept()).token, TOKEN);
  swaps = 0;
  const addedBusy = await addFeed(STORE, "https://calendar.example.com/d.ics", Date.now(), {
    agent,
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  is("an add that never wins answers busy", addedBusy.ok ? "ok" : addedBusy.reason, "busy");
  is("the calendar that was not added is not listed", (await kept()).feeds.some((f) => f.url === "https://calendar.example.com/d.ics"), false);
  redis.pipeline = real;

  part("a swap answered in an unknown shape is never taken as written or as lost");
  await seed();
  redis.pipeline = (async (c: Commands) => (c.length === 1 && c[0][0] === "EVAL" ? [] : real(c))) as typeof redis.pipeline;
  let thrown = "";
  try {
    await removeFeed(STORE, FEEDS[0].id);
  } catch (error) {
    thrown = error instanceof Error ? error.name : String(error);
  }
  redis.pipeline = real;
  is("it throws (rule 24)", thrown, "UnknownReplyError");
  is("and nothing else of the calendar was deleted", (await kept()).feeds.length, 2);

  server.close();
  done();
}

void main();
