/**
 * 405 [HX1] unit 4: the public confirm and leave pages of the numbers email
 * to addresses outside the team. Synthetic store and addresses on the
 * in-memory database; nothing is sent.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { GET as confirmGet, POST as confirmPost } from "@/app/api/numbers-guest/confirm/route";
import { GET as leaveGet, POST as leavePost } from "@/app/api/numbers-guest/leave/route";
import { claimHandle, ensureStoreId } from "@/lib/store";
import { readShare, saveShare } from "@/lib/report-guests";
import { INVITE_DAYS } from "@/lib/report-guests-rules";
import { LIMIT_TRIES, figuresSaid } from "@/lib/report-guests-page";
import { store as redis } from "./redis-stub";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const DAY = 86_400_000;
const OWNER = "owner@example.test";
const PEOPLE = { team: [], owner: OWNER };
const real = redis.pipeline.bind(redis);
let ip = 0;

type Route = (request: NextRequest) => Promise<Response>;
async function call(route: Route, kind: "confirm" | "leave", token: string, method: "GET" | "POST", from = `203.0.113.${(ip = (ip % 250) + 1)}`) {
  const request = new NextRequest(`https://marktmorgen.com/api/numbers-guest/${kind}?t=${encodeURIComponent(token)}`, { method, headers: { "x-forwarded-for": from } });
  const response = await route(request);
  return { status: response.status, page: await response.text(), headers: response.headers };
}
const heading = (page: string) => /<h1>(.*?)<\/h1>/.exec(page)?.[1] ?? "";

let sid = "";
async function freshStore(): Promise<string> {
  if (sid) return sid;
  await claimHandle(OWNER, "harborhx", "Harbor Books", "");
  sid = (await ensureStoreId(OWNER))!.sid;
  return sid;
}
async function invite(address: string, now = Date.now()) {
  const id = await freshStore();
  const current = await readShare(id);
  const saved = await saveShare(id, { figures: ["sales", "visits"], every: "month", addresses: [...current.guests.map((g) => g.address), address] }, PEOPLE, now);
  assert.ok(saved.ok, JSON.stringify(saved));
  return saved.invites.find((i) => i.address === address)!;
}
/** Takes everybody off the list, so each test has its three places. */
const reset = async () => void (await saveShare(await freshStore(), { figures: ["sales"], every: "month", addresses: [] }, PEOPLE));
const stateOf = async (address: string) => (await readShare(sid)).guests.find((g) => g.address === address)?.state;

test("a GET only asks, names the store and what is sent, and changes nothing", async () => {
  const { confirmToken } = await invite("partner@example.test");
  const seen = await call(confirmGet, "confirm", confirmToken, "GET");
  assert.equal(seen.status, 200);
  assert.equal(heading(seen.page), "Get the numbers of Harbor Books by email?");
  assert.ok(seen.page.includes("these numbers of its store every month:</p><ul><li>Sales</li><li>Visits</li></ul>"));
  assert.ok(seen.page.includes('<html lang="en">') && seen.page.includes("<main>") && seen.page.includes('<button type="submit">'));
  assert.ok(seen.page.includes("min-height:44px") && seen.page.includes("focus-visible"));
  assert.equal(seen.headers.get("cache-control"), "no-store");
  assert.equal(seen.headers.get("referrer-policy"), "no-referrer");
  assert.equal(await stateOf("partner@example.test"), "invited");
  // The token is only in the form's address, never in the words.
  assert.equal(seen.page.split(encodeURIComponent(confirmToken)).length, 2);
});

test("the confirm POST confirms once; pressed again it says so and changes nothing", async () => {
  const { confirmToken } = await invite("books@example.test");
  const first = await call(confirmPost, "confirm", confirmToken, "POST");
  assert.equal(first.status, 200);
  assert.equal(heading(first.page), "You will get the numbers");
  assert.equal(await stateOf("books@example.test"), "confirmed");
  const again = await call(confirmPost, "confirm", confirmToken, "POST");
  assert.equal(heading(again.page), "You already said yes");
  assert.equal(heading((await call(confirmGet, "confirm", confirmToken, "GET")).page), "You already said yes");
  assert.equal(await stateOf("books@example.test"), "confirmed");
});

test("the leave link stops it at once, by POST alone, and says so again after", async () => {
  await reset();
  const { confirmToken, leaveToken } = await invite("advisor@example.test");
  await call(confirmPost, "confirm", confirmToken, "POST");
  assert.equal(heading((await call(leaveGet, "leave", leaveToken, "GET")).page), "Stop the numbers emails from Harbor Books?");
  assert.equal(await stateOf("advisor@example.test"), "confirmed");
  // A mail app's own unsubscribe button: a POST with "List-Unsubscribe=One-Click", nothing read from it.
  const left = await call(leavePost, "leave", leaveToken, "POST");
  assert.equal(heading(left.page), "Stopped");
  assert.equal(await stateOf("advisor@example.test"), "left");
  assert.equal(heading((await call(leavePost, "leave", leaveToken, "POST")).page), "Already stopped");
  // Left, the confirm link of the same invitation does not bring it back.
  assert.equal((await call(confirmPost, "confirm", confirmToken, "POST")).status, 400);
  assert.equal(await stateOf("advisor@example.test"), "left");
});

test("an invited address can say no with the leave link, before ever confirming", async () => {
  await reset();
  const { leaveToken } = await invite("maybe@example.test");
  assert.equal(heading((await call(leavePost, "leave", leaveToken, "POST")).page), "Stopped");
  assert.equal(await stateOf("maybe@example.test"), "left");
});

test("an invitation past its days cannot be confirmed", async () => {
  await reset();
  const then = Date.now() - (INVITE_DAYS * DAY + 60_000);
  const { confirmToken } = await invite("late@example.test", then);
  const seen = await call(confirmPost, "confirm", confirmToken, "POST");
  assert.equal(seen.status, 410);
  assert.equal(heading(seen.page), "This invitation has ended");
  assert.equal(await stateOf("late@example.test"), "invited");
});

test("a link of the wrong kind, a made-up one or a removed address's fits nothing, said one way", async () => {
  await reset();
  const { confirmToken, leaveToken } = await invite("gone@example.test");
  const noes = [
    await call(leavePost, "leave", confirmToken, "POST"),
    await call(confirmPost, "confirm", leaveToken, "POST"),
    await call(confirmPost, "confirm", "A".repeat(43), "POST"),
    await call(confirmGet, "confirm", "not-a-token", "GET"),
  ];
  for (const no of noes) assert.deepEqual([no.status, heading(no.page)], [400, "Link not recognized"]);
  assert.equal(await stateOf("gone@example.test"), "invited");
  await saveShare(sid, { figures: ["sales"], every: "month", addresses: [] }, PEOPLE);
  assert.equal((await call(confirmPost, "confirm", confirmToken, "POST")).status, 400);
  assert.equal((await call(leaveGet, "leave", leaveToken, "GET")).status, 400);
});

test("an unknown read never confirms and never says done", async () => {
  await reset();
  const { confirmToken } = await invite("unsure@example.test");
  for (const [label, bad] of [["no reply", []], ["two replies", ["x", "y"]], ["a number", [7]]] as [string, unknown][]) {
    // The record's own read answers in another shape; everything else is real.
    redis.pipeline = (async (commands: (string | number)[][]) =>
      commands[0]?.[0] === "GET" && String(commands[0][1]).startsWith("nl:rguest:") && !String(commands[0][1]).includes(":link:") && !String(commands[0][1]).includes(":lock:")
        ? bad
        : real(commands)) as typeof redis.pipeline;
    try {
      const press = await call(confirmPost, "confirm", confirmToken, "POST");
      assert.deepEqual([press.status, heading(press.page)], [503, "Nothing changed yet"], label);
      const look = await call(confirmGet, "confirm", confirmToken, "GET");
      assert.equal(look.status, 503, label);
    } finally {
      redis.pipeline = real;
    }
    assert.equal(await stateOf("unsure@example.test"), "invited", label);
  }
  // The link's own read in another shape: the same.
  redis.pipeline = (async (commands: (string | number)[][]) => (commands[0]?.[0] === "GET" && String(commands[0][1]).includes(":link:") ? [] : real(commands))) as typeof redis.pipeline;
  try {
    assert.equal((await call(confirmPost, "confirm", confirmToken, "POST")).status, 503);
  } finally {
    redis.pipeline = real;
  }
  assert.equal(await stateOf("unsure@example.test"), "invited");
  await saveShare(sid, { figures: ["sales"], every: "month", addresses: [] }, PEOPLE);
});

test("one connection is held back after its tries, the page saying so", async () => {
  const from = "198.51.100.9";
  let last = 0;
  for (let i = 0; i <= LIMIT_TRIES; i += 1) last = (await call(confirmGet, "confirm", "A".repeat(43), "GET", from)).status;
  assert.equal(last, 429);
  assert.equal((await call(leavePost, "leave", "A".repeat(43), "POST", from)).status, 429);
});

test("the figures are said by their own names, one a line", () => {
  assert.deepEqual(figuresSaid([]), []);
  assert.deepEqual(figuresSaid(["visits", "sales", "revenue"]), ["Visits", "Sales", "Money in, after refunds"]);
});
