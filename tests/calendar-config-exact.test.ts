/**
 * A store's calendar settings (lib/calendar-sync.ts, nl:cal:cfg:<statsId>)
 * are changed only over what was read whole (review of #2882, CX-123 rule 24).
 *
 * Before: the settings were read leniently, so an answer that could not be
 * read (broken JSON, {}, [], a list of calendars that is not a list, a
 * calendar of another shape) came back as "no calendars", and the next
 * change (a new subscription address, a calendar added, the studio's first
 * look) wrote the settings again without the creator's calendars, and with
 * the old address's token lost. Two changes at once each wrote over the
 * other's read, so a calendar added, or a new address, could be lost while
 * both were answered "done".
 *
 * Now: nothing saved is an empty start; anything else that is not read whole
 * refuses the change before anything is written, and the studio says the
 * settings could not be read and nothing was changed. Each change is written
 * only over the exact text read (COMPARE_AND_SET, the script lib/webhooks.ts
 * already uses); one that lost the race writes nothing and says so.
 *
 * Synthetic only: every calendar address resolves to one public stand-in
 * address and every socket goes to a local plain server.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/calendar/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addFeed, calendarView, ensureFeedToken, newFeedToken, removeFeed, storeIdForToken } from "@/lib/calendar-sync";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { LOCKED_UNTIL_STAR_COMMANDS, TAKE_COMMANDS } from "./plan-cost-registry";
import { done, is, part } from "./check";

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Synthetic//EN",
  "BEGIN:VEVENT",
  "UID:synthetic-1@example.com",
  "DTSTART:20991201T100000Z",
  "DTEND:20991201T110000Z",
  "SUMMARY:Busy",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

/** Run once while the next calendar is being read (another change landing meanwhile), then let go. */
let whileReading: (() => Promise<unknown>) | null = null;
const server = http.createServer(async (_request, response) => {
  const run = whileReading;
  whileReading = null;
  if (run) await run().catch(() => {});
  response.writeHead(200, { "Content-Type": "text/calendar" });
  response.end(ICS);
});

class LocalAgent extends https.Agent {
  constructor(private port: number) {
    super({ keepAlive: false });
  }
  createConnection(): net.Socket {
    return net.connect(this.port, "127.0.0.1");
  }
}

type Reply = { ok?: boolean; error?: string; message?: string; view?: { feeds: unknown[] } };

async function main(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const hooks = { resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent(port) as never };

  redis.clear();
  const owner = "calendar-exact@example.com";
  await claimHandle(owner, "calendar-exact-shop", "Calendar Exact Shop", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_CalExact01", subscriptionId: "sub_CalExact01", active: true, period: paidPeriod() });
  const load = async (): Promise<Store> => (await storeForEmail(owner))!;
  const store = await load();
  const key = `nl:cal:cfg:${store.statsId}`;
  const raw = async () => (await redis.pipeline([["GET", key]]))[0];
  const set = async (value: string) => redis.pipeline([["SET", key, value]]);
  const tokenKeys = async () => (await redis.keys()).filter((k: string) => k.startsWith("nl:cal:tok:")).sort();
  const feedsSaved = async () => (JSON.parse(String(await raw())) as { feeds: unknown[] }).feeds.length;
  const outcome = async (work: () => Promise<unknown>): Promise<string> => {
    try {
      await work();
      return "done";
    } catch (error) {
      return error instanceof Error ? error.name : "thrown";
    }
  };

  part("Nothing saved yet is a legitimate empty start");
  is("no settings before", await raw(), null);
  const first = await newFeedToken(store);
  is("a first address is made", typeof first.subscribeUrl === "string" && first.subscribeUrl.endsWith(".ics"), true);
  const added = await addFeed(await load(), "https://calendar.example.com/one.ics", Date.now(), hooks);
  is("a first calendar is added after being read", [added.ok, added.ok ? added.view.feeds.length : -1], [true, 1]);
  const second = await addFeed(await load(), "https://calendar.example.com/two.ics", Date.now(), hooks);
  is("a second one beside it", [second.ok, await feedsSaved()], [true, 2]);
  const firstToken = (first.subscribeUrl ?? "").split("/").pop()!.replace(/\.ics$/, "");
  const rotated = await newFeedToken(await load());
  const rotatedToken = (rotated.subscribeUrl ?? "").split("/").pop()!.replace(/\.ics$/, "");
  is("a new address keeps both calendars", [rotated.feeds.length, await feedsSaved()], [2, 2]);
  is("the old address stops, the new one answers", [await storeIdForToken(firstToken), (await storeIdForToken(rotatedToken))?.statsId], [null, store.statsId]);

  const good = String(await raw());
  const parsed = JSON.parse(good) as { feeds: { id: string; url: string; addedAt: string }[]; token: string };

  part("Settings that cannot be read whole are never written over");
  const unreadable: [string, string][] = [
    ["broken JSON", "{broken"],
    ["an empty object", "{}"],
    ["a list", "[]"],
    ["a JSON null", "null"],
    ["a JSON string", JSON.stringify("text")],
    ["calendars that are not a list", JSON.stringify({ ...parsed, feeds: "one,two" })],
    ["calendars missing", JSON.stringify({ ...parsed, feeds: undefined })],
    ["a calendar of another shape beside a good one", JSON.stringify({ ...parsed, feeds: [parsed.feeds[0], { id: "zz", url: "" }] })],
    ["a calendar that is not an object", JSON.stringify({ ...parsed, feeds: [parsed.feeds[0], "https://calendar.example.com/x.ics"] })],
    ["more calendars than a store may read", JSON.stringify({ ...parsed, feeds: [...parsed.feeds, { ...parsed.feeds[0], id: "0123456789abcdef" }, { ...parsed.feeds[0], id: "fedcba9876543210" }] })],
    ["an address token of another shape", JSON.stringify({ ...parsed, token: 7 })],
  ];
  for (const [name, text] of unreadable) {
    await set(text);
    const tokensBefore = await tokenKeys();
    const rotate = await outcome(() => newFeedToken(store));
    const add = await outcome(() => addFeed(store, "https://calendar.example.com/three.ics", Date.now(), hooks));
    const remove = await outcome(() => removeFeed(store, parsed.feeds[0].id));
    const ensure = await outcome(() => ensureFeedToken({ ...store, handle: "calendar-exact-renamed" }));
    is(`${name}: every change refuses`, [rotate, add, remove, ensure], ["CalendarSettingsUnreadable", "CalendarSettingsUnreadable", "CalendarSettingsUnreadable", "CalendarSettingsUnreadable"]);
    is(`${name}: the settings are left exactly as they were`, await raw(), text);
    is(`${name}: no address token made or deleted`, await tokenKeys(), tokensBefore);
  }

  part("The studio says it plainly");
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const post = async (body: Record<string, unknown>) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/calendar", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Reply };
  };
  await set("{}");
  for (const body of [{ action: "rotate" }, { action: "add", url: "https://calendar.example.com/three.ics" }, { action: "remove", id: parsed.feeds[0].id }]) {
    const answer = await post(body);
    is(`${body.action}: refused with the reason`, [answer.status, answer.body.ok, answer.body.error], [503, false, "unreadable"]);
    is(`${body.action}: the words say nothing was changed`, /could not be read.*nothing was changed/i.test(answer.body.message ?? ""), true);
  }
  is("and nothing was", await raw(), "{}");

  part("Two changes at once never lose one");
  await set(good);
  // A new address is made while a calendar is being read for adding: the add was read over the old settings.
  let racedRotate: Awaited<ReturnType<typeof newFeedToken>> | null = null;
  whileReading = async () => {
    racedRotate = await newFeedToken(await load());
  };
  const racedAdd = await outcome(() => addFeed(store, "https://calendar.example.com/three.ics", Date.now(), hooks));
  const racedToken = ((racedRotate as { subscribeUrl: string | null } | null)?.subscribeUrl ?? "").split("/").pop()!.replace(/\.ics$/, "");
  is("the add that lost the race says so", racedAdd, "CalendarSettingsChanged");
  is("the address made meanwhile still answers", (await storeIdForToken(racedToken))?.statsId, store.statsId);
  is("the calendars are the two saved", await feedsSaved(), 2);

  // Two adds at once: both read two calendars; only one may land over that read.
  await set(good);
  let inner = "";
  whileReading = async () => {
    inner = await outcome(async () => {
      const result = await addFeed(await load(), "https://calendar.example.com/four.ics", Date.now(), hooks);
      if (!result.ok) throw new Error(result.reason);
    });
  };
  const outer = await outcome(async () => {
    const result = await addFeed(await load(), "https://calendar.example.com/five.ics", Date.now(), hooks);
    if (!result.ok) throw new Error(result.reason);
  });
  is("the one landed first is kept, the other says it changed", [inner, outer], ["done", "CalendarSettingsChanged"]);
  const answeredAdded = [inner, outer].filter((said) => said === "done").length;
  is("every calendar answered added is saved", await feedsSaved(), 2 + answeredAdded);
  is("the view shows them", (await calendarView(await load())).feeds.length, 2 + answeredAdded);

  part("The route says a change that lost the race plainly");
  await set(good);
  // Another change lands between the route's read of the settings and its write over them.
  const real = redis.pipeline;
  let landed = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!landed && commands.some((command) => (command[0] === "EVAL" || command[0] === "SET") && command.includes(key))) {
      landed = true;
      await real.call(redis, [["SET", key, JSON.stringify({ ...parsed, tokenAt: "changed meanwhile" })]]);
    }
    return real.call(redis, commands);
  }) as typeof redis.pipeline;
  const tokensBeforeLost = await tokenKeys();
  const lost = await post({ action: "rotate" }).finally(() => {
    redis.pipeline = real;
  });
  is("refused, nothing written over the change that landed", [lost.status, lost.body.ok, lost.body.error, JSON.parse(String(await raw())).tokenAt], [409, false, "changed", "changed meanwhile"]);
  is("the words say nothing was changed", /nothing was changed/i.test(lost.body.message ?? ""), true);
  is("no address token left behind", await tokenKeys(), tokensBeforeLost);

  part("Each change stays inside a studio request's commands");
  // UNIT_COST.studio prices a request at 20 commands besides its take and lockedUntil's: the write over the text read is
  // an EVAL that runs a GET and a SET, billed one by one (3), where a SET was 1.
  await set(good);
  const studioCommands = 20 + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS;
  const measured = async (body: Record<string, unknown>, around?: () => void) => {
    const counting = redis.pipeline;
    let commands = 0;
    redis.pipeline = (async (sent: (string | number)[][]) => {
      commands += sent.reduce((sum, command) => sum + (command[0] === "EVAL" ? 3 : 1), 0);
      return counting.call(redis, sent);
    }) as typeof redis.pipeline;
    around?.();
    try {
      return { answer: await post(body), commands };
    } finally {
      redis.pipeline = counting;
    }
  };
  const viewed = JSON.parse(String(await raw())) as { feeds: { id: string }[] };
  for (const body of [{ action: "rotate" }, { action: "remove", id: viewed.feeds[0].id }]) {
    const { answer, commands } = await measured(body);
    is(`${body.action}: done within ${studioCommands} commands`, [answer.status, commands <= studioCommands], [200, true]);
  }

  server.close();
  redis.clear();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
