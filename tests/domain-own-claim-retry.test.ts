/**
 * A store's own domain claim never reads as "another store" (Claude 4's review note on #2859, comment 6728179008).
 *
 * (a) MEDIUM. connectDomain claims nl:domain:<name> as `?<handle>` for UNPROVED_SECONDS (3 days) before asking Vercel.
 *     When that claim is left behind without the store getting the domain (the claim's reply and its read-back
 *     unknown, so the route says "try again"; or the store's own write failing after the claim), the next press got a
 *     nil SET NX and answered "taken": the editor said "Another store here already uses that domain." about the
 *     store's own claim, for up to three days. Now a nil is read back exactly: a key holding this store's own value,
 *     under its current address or one it still owns (as proveDomain already reads it), is the store's own and the
 *     connection goes on. Another store's claim, proved or not, and an address this store let go of (quarantined, so
 *     it may be somebody else's) stay "taken"; a read-back that cannot say who holds it asks Vercel nothing. A proved
 *     key adopted this way is never deleted when Vercel then refuses: only the exact `?<handle>` claim is let go.
 *     Vercel not answering (a thrown fetch) was already answered 502 and the claim let go; kept as a control.
 *
 * (b) LOW. pointDomain, after a rename, read the key loosely and never looked at the swap's reply, so a domain left
 *     on the old address was silent. Now both are read exactly, and a domain not known to have followed is told to
 *     the creator (`domainBehind`), with the one step that moves it (Check again, which proveDomain already does).
 *
 * Synthetic only: Vercel is a stand-in fetch, Redis the in-memory stand-in (its swap script simulated by the reply
 * rules, since the stand-in does not run it).
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { claimHandle, ensureStoreId, releaseHandle, renameHandle, setDomain, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { connectDomain, domainKey, pointDomain } from "@/lib/domains";
import { POST as renameRoute } from "@/app/api/store/rename/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { THROWS, UNREADABLE, answer, clearAnswers, getOf, setNx, type Command } from "./l10b-replies";
import { paidPeriod } from "./billing-period-fixture";

process.env.VERCEL_API_TOKEN = "test-token";
process.env.VERCEL_PROJECT_ID = "prj_retry";
const NAME = "shop.example.com";
const KEY = domainKey(NAME);

const vercelCalls: string[] = [];
let postStatus = 200;
let postThrows = false;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  vercelCalls.push(`${method} ${url.pathname}`);
  if (method === "POST" && postThrows) throw new TypeError("fetch failed");
  let body: unknown = {};
  if (method === "GET" && url.pathname === `/v9/projects/prj_retry/domains/${NAME}`) body = { name: NAME, apexName: "example.com", verified: true };
  return new Response(JSON.stringify(body), { status: method === "POST" ? postStatus : 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

const held = () => redis.run(["GET", KEY]);
const evalOn = (c: Command) => c[0] === "EVAL" && c.some((x) => String(x) === KEY);
/** The swap script's effect (the stand-in does not run it): the key set to `value`, keeping its time to live. */
const swapTo = (value: string) => answer(evalOn, () => [1], { run: false, before: () => void redis.run(["SET", KEY, value, "KEEPTTL"]) });
const owner = "retrydomain@example.com";

async function setUp(): Promise<string> {
  redis.clear();
  clearAnswers();
  vercelCalls.length = 0;
  postStatus = 200;
  postThrows = false;
  await claimHandle(owner, "mystore", "My Store", "");
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_retry2859", subscriptionId: "sub_retry2859", active: true, tier: "scale", period: paidPeriod() });
  return openSession(owner);
}
const mine = async (): Promise<Store> => (await storeForEmail(owner))!;
/** What a connection came to: its answer, or "try again" when it said it could not tell (it threw). */
const connect = async () => connectDomain(await mine(), NAME).catch(() => "try again" as const);
const posts = () => vercelCalls.filter((c) => c.startsWith("POST")).length;
/** What pointing the domain at the new address came to, or "threw". */
const point = async () => pointDomain(NAME, ["mystore"], "newstore").catch(() => "threw" as const);

async function main(): Promise<void> {
  console.error = () => {};

  part("(a) the store's own claim left behind: the next press connects, never 'taken'");
  await setUp();
  answer(setNx(KEY), () => ["QUEUED"]);
  answer(getOf(KEY), THROWS);
  is("the claim's reply and its read-back unknown: try again, Vercel not asked", [await connect(), vercelCalls], ["try again", []]);
  is("the claim did land", held(), "?mystore");
  is("the next press connects the store's own domain, the claim kept", [await connect(), posts(), held()], [{ ok: true, name: NAME }, 1, "?mystore"]);

  await setUp();
  redis.run(["SET", KEY, "?mystore", "EX", 200_000]);
  is("a claim of this store's left by a write that failed after it: connected", [await connect(), posts(), held()], [{ ok: true, name: NAME }, 1, "?mystore"]);

  await setUp();
  redis.run(["SET", KEY, "mystore"]);
  is("proved for this store already: connected, still proved", [await connect(), held()], [{ ok: true, name: NAME }, "mystore"]);

  await setUp();
  redis.run(["SET", KEY, "mystore"]);
  postStatus = 500;
  is("proved for this store, Vercel refusing: unavailable, the proved key never deleted", [await connect(), held()], [{ ok: false, reason: "unavailable" }, "mystore"]);

  await setUp();
  await renameHandle(owner, "newstore");
  redis.run(["SET", KEY, "?mystore", "EX", 200_000]);
  is("claimed under an address this store still owns: connected", await connect(), { ok: true, name: NAME });

  part("(a) controls: Vercel not answering, then the next press");
  await setUp();
  postThrows = true;
  is("Vercel's call throwing: unavailable, the store's own claim let go at once", [await connect(), held()], [{ ok: false, reason: "unavailable" }, null]);
  postThrows = false;
  is("the next press connects", [await connect(), held()], [{ ok: true, name: NAME }, "?mystore"]);

  part("(a) protection kept: another store's claim, and an address let go of");
  for (const other of ["?otherstore", "otherstore"]) {
    await setUp();
    redis.run(["SET", KEY, other]);
    is(`held by another store (${other}): taken, Vercel not asked, its key kept`, [await connect(), vercelCalls, held()], [{ ok: false, reason: "taken" }, [], other]);
  }
  await setUp();
  await renameHandle(owner, "newstore");
  await releaseHandle(owner, "mystore");
  redis.run(["SET", KEY, "?mystore", "EX", 200_000]);
  is("held under an address this store let go of: taken (it may be somebody else's now)", [await connect(), vercelCalls, held()], [{ ok: false, reason: "taken" }, [], "?mystore"]);
  for (const [shape, reply] of UNREADABLE) {
    await setUp();
    redis.run(["SET", KEY, "?otherstore"]);
    answer(setNx(KEY), (real) => real);
    answer(getOf(KEY), reply);
    is(`taken, and who holds it read as ${shape}: try again, Vercel not asked, the key kept`, [await connect(), vercelCalls, held()], ["try again", [], "?otherstore"]);
  }

  part("(b) pointDomain reads exactly and says when the domain did not follow");
  redis.clear();
  clearAnswers();
  redis.run(["SET", KEY, "mystore"]);
  swapTo("newstore");
  is("healthy: moved to the new address", [await point(), held()], [true, "newstore"]);
  redis.clear();
  redis.run(["SET", KEY, "?mystore"]);
  swapTo("?newstore");
  is("healthy, not proved: stays not proved", [await point(), held()], [true, "?newstore"]);
  redis.clear();
  clearAnswers();
  redis.run(["SET", KEY, "otherstore"]);
  is("held by another store: nothing to move, and nothing wrong", [await point(), held()], [true, "otherstore"]);
  redis.clear();
  is("held by nobody: nothing to move", await point(), true);
  for (const [shape, reply] of UNREADABLE) {
    redis.clear();
    clearAnswers();
    redis.run(["SET", KEY, "mystore"]);
    answer(getOf(KEY), reply);
    is(`the read ${shape}: not known to follow, nothing written`, [await point(), held()], [false, "mystore"]);
  }
  for (const [shape, reply] of [["lost", () => []], ["a failure", THROWS], ["a string", () => ["1"]], ["0 (changed meanwhile)", () => [0]]] as [string, (real: unknown[]) => unknown][]) {
    redis.clear();
    clearAnswers();
    redis.run(["SET", KEY, "mystore"]);
    answer(evalOn, reply, { run: false });
    is(`the swap's reply ${shape}: not known to follow`, await point(), false);
  }

  part("(b) the rename tells the creator when the domain did not follow");
  const rename = async (session: string) =>
    (await (await renameRoute(new NextRequest("https://marktmorgen.com/api/store/rename", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ handle: "newstore" }) }))).json()) as Record<string, unknown>;
  let session = await setUp();
  await setDomain(owner, { name: NAME, addedAt: "2026-11-01T12:00:00.000Z", liveAt: "2026-11-01T12:00:00.000Z" });
  redis.run(["SET", KEY, "mystore"]);
  answer(getOf(KEY), THROWS);
  const behind = await rename(session);
  is("renamed, and the answer says the domain is behind", [behind.ok, behind.handle, behind.domainBehind], [true, "newstore", true]);
  session = await setUp();
  await setDomain(owner, { name: NAME, addedAt: "2026-11-01T12:00:00.000Z", liveAt: "2026-11-01T12:00:00.000Z" });
  redis.run(["SET", KEY, "mystore"]);
  swapTo("newstore");
  const healthy = await rename(session);
  is("healthy rename: no such word, the domain moved", [healthy.ok, healthy.domainBehind, held()], [true, undefined, "newstore"]);
  const form = readFileSync("components/rename-form.tsx", "utf8");
  is("the rename form reads it and names the step that moves the domain", [/domainBehind/.test(form), /Check again/.test(form)], [true, true]);

  done();
}

main().catch((error) => {
  process.stderr.write(`${String((error as Error)?.stack ?? error)}\n`);
  process.exit(1);
});
