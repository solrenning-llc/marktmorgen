/**
 * A test meeting (lib/meet-test.ts) is never kept after the connection it was made on was deleted while it was being
 * made or moved (CX-123 rules 24 and 30): the sibling, in makeTest and moveTest, of the race claude5/zoom-forget-race
 * closed in keepConnection.
 *
 * Before: makeTest and moveTest read the record, called the provider (seconds, on a slow day), then wrote the record
 * back with a plain SET. A deletion confirmed in the middle (Zoom's notice that the person removed the app, acted on
 * by forgetUser; the creator's own Disconnect; the creator deleting the test meeting) deleted the record, and the SET
 * that followed wrote it again: the meeting's id and link kept for an account whose data had been confirmed deleted,
 * or a deleted test meeting shown again. And two makes at once kept the later one over the first.
 *
 * Now the record is written only in one step (lib/meet-connect.ts keepTest, KEEP_TEST_UNLESS_GONE) that finds the
 * store's connection still there for the same account, no deletion of that account marked since the make or the move
 * began (forgetUser's mark, the one KEEP_UNLESS_GONE reads), and the record still as it was read.
 *
 * Synthetic stores and Redis (tests/redis-stub.ts); Zoom is a stand-in fetch, nothing leaves the process.
 */
import { createHash } from "node:crypto";
import { disconnect, finishConsent, forgetUser, NotConnected, testKey } from "@/lib/meet-connect";
import { makeTest, moveTest, removeTest, TestMeetingUnavailable } from "@/lib/meet-test";
import { claimHandle, ensureStatsId, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.ZOOM_CLIENT_ID = "z-id";
process.env.ZOOM_CLIENT_SECRET = "z-secret";
process.env.ZOOM_WEBHOOK_SECRET_TOKEN = "z-token";
process.env.ZOOM_LIVE = "1";
delete process.env.ZOOM_API_BASE;

const USER = "zoomTestGoneUser01";
let tokenNumber = 0;
let meetingNumber = 812_000_000_00;
/** The meetings made, moved and deleted on the stand-in Zoom, by id. */
const made: string[] = [];
const moved: string[] = [];
const deleted: string[] = [];
/** Run once, just before the stand-in Zoom answers the next make or move: a deletion landing mid-flow. */
let onCreate: (() => Promise<unknown>) | null = null;
let onMove: (() => Promise<unknown>) | null = null;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = (init?.method ?? "GET").toUpperCase();
  const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status });
  if (url.hostname === "zoom.us" && url.pathname === "/oauth/token") {
    tokenNumber += 1;
    return json(200, { access_token: `access-${tokenNumber}`, refresh_token: `refresh-${tokenNumber}`, expires_in: 3600, scope: "meeting:write:meeting user:read:user" });
  }
  if (url.hostname === "zoom.us" && url.pathname === "/oauth/revoke") return json(200, { status: "success" });
  if (url.hostname !== "api.zoom.us") return json(404, { message: "no stand-in" });
  if (url.pathname === "/v2/users/me" && method === "GET") return json(200, { id: USER, email: "host@example.com", first_name: "Jenny", last_name: "Park" });
  if (url.pathname === "/v2/users/me/meetings" && method === "POST") {
    const id = String((meetingNumber += 1));
    made.push(id);
    if (onCreate) {
      const run = onCreate;
      onCreate = null;
      await run();
    }
    return json(201, { id: Number(id), join_url: `https://zoom.us/j/${id}?pwd=abc` });
  }
  const one = url.pathname.match(/^\/v2\/meetings\/(\d+)$/);
  if (one && method === "PATCH") {
    moved.push(one[1]);
    if (onMove) {
      const run = onMove;
      onMove = null;
      await run();
    }
    return new Response(null, { status: 204 });
  }
  if (one && method === "DELETE") {
    deleted.push(one[1]);
    return new Response(null, { status: 204 });
  }
  return json(404, { message: "no stand-in" });
}) as typeof fetch;

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 40);
const userIndex = `nl:meet:user:zoom:${hash(`meet-user:zoom:${USER}`)}`;
const goneMark = `nl:meet:gone:zoom:${hash(`meet-gone:zoom:${USER}`)}`;
const connKey = (statsId: string) => `nl:meet:conn:${statsId}:zoom`;

type Command = (string | number)[];
/** Replies replaced, for the next pipeline a predicate matches: the slot of the command matched gets `reply`. */
let weird: { match: (c: Command) => boolean; reply: unknown } | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  const out = (await pipeline(commands)) as unknown[];
  if (weird && commands.some(weird.match)) {
    const { match, reply } = weird;
    weird = null;
    return commands.map((c, i) => (match(c) ? reply : out[i]));
  }
  return out;
}) as typeof redis.pipeline;

const realNow = Date.now;
const outcome = async <T,>(run: () => Promise<T>): Promise<string> => {
  try {
    const value = await run();
    return value === null ? "null" : "made";
  } catch (error) {
    if (error instanceof NotConnected) return "not connected";
    if (error instanceof TestMeetingUnavailable) return "unavailable";
    return `other: ${error instanceof Error ? error.message : String(error)}`;
  }
};

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  const email = "mtgone@example.com";
  await claimHandle(email, "mtgone", "mtgone", "");
  await ensureStatsId(email);
  const store = (await storeForEmail(email)) as Store;
  const statsId = store.statsId!;
  const test = testKey(statsId, "zoom");
  const record = () => redis.run(["GET", test]);
  const connect = async (startedAt = Date.now()) => {
    const answer = await finishConsent("zoom", { statsId, code: `code-${tokenNumber}`, verifier: "v".repeat(43), by: email, owner: { email, handle: "mtgone" }, startedAt });
    if (!answer.ok) throw new Error(`set-up: not connected (${answer.error})`);
  };
  const reset = async () => {
    redis.run(["DEL", connKey(statsId), test, userIndex, goneMark]);
    made.length = 0;
    moved.length = 0;
    deleted.length = 0;
    onCreate = null;
    onMove = null;
    weird = null;
    Date.now = realNow;
    await connect();
  };

  part("Control: with nothing in between, a test meeting is made, kept and moved");
  await reset();
  is("made", await outcome(() => makeTest(store, "zoom")), "made");
  is("kept", typeof record() === "string" && JSON.parse(record() as string).id === made[0], true);
  const start = JSON.parse(record() as string).start as number;
  is("moved", await outcome(() => moveTest(store, "zoom")), "made");
  is("kept at its new hour", JSON.parse(record() as string).start, start + 3_600_000);

  part("Zoom's notice acted on while the test meeting is made: no record kept");
  await reset();
  onCreate = () => forgetUser("zoom", USER);
  const madeAcross = await outcome(() => makeTest(store, "zoom"));
  is("the connection was forgotten (set-up)", redis.run(["EXISTS", connKey(statsId)]), 0);
  is("not said to be made: the account is no longer connected", madeAcross, "not connected");
  is("no test meeting kept for the deleted account", record(), null);

  part("The creator's own Disconnect while the test meeting is made: no record kept");
  await reset();
  onCreate = () => disconnect(statsId, "zoom");
  is("not said to be made", await outcome(() => makeTest(store, "zoom")), "not connected");
  is("no test meeting kept for the connection that is gone", record(), null);

  part("Zoom's notice acted on while the test meeting is moved: the record is not written back");
  await reset();
  is("made (set-up)", await outcome(() => makeTest(store, "zoom")), "made");
  onMove = () => forgetUser("zoom", USER);
  is("not said to be moved", await outcome(() => moveTest(store, "zoom")), "not connected");
  is("no test meeting kept for the deleted account", record(), null);

  part("The creator deletes the test meeting while it is moved: it is not shown again");
  await reset();
  is("made (set-up)", await outcome(() => makeTest(store, "zoom")), "made");
  onMove = () => removeTest(statsId, "zoom");
  is("the move is not said to be done over the deletion", await outcome(() => moveTest(store, "zoom")), "unavailable");
  is("deleted at Zoom (set-up)", deleted.length, 1);
  is("the deleted test meeting is not kept again", record(), null);

  part("Deleted and connected again while the test meeting is made: the deletion's mark still stops it");
  await reset();
  // The make begins a minute ago; Zoom's notice is acted on half a minute ago; the person connects again now, a
  // flow begun well after the deletion. The connection is there again, for the same account, but the make began
  // before the deletion, so what it made is not kept.
  Date.now = () => realNow() - 60_000;
  onCreate = async () => {
    Date.now = () => realNow() - 30_000;
    await forgetUser("zoom", USER);
    Date.now = realNow;
    await connect(realNow());
  };
  is("not said to be made", await outcome(() => makeTest(store, "zoom")), "not connected");
  is("connected again (set-up)", redis.run(["EXISTS", connKey(statsId)]), 1);
  is("no test meeting kept from the make begun before the deletion", record(), null);

  part("Control: a deletion older than the make does not stop it");
  await reset();
  Date.now = () => realNow() - 120_000;
  await forgetUser("zoom", USER);
  Date.now = realNow;
  await connect(realNow());
  is("made", await outcome(() => makeTest(store, "zoom")), "made");
  is("kept", typeof record() === "string" && JSON.parse(record() as string).id === made[0], true);

  part("Two makes at once: the second does not write over the first");
  await reset();
  let inner = "";
  onCreate = async () => {
    inner = await outcome(() => makeTest(store, "zoom"));
  };
  const outer = await outcome(() => makeTest(store, "zoom"));
  is("the inner make finished first (set-up)", inner, "made");
  is("the outer make is not said to be made over it", outer, "unavailable");
  is("the first record kept is still the one there", JSON.parse(record() as string).id, made[1]);
  is("the meeting the outer make made is deleted at Zoom, not left behind", deleted, [made[0]]);

  part("The keep's own reply in a shape no Redis gives is never 'made'");
  for (const [shape, reply] of [["OK", "OK"], ["nil", null], ["-1", -1], ["9", 9], ["2.5", 2.5]] as const) {
    await reset();
    weird = { match: (c) => ["EVAL", "SET"].includes(String(c[0]).toUpperCase()) && c.includes(test), reply };
    is(`${shape}: not said to be made`, await outcome(() => makeTest(store, "zoom")), "unavailable");
  }

  Date.now = realNow;
  done();
}

void main();
