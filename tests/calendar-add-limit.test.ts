/**
 * R27 follow-up (Claude 6 audit, finding 1, proposal 4): POST
 * /api/store/calendar {action:"add"} reads a remote calendar each time
 * (lib/calendar-sync.ts addFeed -> safeFetch -> parseIcs), and the route had no
 * limit of its own: any signed-in store, even one with no plan, could call it
 * again and again, and one connection holding many stores could multiply that.
 *
 * Expected: a limit per store and one per connection, checked before any read,
 * refused with the route's "slow" (429); a counter that cannot be read refuses
 * with 503 and reads nothing; removing a calendar or making a new private
 * address, which read nothing remote, are not limited by it.
 *
 * Synthetic only: the calendar reading is a counting stand-in
 * (tests/calendar-add-limit-world.ts); sign-in, the studio's figures and the
 * counters are the real ones, over the in-memory Redis.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/calendar/route";
import { openSession, SESSION_COOKIE } from "@/lib/auth";
import * as limits from "@/lib/calendar-limits";
import { claimHandle, ensureStatsId } from "@/lib/store";
import { advance, store as redis } from "./redis-stub";
import { state } from "./calendar-add-limit-world";

globalThis.fetch = (async () => {
  throw Error("Unexpected external request in synthetic route test");
}) as typeof fetch;

const PER_STORE = 10;
const PER_CONNECTION = 20;

async function signedIn(email: string, handle: string): Promise<string> {
  const claimed = await claimHandle(email, handle, "A store", "");
  assert.equal(claimed.ok, true, `setup: ${handle} was made`);
  assert.ok((await ensureStatsId(email))?.statsId, `setup: ${handle} has a stats id`);
  return openSession(email);
}

function call(token: string, address: string, action: string, extra: Record<string, unknown> = {}): Promise<Response> {
  return POST(
    new NextRequest("https://local.example/api/store/calendar", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://local.example",
        Host: "local.example",
        Cookie: `${SESSION_COOKIE}=${token}`,
        "x-forwarded-for": address,
      },
      body: JSON.stringify({ action, url: "https://calendar.example.test/private.ics", ...extra }),
    }),
  );
}

async function adds(token: string, address: string, times: number): Promise<{ statuses: number[]; errors: (string | undefined)[] }> {
  const statuses: number[] = [];
  const errors: (string | undefined)[] = [];
  for (let i = 0; i < times; i += 1) {
    const answer = await call(token, address, "add");
    statuses.push(answer.status);
    errors.push(((await answer.json()) as { error?: string }).error);
  }
  return { statuses, errors };
}

test("the limits are the reviewed figures", () => {
  const named = limits as Record<string, unknown>;
  assert.equal(named.CALENDAR_ADDS_PER_TEN_MINUTES, PER_STORE);
  assert.equal(named.CALENDAR_ADDS_PER_CONNECTION_TEN_MINUTES, PER_CONNECTION);
});

test("one store with no plan: rapid adds read a remote calendar at most the store's limit, then 'slow'", async () => {
  redis.clear();
  state.adds = 0;
  const token = await signedIn("calendar-limit-a@example.com", "calendarlimita");
  const { statuses, errors } = await adds(token, "203.0.113.10", 30);
  assert.equal(state.adds, PER_STORE, `30 adds from one store read ${state.adds} calendars`);
  assert.deepEqual(statuses.slice(0, PER_STORE), Array(PER_STORE).fill(200), "the first adds answer as before");
  assert.deepEqual(statuses.slice(PER_STORE), Array(30 - PER_STORE).fill(429));
  assert.deepEqual(errors.slice(PER_STORE), Array(30 - PER_STORE).fill("slow"));

  // Actions that read nothing remote are not limited by it.
  assert.equal((await call(token, "203.0.113.10", "remove", { id: "abc" })).status, 200);
  assert.equal((await call(token, "203.0.113.10", "rotate")).status, 200);
  assert.deepEqual([state.removals, state.rotations], [1, 1]);

  // The window passes, and adding works again.
  advance(600_001);
  assert.equal((await call(token, "203.0.113.10", "add")).status, 200);
  assert.equal(state.adds, PER_STORE + 1);
});

test("one connection holding several stores: reads stop at the connection's limit, before the store's", async () => {
  redis.clear();
  state.adds = 0;
  const address = "203.0.113.20";
  const tokens = [
    await signedIn("calendar-limit-b@example.com", "calendarlimitb"),
    await signedIn("calendar-limit-c@example.com", "calendarlimitc"),
    await signedIn("calendar-limit-d@example.com", "calendarlimitd"),
  ];
  const results = [];
  for (const token of tokens) results.push(await adds(token, address, PER_STORE));
  assert.equal(state.adds, PER_CONNECTION, `three stores on one connection read ${state.adds} calendars`);
  assert.deepEqual(results[2].statuses, Array(PER_STORE).fill(429), "the third store on the same connection is refused");
  assert.deepEqual(results[2].errors, Array(PER_STORE).fill("slow"));

  // The refused store spent nothing of its own: from another connection it adds at once.
  assert.equal((await call(tokens[2], "203.0.113.30", "add")).status, 200);
  assert.equal(state.adds, PER_CONNECTION + 1);
});

test("a counter that answers in an unknown shape refuses with 503 and reads nothing", async () => {
  redis.clear();
  state.adds = 0;
  const token = await signedIn("calendar-limit-e@example.com", "calendarlimite");
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((command) => String(command[1] ?? "").startsWith("nl:rl:calendar-add"))) return commands.map(() => "weird");
    return pipeline(commands);
  }) as typeof redis.pipeline;
  try {
    const answer = await call(token, "203.0.113.40", "add");
    assert.equal(answer.status, 503);
    assert.equal(((await answer.json()) as { error?: string }).error, "busy");
    assert.equal(state.adds, 0, "nothing remote is read while the count is unknown");
  } finally {
    redis.pipeline = pipeline;
  }
  assert.equal((await call(token, "203.0.113.40", "add")).status, 200, "control: a known count lets the add through");
  assert.equal(state.adds, 1);
});

/**
 * Claude 2's review of #3341 (MEDIUM): the connection counter was keyed by the
 * raw address, so each address of one IPv6 network and each spelling of one
 * old-kind address got a counter of its own. One connection is what
 * lib/traffic-rules.ts shareAddress folds them to: the new kind by its /48,
 * "::ffff:" and upper case to the old address.
 */
async function threeStoresFrom(prefix: string, addresses: string[]): Promise<{ statuses: number[][] }> {
  const tokens = [
    await signedIn(`${prefix}-f@example.com`, `${prefix}f`),
    await signedIn(`${prefix}-g@example.com`, `${prefix}g`),
    await signedIn(`${prefix}-h@example.com`, `${prefix}h`),
  ];
  const statuses: number[][] = [];
  let next = 0;
  for (const token of tokens) {
    const mine: number[] = [];
    for (let i = 0; i < PER_STORE; i += 1) {
      mine.push((await call(token, addresses[next % addresses.length], "add")).status);
      next += 1;
    }
    statuses.push(mine);
  }
  return { statuses };
}

test("addresses rotated inside one IPv6 /64 share one connection's limit", async () => {
  redis.clear();
  state.adds = 0;
  const addresses = Array.from({ length: 3 * PER_STORE }, (_, i) => `2001:db8:1:2::${(i + 1).toString(16)}`);
  const { statuses } = await threeStoresFrom("calsixfour", addresses);
  assert.equal(state.adds, PER_CONNECTION, `three stores rotating inside one /64 read ${state.adds} calendars`);
  assert.deepEqual(statuses[2], Array(PER_STORE).fill(429));
});

test("addresses rotated across the /64s of one IPv6 /48 share one connection's limit", async () => {
  redis.clear();
  state.adds = 0;
  const addresses = Array.from({ length: 3 * PER_STORE }, (_, i) => `2001:DB8:7:${(i + 1).toString(16)}::1`);
  const { statuses } = await threeStoresFrom("calfortyeight", addresses);
  assert.equal(state.adds, PER_CONNECTION, `three stores rotating inside one /48 read ${state.adds} calendars`);
  assert.deepEqual(statuses[2], Array(PER_STORE).fill(429));
});

test("one old-kind address in its other spellings shares one connection's limit", async () => {
  redis.clear();
  state.adds = 0;
  const addresses = ["203.0.113.50", "::ffff:203.0.113.50", "::FFFF:203.0.113.50"];
  const { statuses } = await threeStoresFrom("calspelled", addresses);
  assert.equal(state.adds, PER_CONNECTION, `three stores on one address, spelled three ways, read ${state.adds} calendars`);
  assert.deepEqual(statuses[2], Array(PER_STORE).fill(429));
});

test("a spent IPv6 /48 refuses its other addresses; another /48 and an old-kind address are other connections", async () => {
  redis.clear();
  state.adds = 0;
  const token = await signedIn("calendar-limit-i@example.com", "calendarlimiti");
  const other = await signedIn("calendar-limit-j@example.com", "calendarlimitj");
  assert.deepEqual((await adds(token, "2001:db8:1:2::1", PER_STORE)).statuses, Array(PER_STORE).fill(200));
  assert.deepEqual((await adds(other, "2001:db8:1:2::2", PER_STORE)).statuses, Array(PER_STORE).fill(200));
  const third = await signedIn("calendar-limit-k@example.com", "calendarlimitk");
  // The /48 is spent; another /48 and an old-kind address are not.
  assert.equal((await call(third, "2001:db8:1:2::3", "add")).status, 429);
  assert.equal((await call(third, "2001:db8:2:2::3", "add")).status, 200);
  assert.equal((await call(third, "198.51.100.7", "add")).status, 200);
  assert.equal(state.adds, 2 * PER_STORE + 2);
});
