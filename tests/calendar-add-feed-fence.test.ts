/**
 * Claude 5's LOW on #4983 (7052070757): addFeed writes the new feed's first reading (nl:cal:busy, nl:cal:good) with
 * plain SETs right after changeConfig saved the feed. A removeFeed, or the store's erasure walking calendarKeys, in
 * between left the private reading kept up to STALE_SECONDS after the calendar was gone. The reading is now written
 * only while the settings still list that feed. A local HTTP server supplies the synthetic ICS; no external network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { addFeed, calendarKeys, removeFeed } from "@/lib/calendar-sync";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

const statsId = "calendar-add-feed-fence";
const store = { statsId, handle: "add-feed-fence", callsId: null, catalog: { items: [] } } as unknown as Store;
const cfgKey = `nl:cal:cfg:${statsId}`;
const now = Date.UTC(2026, 10, 20, 12);
const ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//synthetic//EN\r\nBEGIN:VEVENT\r\nUID:private\r\nDTSTART:20261120T120100Z\r\nDTEND:20261120T120200Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
class LocalAgent extends https.Agent {
  constructor(private port: number) { super({ keepAlive: false }); }
  createConnection(): net.Socket { return net.connect(this.port, "127.0.0.1"); }
}

for (const action of ["unchanged", "remove", "erased"] as const) {
  test(`a new feed's first reading after the settings changed: ${action}`, async () => {
    redis.clear();
    const server = http.createServer((_q, r) => { r.writeHead(200, { "content-type": "text/calendar" }); r.end(ics); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const agent = new LocalAgent((server.address() as net.AddressInfo).port);
    const run = redis.pipeline.bind(redis);
    let raced = false;
    let id = "";
    redis.pipeline = (async (commands) => {
      const reply = await run(commands);
      const saved = commands[0]?.[0] === "EVAL" && String(commands[0][1]).includes("marktmorgen:calendar-config-swap") && Array.isArray(reply) && reply[0] === 1;
      if (saved && !raced) {
        raced = true;
        const [raw] = await run([["GET", cfgKey]]);
        const config = JSON.parse(String(raw)) as { feeds: { id: string }[] };
        id = config.feeds[config.feeds.length - 1]!.id;
        // Between the settings saved and the first reading written: the creator removes it, or the store is erased.
        if (action === "remove") await removeFeed(store, id);
        if (action === "erased") await run([["DEL", cfgKey, ...calendarKeys(config)]]);
      }
      return reply;
    }) as typeof redis.pipeline;
    try {
      const added = await addFeed(store, "https://calendar.example.com/private.ics", now, { agent, resolve: async () => [{ address: "93.184.216.34", family: 4 }] });
      assert.equal(raced, true, "the race really happened after the settings were saved");
      assert.equal(added.ok, true);
      const kept = await run([["GET", `nl:cal:busy:${id}`], ["GET", `nl:cal:good:${id}`]]);
      if (action === "unchanged") assert.equal(typeof kept[0] === "string" && typeof kept[1] === "string", true, "control: a live feed keeps its first reading");
      else assert.deepEqual(kept, [null, null], "a removed or erased calendar's first reading is not written back");
    } finally {
      redis.pipeline = run;
      agent.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
}
