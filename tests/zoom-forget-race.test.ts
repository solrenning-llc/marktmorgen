/**
 * Zoom's notice that a user removed the app (forgetUser, app/api/integrations/zoom/deauthorize) never has its
 * deletion undone by a write that lands after it (CX-123 rules 24 and 30; lib/meet-connect.ts). The sibling of the
 * Meta fix in #3322 (finishMeta / forgetMetaUser), found by Claude 2 in its review of that PR.
 *
 * Before: keepConnection (the end of a consent flow, finishConsent) wrote the connection under its renewal lock, then
 * added the store to the Zoom user's index in a separate command, and forgetUser read that index with no lock and
 * deleted it whole at the end. So a notice acted on while a consent flow was finishing:
 *
 *   - read the index before the store was in it, confirmed the deletion to Zoom, and the connection (sealed tokens,
 *     the owner's address, the Zoom account's address and name) was then kept, with the index deleted under it;
 *   - or landed between the two writes, and the connection was kept and indexed again after the deletion;
 *   - and a connection made while it walked the stores lost its place in the index, so the next notice could not
 *     find it.
 *
 * The stores read in a shape no Redis gives were "none", and the index was deleted with nothing forgotten.
 *
 * The deletion is made to land just before the write that carries a key reaches Redis, whatever
 * command carries it, so the test reads the same on the old code (two commands) and on one where they are one step.
 */
import { createHash } from "node:crypto";
import { finishConsent, forgetUser } from "@/lib/meet-connect";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.ZOOM_CLIENT_ID = "z-id";
process.env.ZOOM_CLIENT_SECRET = "z-secret";
process.env.ZOOM_WEBHOOK_SECRET_TOKEN = "z-token";
delete process.env.ZOOM_LIVE;
delete process.env.ZOOM_API_BASE;

const USER = "zoomRaceUser01";
let tokenNumber = 0;
/** Every access token Zoom gave, and those given back to it (POST /oauth/revoke). */
const issued: string[] = [];
const revoked: string[] = [];

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status });
  if (url.hostname === "zoom.us" && url.pathname === "/oauth/token") {
    tokenNumber += 1;
    issued.push(`access-${tokenNumber}`);
    return json(200, { access_token: `access-${tokenNumber}`, refresh_token: `refresh-${tokenNumber}`, expires_in: 3600, scope: "meeting:write:meeting user:read:user" });
  }
  if (url.hostname === "zoom.us" && url.pathname === "/oauth/revoke") {
    // Zoom's revoke takes the token in the query (lib/meet-providers.ts revoke).
    revoked.push(url.searchParams.get("token") ?? "");
    return json(200, { status: "success" });
  }
  if (url.hostname === "api.zoom.us" && url.pathname === "/v2/users/me") return json(200, { id: USER, email: "host@example.com", first_name: "Jenny", last_name: "Park" });
  return json(404, { message: "no stand-in" });
}) as typeof fetch;

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 40);
/** The stores a Zoom user connected (lib/meet-connect.ts userKey), as Redis names it. */
const userIndex = `nl:meet:user:zoom:${hash(`meet-user:zoom:${USER}`)}`;
const connKey = (statsId: string) => `nl:meet:conn:${statsId}:zoom`;
/** The mark a deletion leaves for a Zoom user (lib/meet-connect.ts goneKey), as Redis names it. */
const goneMark = `nl:meet:gone:zoom:${hash(`meet-gone:zoom:${USER}`)}`;

type Command = (string | number)[];
const WRITES = new Set(["SET", "SADD", "EVAL", "EVALSHA"]);
const writes = (commands: Command[], key: string) => commands.some((c) => WRITES.has(String(c[0]).toUpperCase()) && c.slice(1).some((arg) => arg === key));

/** The key whose next write the deletion lands just before; "" when nothing is armed. */
let before = "";
/** What the deletion answered: the stores it confirmed to Zoom as forgotten, or what it threw. */
let forgotNow: unknown = null;
/** Run instead of the deletion, when set, just before the next DEL of this key (a connection made meanwhile). */
let duringDel: { key: string; run: () => Promise<unknown> } | null = null;
let duringResult: unknown = null;
/** Replies replaced, for the next pipeline a predicate matches: the slot of the command matched gets `reply`. */
let weird: { match: (c: Command) => boolean; reply: unknown } | null = null;
/** A clock moved back while the deletion begins, until its read of the user's stores has been answered. */
let shiftedUntilRead = 0;

const forgetNow = async () => {
  forgotNow = await forgetUser("zoom", USER).catch((error: unknown) => `threw ${error instanceof Error ? error.name : error}`);
};

const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  if (before && writes(commands, before)) {
    before = "";
    // Zoom's notice is acted on just before this write reaches Redis.
    await forgetNow();
  }
  if (duringDel && commands.some((c) => String(c[0]).toUpperCase() === "DEL" && c[1] === duringDel!.key)) {
    const run = duringDel.run;
    duringDel = null;
    duringResult = await run();
  }
  const out = (await pipeline(commands)) as unknown[];
  if (shiftedUntilRead && commands.some((c) => String(c[0]).toUpperCase() === "SMEMBERS" && c[1] === userIndex)) {
    shiftedUntilRead = 0;
    Date.now = realNow;
  }
  if (weird && commands.some(weird.match)) {
    const { match, reply } = weird;
    weird = null;
    return commands.map((c, i) => (match(c) ? reply : out[i]));
  }
  return out;
}) as typeof redis.pipeline;

const realNow = Date.now;
/** The deletion begins `ms` in the past: its mark (if any) is written with a clock moved back by that much. */
const deletionBegunAgo = (ms: number) => {
  shiftedUntilRead = ms;
  Date.now = () => realNow() - ms;
};

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  const stores: { statsId: string; owner: { email: string; handle: string } }[] = [];
  for (const handle of ["zrace-one", "zrace-two"]) {
    const email = `${handle}@example.com`;
    await claimHandle(email, handle, handle, "");
    await ensureStatsId(email);
    const store = (await storeForEmail(email))!;
    stores.push({ statsId: store.statsId!, owner: { email, handle } });
  }
  const [one, two] = stores;
  const consent = (statsId: string, startedAt = Date.now()) =>
    finishConsent("zoom", { statsId, code: `code-${statsId}`, verifier: "v".repeat(43), by: "owner@example.com", owner: one.owner, startedAt });
  const kept = (statsId: string) => [redis.run(["EXISTS", connKey(statsId)]), redis.run(["SISMEMBER", userIndex, statsId])];
  const reset = async () => {
    // Only what these cases write: the stores themselves stay as they are.
    for (const s of stores) redis.run(["DEL", connKey(s.statsId), `nl:meet:test:${s.statsId}:zoom`]);
    redis.run(["DEL", userIndex, goneMark]);
    forgotNow = null;
    duringResult = null;
    revoked.length = 0;
    issued.length = 0;
  };

  part("A deletion confirmed just before the connection is written keeps nothing");
  await reset();
  before = connKey(one.statsId);
  const first = await consent(one.statsId);
  is("Zoom's notice was acted on, with nothing yet to forget", forgotNow, []);
  is("the consent is refused as removed, not connected", first, { ok: false, error: "removed" });
  is("no connection and no index entry are left", kept(one.statsId), [0, 0]);
  is("the access this flow was holding is given back to Zoom", revoked, issued);

  part("A deletion confirmed between the connection and its index keeps nothing");
  await reset();
  before = userIndex;
  const second = await consent(one.statsId);
  is("the consent is refused as removed", second, { ok: false, error: "removed" });
  is("no connection and no index entry are left", kept(one.statsId), [0, 0]);
  is("the access is given back", revoked, issued);

  part("A consent begun before a deletion that has already finished keeps nothing");
  await reset();
  await forgetNow();
  const late = await consent(one.statsId, realNow() - 5_000);
  is("refused as removed", late, { ok: false, error: "removed" });
  is("nothing kept", kept(one.statsId), [0, 0]);
  is("and the access given back", revoked, issued);

  part("Control: a deletion just after the connection was kept forgets it");
  await reset();
  // After the consent returned: the keep is made holding the store's renewal lock, which the deletion waits for.
  const third = await consent(one.statsId);
  await forgetNow();
  is("connected first", third.ok, true);
  is("then forgotten by the notice, the owner to be told", Array.isArray(forgotNow) ? forgotNow.map((f: { statsId: string }) => f.statsId) : forgotNow, [one.statsId]);
  is("nothing left", kept(one.statsId), [0, 0]);

  part("Control: a consent begun well after the deletion connects");
  await reset();
  deletionBegunAgo(60_000);
  await forgetNow();
  Date.now = realNow;
  const again = await consent(one.statsId);
  is("connected", again.ok, true);
  is("kept and indexed, for the next notice to find", kept(one.statsId), [1, 1]);

  part("A connection made while a deletion walks the stores keeps its place in the index");
  await reset();
  is("the first store connected (set-up)", (await consent(one.statsId)).ok, true);
  deletionBegunAgo(60_000);
  duringDel = { key: connKey(one.statsId), run: () => consent(two.statsId, realNow()) };
  await forgetNow();
  Date.now = realNow;
  is("the second store connected meanwhile", (duringResult as { ok?: boolean } | null)?.ok, true);
  is("the first store is forgotten", Array.isArray(forgotNow) ? forgotNow.map((f: { statsId: string }) => f.statsId) : forgotNow, [one.statsId]);
  is("the first store's connection is gone and out of the index", kept(one.statsId), [0, 0]);
  is("the second store's connection is still indexed", kept(two.statsId), [1, 1]);

  part("A consent flow older than any consent can be keeps nothing");
  await reset();
  const stale = await consent(one.statsId, realNow() - 21 * 60_000);
  is("refused as expired", stale, { ok: false, error: "expired" });
  is("nothing kept", kept(one.statsId), [0, 0]);
  is("and no code traded for tokens", issued, []);

  part("The user's stores read in a shape no Redis gives: unknown, nothing deleted");
  for (const [shape, reply] of [["OK", "OK"], ["a number", 7], ["an object", {}], ["a list with a number", [one.statsId, 3]]] as const) {
    await reset();
    is(`connected (set-up, ${shape})`, (await consent(one.statsId)).ok, true);
    weird = { match: (c) => String(c[0]).toUpperCase() === "SMEMBERS" && c[1] === userIndex, reply };
    await forgetNow();
    is(`${shape}: the deletion is not answered as done`, typeof forgotNow === "string" && forgotNow.startsWith("threw"), true);
    is(`${shape}: the connection and the index are kept for Zoom's retry`, kept(one.statsId), [1, 1]);
  }

  part("The deletion's own mark not confirmed: unknown, nothing deleted");
  await reset();
  is("connected (set-up)", (await consent(one.statsId)).ok, true);
  weird = { match: (c) => String(c[0]).toUpperCase() === "SET" && String(c[1]).startsWith("nl:meet:gone:"), reply: "QUEUED" };
  await forgetNow();
  is("the deletion is not answered as done", typeof forgotNow === "string" && forgotNow.startsWith("threw"), true);
  is("the connection and the index are kept for Zoom's retry", kept(one.statsId), [1, 1]);

  part("The keep's own reply in a shape no Redis gives is never 'connected'");
  for (const [shape, reply] of [["OK", "OK"], ["2.5", "2.5"], ["nil", null], ["9", 9]] as const) {
    await reset();
    weird = { match: (c) => String(c[0]).toUpperCase() === "EVAL" && c.includes(userIndex), reply };
    const odd = await consent(one.statsId).catch((error: unknown) => `threw ${error instanceof Error ? error.name : error}`);
    is(`${shape}: not said to be connected`, typeof odd === "string" ? odd.startsWith("threw") : odd.ok === false, true);
  }

  Date.now = realNow;
  done();
}

void main();
