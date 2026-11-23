/**
 * #5010 rows 54, 55 and 56 (Codex L-20261121-0242, -0338 and -0431, HIGH) and row 150 (b): a team host's calendar
 * settings are the person's across stores, but each change is authorized by one store, and addHostIcs,
 * setHostCalendars and removeHostIcs each wait (on the private calendar, on Google's calendar list, on their own read)
 * before they write. The last store's closing walk deletes hostCalendarKeys(host) meanwhile; a plain SET then wrote
 * the sealed private iCal address, the busy times, the Google calendar ids and the address back after the walk.
 * Now each writes in one EVAL fenced on the store that asked (lib/host-calendar.ts, HOST_CONFIG_IF_STORE_LIVE).
 *
 * For each: the erasure lands inside the wait (its erasing mark set and its id key deleted, the four calendar keys
 * gone), the erasing mark alone, the id key moved to another ref; nothing is written back and nobody is told it was.
 * Controls on a live store keep the old behaviour. Then the whole route of ics-add and check is measured against one
 * integration unit (coordinator 964c, row 150 (b)).
 *
 * Synthetic store, the in-memory Redis, a fake calendar (tests/host-calendar-late-refresh-world.ts) and a fake Google;
 * nothing real is called.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/host-calendar/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addHostIcs, hostCalendarKeys, removeHostIcs, setHostCalendars } from "@/lib/host-calendar";
import { hostId } from "@/lib/host-claims";
import { beginConsent, finishConsent, takeConsent } from "@/lib/meet-connect";
import { GOOGLE_HOST_SCOPES } from "@/lib/meet-providers";
import { seal } from "@/lib/secret-box";
import { ERASING_KEY, type Store, claimHandle, ensureStatsId, ensureStoreId, erasingField, setSubscription, storeForEmail, storeIdCommand, storeRef } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { HOST_CALENDAR_ROUTE_EXTRA_COMMANDS, TAKE_COMMANDS } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { state } from "./host-calendar-late-refresh-world";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id.apps.googleusercontent.com";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "secret-for-tests";
process.env.GOOGLE_API_BASE = "http://127.0.0.1:9";
process.env.GOOGLE_CALENDAR_SYNC_SCOPES = "1";

const OWNER = "fenced-host@example.com";
const HOST = hostId(OWNER);
const [CFG, GOOD, ERR] = hostCalendarKeys(HOST);
const ICS = "https://calendar.example.com/private-fenced.ics";
const ORIGIN = "https://marktmorgen.com";

/** What happens while Google lists the host's calendars (setHostCalendars's wait). */
let duringList: () => Promise<void> = async () => {};
function idToken(email: string): string {
  const part64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${part64({ alg: "none" })}.${part64({ iss: "https://accounts.google.com", aud: "client-id.apps.googleusercontent.com", exp: Math.floor(Date.now() / 1000) + 3600, sub: `sub-${email}`, email, email_verified: true })}.sig`;
}
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.pathname === "/google/token") return answer({ access_token: "at-host", refresh_token: "rt-host", expires_in: 3600, scope: GOOGLE_HOST_SCOPES.join(" "), id_token: idToken(OWNER) });
  if (url.pathname === "/google/calendar/v3/users/me/calendarList") {
    await duringList();
    return answer({ items: [{ id: OWNER, summary: "Mine", primary: true, accessRole: "owner" }, { id: "team@group.calendar.google.com", summary: "Team", accessRole: "writer" }] });
  }
  throw new Error(`Unexpected external request in a synthetic test: ${url.href}`);
}) as typeof fetch;

type Erasure = "erased" | "erasing" | "moved";
/** What the closing walk leaves when it reaches the store during the wait: by `how`. */
async function erase(shop: Store, how: Erasure): Promise<void> {
  const field = await erasingField(storeRef(shop));
  const idKey = storeIdCommand(shop.sid)[1];
  if (how === "erasing") await redis.pipeline([["HSET", ERASING_KEY, field, String(Date.now())]]);
  if (how === "erased") await redis.pipeline([["HSET", ERASING_KEY, field, String(Date.now())], ["DEL", idKey, ...hostCalendarKeys(HOST)]]);
  // moveAccount repoints the id key to the new ref: a fence built under the old one must not write.
  if (how === "moved") await redis.pipeline([["SET", idKey, "someone-else@example.test"]]);
}

async function shopWithHost(): Promise<Store> {
  redis.clear();
  state.fails = false;
  state.during = async () => {};
  duringList = async () => {};
  await claimHandle(OWNER, "fencedhostshop", "Fenced host", "");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  return (await storeForEmail(OWNER))!;
}

const cfg = async () => (await redis.pipeline([["GET", CFG]]))[0] as string | null;
const readings = async () => redis.pipeline([["GET", GOOD], ["GET", ERR]]);
const seedIcs = () => redis.pipeline([
  ["SET", CFG, JSON.stringify({ email: OWNER, source: "ics", read: ["private-google-calendar-id"], write: "private-write-calendar-id", ics: seal(ICS, `hostcal|${HOST}|ics`), icsAddedAt: "2026-11-20T00:00:00.000Z" })],
  ["SET", GOOD, JSON.stringify({ at: Date.now(), busy: [[1, 2]], source: "ics" }), "EX", 600],
  ["SET", ERR, JSON.stringify({ at: Date.now(), message: "synthetic" }), "EX", 600],
]);

async function connectGoogle(shop: Store): Promise<void> {
  const session = await openSession(OWNER);
  const url = await beginConsent("google", { statsId: shop.statsId!, sid: shop.sid!, sessionCookie: session, email: OWNER, host: HOST, scopes: GOOGLE_HOST_SCOPES });
  const taken = await takeConsent("google", new URL(url).searchParams.get("state") ?? "", { sessionCookie: session, email: OWNER });
  assert.ok(taken, "consent taken");
  const done = await finishConsent("google", { statsId: taken.statsId, code: "good", verifier: taken.verifier, by: OWNER, owner: { email: shop.email, handle: shop.handle }, host: taken.host, startedAt: taken.at });
  assert.equal(done.ok, true, "the host's Google Calendar is connected");
}

// ---- Row 54: addHostIcs ------------------------------------------------------------------------------------------

for (const how of ["erased", "erasing", "moved"] as const) {
  test(`row 54: addHostIcs with the store ${how} while the private calendar is read writes nothing back`, async () => {
    const shop = await shopWithHost();
    let read = 0;
    state.during = async () => { read += 1; await erase(shop, how); };
    const added = await addHostIcs(shop, OWNER, ICS, "UTC", {}, state.now);
    assert.equal(read, 1, "the private calendar was read, and the store erased during that read");
    assert.deepEqual(added, { ok: false, message: "This store changed while the calendar was being read, so nothing was added." }, "never told the address was added");
    assert.equal(await cfg(), null, "the sealed private address is not written back");
    assert.deepEqual(await readings(), [null, null], "nor the busy times read from it");
  });
}

test("row 54 control: a live store keeps the sealed address and the busy times, and forgets the last failure", async () => {
  const shop = await shopWithHost();
  await redis.pipeline([["SET", ERR, JSON.stringify({ at: 1, message: "old" }), "EX", 600]]);
  const added = await addHostIcs(shop, OWNER, ICS, "UTC", {}, state.now);
  assert.deepEqual(added, { ok: true });
  const kept = JSON.parse(String(await cfg())) as { source: string; ics: string; email: string };
  assert.equal(kept.source, "ics");
  assert.ok(kept.ics.length > 0 && !kept.ics.includes("private-fenced"), "kept sealed");
  const [good, err] = await readings();
  assert.equal(JSON.parse(String(good)).busy.length, 1, "the busy times read are kept");
  assert.equal(err, null, "the last failure is forgotten");
});

// ---- Row 55: setHostCalendars ------------------------------------------------------------------------------------

for (const how of ["erased", "erasing", "moved"] as const) {
  test(`row 55: setHostCalendars with the store ${how} while Google lists the calendars writes nothing back`, async () => {
    const shop = await shopWithHost();
    await connectGoogle(shop);
    duringList = () => erase(shop, how);
    const problem = await setHostCalendars(shop, OWNER, ["team@group.calendar.google.com"], "team@group.calendar.google.com");
    assert.equal(problem, "unavailable", "never told the choice was kept");
    assert.equal(await cfg(), null, "the address and the Google calendar ids are not written back");
  });
}

test("row 55 control: a live store keeps the choice and forgets the last reading", async () => {
  const shop = await shopWithHost();
  await connectGoogle(shop);
  await redis.pipeline([["SET", GOOD, JSON.stringify({ at: 1, busy: [], source: "google" }), "EX", 600]]);
  assert.equal(await setHostCalendars(shop, OWNER, ["team@group.calendar.google.com"], "team@group.calendar.google.com"), null);
  const kept = JSON.parse(String(await cfg())) as { read: string[]; write: string };
  assert.deepEqual([kept.read, kept.write], [["team@group.calendar.google.com"], "team@group.calendar.google.com"]);
  assert.equal((await readings())[0], null, "the last reading is forgotten, so the next look reads the new choice");
});

// ---- Row 56: removeHostIcs ---------------------------------------------------------------------------------------

for (const how of ["erased", "erasing", "moved"] as const) {
  test(`row 56: removeHostIcs with the store ${how} after its read never writes the old settings back`, async () => {
    const shop = await shopWithHost();
    await seedIcs();
    const real = redis.pipeline.bind(redis);
    let struck = false;
    // The walk lands right after removeHostIcs read the settings, before its write.
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const answer = await real(commands);
      if (!struck && commands.some((c) => c[0] === "GET" && c[1] === CFG)) {
        struck = true;
        await erase(shop, how);
        if (how !== "erased") await real([["DEL", ...hostCalendarKeys(HOST)]]);
      }
      return answer;
    }) as typeof redis.pipeline;
    try {
      await removeHostIcs(shop, OWNER);
    } finally {
      redis.pipeline = real;
    }
    assert.equal(struck, true);
    assert.equal(await cfg(), null, "the address and the Google calendar ids stay erased");
    assert.deepEqual(await readings(), [null, null]);
  });
}

test("row 56 control: a live store forgets the address and what was read from it, and keeps the Google choice", async () => {
  const shop = await shopWithHost();
  await seedIcs();
  await removeHostIcs(shop, OWNER);
  const kept = JSON.parse(String(await cfg())) as { source: string; ics: string; read: string[] };
  assert.deepEqual([kept.source, kept.ics, kept.read], ["none", "", ["private-google-calendar-id"]]);
  assert.deepEqual(await readings(), [null, null]);
});

test("an unknown answer from the fenced write is never told as done", async () => {
  for (const reply of [[], [null], [-1], [2], ["1"]]) {
    const shop = await shopWithHost();
    const real = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: (string | number)[][]) =>
      commands[0]?.[0] === "EVAL" && String(commands[0][1]).startsWith("-- marktmorgen:host-config-live:v1\n") ? reply : real(commands)) as typeof redis.pipeline;
    try {
      await assert.rejects(() => addHostIcs(shop, OWNER, ICS, "UTC", {}, state.now), /fenced on its store/, `${JSON.stringify(reply)}: addHostIcs`);
      await seedIcs();
      await assert.rejects(() => removeHostIcs(shop, OWNER), /fenced on its store/, `${JSON.stringify(reply)}: removeHostIcs`);
    } finally {
      redis.pipeline = real;
    }
  }
});

// ---- Row 150 (b): the whole route against one integration unit ---------------------------------------------------

/** Billed as Upstash bills it: a plain command is one; a script is one plus every redis.call written in it. */
const billed = (command: (string | number)[]): number =>
  command[0] === "EVAL" ? 1 + (String(command[1]).match(/redis\.call\(/g) ?? []).length : 1;
/** One integration unit as tests/plan-cost-registry.ts prices it, with the host calendar route's measured extra. */
const UNIT = 10 + TAKE_COMMANDS + HOST_CALENDAR_ROUTE_EXTRA_COMMANDS;

test("row 150 (b): ics-add and check, the whole route, measured against one integration unit", async () => {
  await shopWithHost();
  // A paying store, the plan whose worst month the registry prices. Its period is not funded: a funded one also reserves
  // the paid resource window (lib/contract-resource-window.ts), which refuses while the commercial review is absent.
  await setSubscription(OWNER, { customerId: "cus_FencedHost0001", subscriptionId: "sub_FencedHost0001", active: true, tier: "creator", cycle: "month", period: paidPeriod() });
  const shop = (await storeForEmail(OWNER))!;
  const session = await openSession(OWNER);
  const real = redis.pipeline.bind(redis);
  const measured = async (body: Record<string, unknown>) => {
    let commands = 0;
    redis.pipeline = (async (batch: (string | number)[][]) => {
      for (const command of batch) {
        commands += billed(command);
        if (process.env.LIST_COMMANDS) console.log("CMD", billed(command), String(command[0]), String(command[0] === "EVAL" ? String(command[1]).split("\n")[0] : command[1]).slice(0, 70));
      }
      return real(batch);
    }) as typeof redis.pipeline;
    try {
      const response = await POST(new NextRequest(`${ORIGIN}/api/store/host-calendar?store=${shop.sid}`, {
        method: "POST",
        headers: { host: "marktmorgen.com", origin: ORIGIN, cookie: `${SESSION_COOKIE}=${session}`, "content-type": "application/json" },
        body: JSON.stringify({ tz: "UTC", ...body }),
      }));
      return { status: response.status, commands };
    } finally {
      redis.pipeline = real;
    }
  };
  const add = await measured({ action: "ics-add", url: ICS });
  assert.equal(add.status, 200);
  const check = await measured({ action: "check" });
  assert.equal(check.status, 200);
  console.log(`MEASURED ics-add=${add.commands} check=${check.commands} unit=${UNIT}`);
  assert.ok(add.commands > 0 && add.commands <= UNIT, `ics-add bills ${add.commands}, over one priced integration unit's ${UNIT}`);
  assert.ok(check.commands > 0 && check.commands <= UNIT, `check bills ${check.commands}, over one priced integration unit's ${UNIT}`);
});
