/**
 * Proof (review of #3057, synthetic): the calendar settings are read, a calendar is fetched (up to
 * FEED_TIMEOUT_MS), then the whole settings object read before the fetch is written back. Anything
 * written in between is lost. Local server only; no real address is reached.
 */
import type { Store } from "@/lib/store";
import { addFeed, calendarView, newFeedToken, storeIdForToken } from "@/lib/calendar-sync";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import http from "node:http";
import https from "node:https";
import net from "node:net";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";

const STATS = "0123456789abcdef0123";
const STORE = { statsId: STATS, handle: "rhea-studio", callsId: null, catalog: { items: [] } } as unknown as Store;
const cfgKey = `nl:cal:cfg:${STATS}`;
const ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//t//EN\r\nEND:VCALENDAR\r\n";

let release: () => void = () => {};
let gate = Promise.resolve();
const server = http.createServer(async (_req, res) => {
  await gate;
  res.writeHead(200, { "Content-Type": "text/calendar" });
  res.end(ICS);
});

class LocalAgent extends https.Agent {
  constructor(private port: number) { super({ keepAlive: false }); }
  createConnection(): net.Socket { return net.connect(this.port, "127.0.0.1"); }
}

async function main(): Promise<void> {
  console.error = () => {};
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as net.AddressInfo).port;
  const hooks = { resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent(port) };
  const hold = () => { gate = new Promise<void>((r) => { release = r; }); };

  part("Control: one calendar added alone is kept");
  redis.clear();
  await newFeedToken(STORE);
  const alone = await addFeed(STORE, "https://calendar.example.com/a.ics", Date.now(), hooks);
  is("added", alone.ok ? true : (alone as { message: string }).message, true);
  is("kept", (await calendarView(STORE)).feeds.length, 1);

  part("Two calendars added at the same time (two tabs)");
  redis.clear();
  await newFeedToken(STORE);
  hold();
  const one = addFeed(STORE, "https://calendar.example.com/one.ics", Date.now(), hooks);
  const two = addFeed(STORE, "https://calendar.example.com/two.ics", Date.now(), hooks);
  await new Promise((r) => setTimeout(r, 200));
  release();
  const [r1, r2] = await Promise.all([one, two]);
  is("both answered as added", [r1.ok, r2.ok], [true, true]);
  is("both are kept", (await calendarView(STORE)).feeds.length, 2);

  part("A new subscription address made while a calendar is being added");
  redis.clear();
  await newFeedToken(STORE);
  hold();
  const adding = addFeed(STORE, "https://calendar.example.com/three.ics", Date.now(), hooks);
  await new Promise((r) => setTimeout(r, 200));
  const rotated = await newFeedToken(STORE);
  const fresh = String(rotated.subscribeUrl).match(/([0-9a-f]{48})\.ics$/)?.[1] ?? "";
  release();
  is("the calendar is added", (await adding).ok, true);
  is("the new address the creator was given still answers", Boolean(await storeIdForToken(fresh)), true);
  const shown = (await calendarView(STORE)).subscribeUrl?.match(/([0-9a-f]{48})\.ics$/)?.[1] ?? "";
  is("the address the studio shows now answers", Boolean(await storeIdForToken(shown)), true);
  void cfgKey;
  server.close();
  done();
}

void main();
