/**
 * The weekly email's stop link (app/api/store/weekly/route.ts) and who on the
 * team gets it (lib/stats-report.ts, setWeeklyTeam): a stop is said only when
 * Redis confirmed it (CX-123 rule 24). Before, the page said "Stopped" on any
 * answer that was not an error, so a creator or a team member who pressed
 * "Stop" was told it worked while the stop was never confirmed, and the
 * weekly, busy-day and quiet-sales emails kept going. Synthetic data only.
 */
import { NextRequest } from "next/server";
import { POST as weeklyRoute } from "@/app/api/store/weekly/route";
import { setWeeklyOff, setWeeklyTeam, weeklyMemberStopUrl, weeklyOff, weeklyStopUrl, weeklyTeam } from "@/lib/stats-report";
import { claimHandle, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const HANDLE = "harbor";
const MEMBER = "ana@example.com";
const real = redis.pipeline.bind(redis);

/** Every pipeline whose first command is `command` answers `whole` as it is; the rest are real. */
function answer(command: string, whole: unknown) {
  redis.pipeline = (async (commands: (string | number)[][]) => (commands[0]?.[0] === command ? whole : real(commands))) as typeof redis.pipeline;
}

async function press(url: string, form?: Record<string, string>): Promise<{ status: number; page: string }> {
  const body = new URLSearchParams(form ?? {});
  try {
    const response = await weeklyRoute(new NextRequest(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }));
    return { status: response.status, page: await response.text() };
  } catch (error) {
    return { status: 0, page: `thrown: ${(error as Error).message}` };
  }
}

// Rule 23 (claude5/email-stop-by-sid-2): the links the emails carry, signed for the store's id, not for HANDLE.
const ownerUrl = () => weeklyStopUrl(store);
const memberUrl = () => weeklyMemberStopUrl(store, MEMBER);
const saysStopped = (page: string) => page.includes("<h1>Stopped</h1>");
// The stop is kept by the store's id since finding 5 of the handles audit (lib/store-stop.ts): the link reaches a
// store that exists, and "Start again" takes out its id and its address, two members, so it may answer up to 2.
let store: Store;

/** Shapes that are not a confirmed SADD/SREM of one member: each whole pipeline answer as it came back. */
const UNKNOWN: [string, unknown][] = [
  ["no reply at all", []],
  ["two replies for one command", [1, 1]],
  ["undefined", [undefined]],
  ["null", [null]],
  ["a string", ["1"]],
  ["a list", [[]]],
  ["an object", [{}]],
  ["minus one", [-1]],
  ["a fraction", [0.5]],
  ["two for one member", [2]],
  ["true", [true]],
];

async function main() {
  part("controls: a confirmed stop and start are said as before");
  redis.clear();
  redis.pipeline = real;
  await claimHandle("harbor@example.com", HANDLE, "Harbor", "");
  store = (await storeForEmail("harbor@example.com"))!;
  let pressed = await press(ownerUrl(), { do: "off" });
  is("healthy stop: 200", pressed.status, 200);
  is("healthy stop: says Stopped", saysStopped(pressed.page), true);
  is("healthy stop: the store is stopped", await weeklyOff(store), true);
  pressed = await press(ownerUrl(), { do: "off" });
  is("stop pressed again (SADD answers 0, already stopped): still Stopped", saysStopped(pressed.page), true);
  pressed = await press(ownerUrl(), { do: "on" });
  is("healthy start: 200 and On again", [pressed.status, pressed.page.includes("On again")], [200, true]);
  is("healthy start: the store is not stopped", await weeklyOff(store), false);

  part("the creator's stop: an unknown answer is never said as Stopped");
  for (const [name, whole] of UNKNOWN) {
    redis.pipeline = real;
    await setWeeklyOff(store, false);
    answer("SADD", whole);
    pressed = await press(ownerUrl(), { do: "off" });
    redis.pipeline = real;
    // Nothing confirmed the stop, so the store is still not stopped and its emails would still go.
    is(`${name}: the store is still not stopped`, await weeklyOff(store), false);
    is(`${name}: not said as Stopped`, saysStopped(pressed.page), false);
    is(`${name}: answered as a page that was not done (503)`, pressed.status, 503);
  }

  part("starting again: an unknown answer is never said as On again");
  // Rule 23: "two for one member" became a valid count (the id and the address), so the case is three for two.
  const START_UNKNOWN = UNKNOWN.map(([name, whole]): [string, unknown] => (name === "two for one member" ? ["three for two members", [3]] : [name, whole]));
  for (const [name, whole] of START_UNKNOWN) {
    redis.pipeline = real;
    await setWeeklyOff(store, true);
    answer("SREM", whole);
    pressed = await press(ownerUrl(), { do: "on" });
    redis.pipeline = real;
    is(`${name}: not said as On again`, pressed.page.includes("On again"), false);
  }

  part("a team member's own stop: an unknown answer is never said as Stopped");
  redis.pipeline = real;
  await setWeeklyTeam(store, [MEMBER]);
  pressed = await press(memberUrl());
  is("healthy member stop: 200 and Stopped", [pressed.status, saysStopped(pressed.page)], [200, true]);
  is("healthy member stop: off the list", await weeklyTeam(store), []);
  // Rule 23 (claude5/email-stop-by-sid-2): the member's stop takes their address out of the list by the store's id
  // and of one written before under its address, two SREMs, so "two replies" is a valid answer: three is not.
  const MEMBER_UNKNOWN = UNKNOWN.map(([name, whole]): [string, unknown] => (name === "two replies for one command" ? ["three replies for two commands", [1, 1, 1]] : [name, whole]));
  for (const [name, whole] of MEMBER_UNKNOWN) {
    redis.pipeline = real;
    await setWeeklyTeam(store, [MEMBER]);
    answer("SREM", whole);
    pressed = await press(memberUrl());
    redis.pipeline = real;
    is(`${name}: member not said as Stopped`, saysStopped(pressed.page), false);
    is(`${name}: member answered 503`, pressed.status, 503);
  }

  part("who on the team gets it: an unknown answer to the change is never taken as kept");
  redis.pipeline = real;
  await setWeeklyTeam(store, [MEMBER]);
  is("healthy set: kept", await weeklyTeam(store), [MEMBER]);
  await setWeeklyTeam(store, []);
  is("healthy empty set (DEL alone): nobody", await weeklyTeam(store), []);
  const TEAM_UNKNOWN: [string, unknown][] = [
    ["no reply at all", []],
    ["one reply for two commands", [1]],
    ["three replies for two commands", [1, 1, 1]],
    ["DEL answered null", [null, 1]],
    ["DEL answered a string", ["1", 1]],
    // Rule 23: the DEL takes the list by the id and one under the address together (two keys), so 2 is valid.
    ["DEL answered three for two keys", [3, 1]],
    ["SADD answered undefined", [1, undefined]],
    ["SADD answered an object", [1, {}]],
    ["SADD answered minus one", [1, -1]],
    ["SADD answered two for one member", [1, 2]],
  ];
  for (const [name, whole] of TEAM_UNKNOWN) {
    redis.pipeline = real;
    await setWeeklyTeam(store, [MEMBER]);
    answer("DEL", whole);
    let refused = false;
    try {
      await setWeeklyTeam(store, ["ben@example.com"]);
    } catch {
      refused = true;
    }
    redis.pipeline = real;
    is(`${name}: the change is refused, not taken as kept`, refused, true);
  }
  redis.pipeline = real;
  done();
}

void main();
