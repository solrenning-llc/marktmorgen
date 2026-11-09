/**
 * The weekly email's team list, kept by the store's id (tests/weekly-link-by-sid.test.ts), against requests that
 * cross each other (pre-review of claude5/email-stop-by-sid-2, 9 November 2026):
 *
 * 1. A member's own stop racing a rename (the RENAME landing between its SREMs) was answered "stopped" while the
 *    member stayed on the list: the id's key is now taken out of last.
 * 2. The owner's new list racing a rename (saved between the SISMEMBER and the move) was overwritten by RENAME: the
 *    move is now a RENAMENX, which never replaces a list kept by the id, and the address's older list is then taken
 *    out, confirmed. Should the save take the address's list out before the move, the rename is refused as not
 *    confirmed (the address is not changed) and the form says so.
 * 3. The weekly job's read racing the move answered nobody: the address is now read before the id.
 * 4. A list left under an address by an earlier store showed in the next store's studio: the page passes only
 *    current team members.
 *
 * Synthetic data only; no request leaves the process.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import * as report from "@/lib/stats-report";
import { MemoryRedis } from "@/lib/redis-memory";
import { POST as renameRoute } from "@/app/api/store/rename/route";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_weekly_team_races_only";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const HOST = "marktmorgen.com";
const ORIGIN = `https://${HOST}`;

const elsewhere: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  elsewhere.push(`${url.hostname}${url.pathname}`);
  return new Response(JSON.stringify({ error: "not in this test" }), { status: 400 });
}) as typeof fetch;

async function paidStore(owner: string, handle: string, name: string): Promise<Store> {
  await claimHandle(owner, handle, name, "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: `cus_${handle.replace(/\W/g, "")}0001`, subscriptionId: `sub_${handle.replace(/\W/g, "")}0001`, active: true, period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

const fresh = async (owner: string) => (await storeForEmail(owner))!;
const teamOf = async (store: Store): Promise<unknown> => report.weeklyTeam(store).catch((error: Error) => `threw: ${error.message}`);

/** Renames the store from the studio, as its owner does (app/api/store/rename/route.ts): status and error. */
async function rename(owner: string, store: Store, handle: string): Promise<[number, unknown]> {
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const response = await renameRoute(
    new NextRequest(`${ORIGIN}/api/store/rename?store=${store.sid}`, {
      method: "POST",
      headers: { host: HOST, origin: ORIGIN, cookie, "content-type": "application/json" },
      body: JSON.stringify({ handle }),
    }),
  );
  const body = (await response.json()) as { error?: unknown };
  return [response.status, body.error ?? null];
}

/** What the rename's move does, from another request: the address's list marked set, then moved to the id. */
function moveNow(handle: string, sid: string): void {
  redis.run(["SADD", `nl:weekly:to:${handle}`, ":set"]);
  redis.run(["RENAME", `nl:weekly:to:${handle}`, `nl:weekly:team:${sid}`]);
}

async function main(): Promise<void> {
  const real = redis.pipeline.bind(redis);

  part("A member's stop racing a rename (the move between the stop's SREMs) takes the member off");
  {
    const s = await paidStore("p1@example.com", "pone", "P1");
    redis.run(["SADD", "nl:weekly:to:pone", "ana@example.com", "ben@example.com"]);
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands.length > 1 && commands.every((c) => c[0] === "SREM")) {
        const out: unknown[] = [];
        for (const [i, c] of commands.entries()) {
          out.push(...(await real([c])));
          if (i === 0) moveNow("pone", s.sid);
        }
        return out;
      }
      return real(commands);
    }) as typeof redis.pipeline;
    const answered = await report.leaveWeeklyTeam(s, "ana@example.com").then(() => "stopped", (e: Error) => e.message);
    redis.pipeline = real;
    is("the member is told stopped", answered, "stopped");
    is("and is no longer on the list; the other member still is", await teamOf(s), ["ben@example.com"]);
    is("a member already gone is told stopped too, nothing else moves", await report.leaveWeeklyTeam(s, "ana@example.com").then(() => "stopped", (e: Error) => e.message), "stopped");
    is("the list is unchanged by it", await teamOf(s), ["ben@example.com"]);
  }

  part("The owner's new list saved while the rename runs, before its move, survives, and the old list is taken out");
  {
    const owner = "p2@example.com";
    const s = await paidStore(owner, "ptwo", "P2");
    redis.run(["SADD", "nl:weekly:to:ptwo", "ana@example.com"]);
    // Kept as it was before setWeeklyTeam takes it out: what the rename's request still finds under the address.
    let once = true;
    let count = 0;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      count += commands.length;
      if (once && commands[0]?.[0] === "SADD" && commands[0][1] === "nl:weekly:to:ptwo") {
        once = false;
        redis.pipeline = real;
        await report.setWeeklyTeam(s, ["ben@example.com"]);
        redis.run(["SADD", "nl:weekly:to:ptwo", "ana@example.com"]);
        redis.pipeline = again;
      }
      return real(commands);
    }) as typeof redis.pipeline;
    const again = redis.pipeline;
    const [status] = await rename(owner, s, "ptwo-new");
    redis.pipeline = real;
    is("renamed", status, 200);
    is("the owner's saved list survives the rename", await teamOf(await fresh(owner)), ["ben@example.com"]);
    is("no list is left under the address let go of", redis.run(["EXISTS", "nl:weekly:to:ptwo"]), 0);
    is(`the rename, its DEL included, stays inside a studio request's twenty commands (${count})`, count <= 20, true);
  }

  part("The owner's new list saved between the mark and the move: the rename is refused as not confirmed, the list survives");
  {
    const owner = "p5@example.com";
    const s = await paidStore(owner, "pfive", "P5");
    redis.run(["SADD", "nl:weekly:to:pfive", "ana@example.com"]);
    let once = true;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const out = await real(commands);
      if (once && commands[0]?.[0] === "SADD" && commands[0][1] === "nl:weekly:to:pfive") {
        once = false;
        redis.pipeline = real;
        await report.setWeeklyTeam(s, ["ben@example.com"]);
        redis.pipeline = again;
      }
      return out;
    }) as typeof redis.pipeline;
    const again = redis.pipeline;
    const answered = await rename(owner, s, "pfive-new");
    redis.pipeline = real;
    is("answered not confirmed, never a server error", answered, [503, "not_confirmed"]);
    is("the address was not changed", (await fresh(owner)).handle, "pfive");
    is("the owner's saved list survives", await teamOf(await fresh(owner)), ["ben@example.com"]);
    is("tried again, renamed", (await rename(owner, await fresh(owner), "pfive-new"))[0], 200);
    is("and the list is still the owner's", await teamOf(await fresh(owner)), ["ben@example.com"]);
  }

  part("The weekly job's read racing the move still sees the members");
  {
    const s = await paidStore("p3@example.com", "pthree", "P3");
    redis.run(["SADD", "nl:weekly:to:pthree", "ana@example.com"]);
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands.length === 2 && commands.every((c) => c[0] === "SMEMBERS")) {
        const first = await real([commands[0]]);
        moveNow("pthree", s.sid);
        return [...first, ...(await real([commands[1]]))];
      }
      return real(commands);
    }) as typeof redis.pipeline;
    const read = await teamOf(s);
    redis.pipeline = real;
    is("ana is still read", read, ["ana@example.com"]);
  }

  part("RENAMENX in the stand-in Redis answers as Redis does");
  {
    const memory = new MemoryRedis();
    memory.run(["SADD", "from", "a"]);
    memory.run(["SADD", "taken", "b"]);
    is("onto a name already held: 0, both kept", [memory.run(["RENAMENX", "from", "taken"]), memory.run(["SMEMBERS", "from"]), memory.run(["SMEMBERS", "taken"])], [0, ["a"], ["b"]]);
    is("onto a free name: 1, moved whole", [memory.run(["RENAMENX", "from", "free"]), memory.run(["EXISTS", "from"]), memory.run(["SMEMBERS", "free"])], [1, 0, ["a"]]);
    memory.run(["SMEMBERS", "read-before"]);
    memory.run(["SADD", "from", "c"]);
    is("onto a name only read before, never written: 1, moved (Redis holds no empty set)", [memory.run(["RENAMENX", "from", "read-before"]), memory.run(["SMEMBERS", "read-before"])], [1, ["c"]]);
    let error = "";
    try {
      memory.run(["RENAMENX", "nothing", "else"]);
    } catch (e) {
      error = (e as Error).message;
    }
    is("from a key that is not there: Redis's error", error, "ERR no such key");
  }

  part("The studio shows only current team members as chosen; the rename form explains a refusal not confirmed");
  {
    const page = readFileSync(join(process.cwd(), "app/studio/page.tsx"), "utf8");
    is("chosen is filtered by the team's members before it reaches the browser", /chosen: \(\(await chosen\) \?\? \[\]\)\.filter\(\(email\) => statsMembers\.includes\(email\)\)/.test(page), true);
    const form = readFileSync(join(process.cwd(), "components/rename-form.tsx"), "utf8");
    is("not_confirmed has its own words", /not_confirmed: "Your address was not changed\. Try again in a minute\."/.test(form), true);
  }

  part("Nothing left the process");
  is("no request", elsewhere, []);
}

main().then(done, (e) => {
  console.error(e);
  process.exit(1);
});
