/**
 * Meta's deletion callback confirmed in the middle of a write never leaves data behind (CX-123 rules 24 and 30;
 * lib/meta-ads.ts). Every write in lib/meta-ads.ts that is made only "while that very connection is still there"
 * is the check and the write in one step, so a deletion (forgetMetaUser, disconnectMeta) that lands between them
 * finds nothing written afterwards:
 *
 *   - the spend lines a daily read keeps (nl:stats:<id>:spend:meta, 400 days);
 *   - `note`, the read's own record (nl:metaads:read:<id>: day, cents, campaigns, the problem);
 *   - markBroken, which writes the connection back with the reason it broke;
 *   - chooseAccount, which writes the connection back with the account chosen.
 *
 * Before: each one read the connection, then wrote in a separate command, and forgetMetaUser takes no lock, so a
 * deletion confirmed to Meta (it gets a confirmation_code) between the two had the lines, the record or even the
 * sealed token and the owner's address written again, kept with no index left to find them.
 *
 * The deletion is made to land just before the write reaches Redis, whatever command carries it, so the test reads
 * the same on the old code (check, then write) and on one where the check and the write are one command.
 */
import { createHash, createHmac } from "node:crypto";
import { chooseAccount, finishMeta, forgetMetaUser, linesKey, readMetaSpend } from "@/lib/meta-ads";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const SECRET = "meta-app-secret-for-tests-0123456789";
process.env.META_APP_ID = "123456789012345";
process.env.META_APP_SECRET = SECRET;
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
delete process.env.META_GRAPH_BASE;
delete process.env.META_GRAPH_VERSION;

const USER = "10150000000000002";
const today = new Date().toISOString().slice(0, 10);
/** How Meta answers the next ad spend read: the rows, a refusal of the token, or an outage. */
let insights: "rows" | "auth" | "outage" = "rows";
/** How many times the permission was given back to Meta (DELETE /me/permissions). */
let gaveBack = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname !== "graph.facebook.com") return json({ object: "list", data: [], has_more: false });
  const path = url.pathname.replace(/^\/v\d+\.\d+/, "");
  const method = init?.method ?? "GET";
  const token = url.searchParams.get("access_token");
  if (token && url.searchParams.get("appsecret_proof") !== createHmac("sha256", SECRET).update(token).digest("hex")) return json({ error: { code: 190 } }, 400);
  if (path === "/oauth/access_token") return url.searchParams.get("grant_type") === "fb_exchange_token" ? json({ access_token: "EAAlong", expires_in: 5_184_000 }) : json({ access_token: "EAAshort" });
  if (path === "/me/permissions" && method === "DELETE") {
    gaveBack += 1;
    return json({ success: true });
  }
  if (path === "/me/permissions") return json({ data: [{ permission: "ads_read", status: "granted" }] });
  if (path === "/me") return json({ id: USER });
  if (path === "/me/adaccounts") {
    return json({ data: [
      { id: "act_333", account_id: "333", name: "Race Ads", currency: "USD", account_status: 1 },
      { id: "act_444", account_id: "444", name: "Other Ads", currency: "USD", account_status: 1 },
    ] });
  }
  if (path === "/act_333/insights") {
    if (insights === "auth") return json({ error: { code: 190, message: "Error validating access token" } }, 400);
    if (insights === "outage") return json({ error: { code: 2, message: "Service temporarily unavailable" } }, 503);
    return json({ data: [{ campaign_id: "1", campaign_name: "Reel", spend: "30.00", date_start: today, publisher_platform: "instagram" }] });
  }
  return json({ error: { code: 803, message: "unknown" } }, 404);
}) as typeof fetch;

const pipeline = redis.pipeline.bind(redis);
/** The key whose next write the deletion lands just before; "" when nothing is armed. */
let armedFor = "";
/** What the deletion callback answered: the stores it confirmed to Meta as deleted. */
let forgotNow: unknown = null;
const WRITES = new Set(["SET", "EVAL", "EVALSHA"]);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const target = armedFor;
  if (target && commands.some((c) => WRITES.has(String(c[0]).toUpperCase()) && c.slice(1).some((arg) => arg === target))) {
    armedFor = "";
    // Meta's deletion callback lands after the connection was checked and before the write reaches Redis.
    forgotNow = await forgetMetaUser(USER).catch((error: unknown) => `threw ${error}`);
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

const confirmed = () => (Array.isArray(forgotNow) ? forgotNow.length : forgotNow);

/** Every reply of the next pipeline that carries an EVAL, when set: a reply in a shape no Redis gives. */
let weird: unknown = undefined;
/** The key whose EVAL the deletion lands just after; "" when nothing is armed. */
let after = "";
/** The deletion's own mark is answered in a shape no Redis gives, when true. */
let weirdMark = false;
const armed = redis.pipeline;
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (weird !== undefined && commands.some((c) => String(c[0]).toUpperCase() === "EVAL")) return commands.map(() => weird);
  if (weirdMark && commands.some((c) => String(c[0]).toUpperCase() === "SET" && String(c[1]).startsWith("nl:metaads:gone:"))) {
    weirdMark = false;
    return commands.map(() => "QUEUED");
  }
  const out = await armed(commands);
  if (after && commands.some((c) => String(c[0]).toUpperCase() === "EVAL" && c.includes(after))) {
    after = "";
    // Meta's deletion callback lands just after the write reached Redis.
    forgotNow = await forgetMetaUser(USER).catch((error: unknown) => `threw ${error}`);
  }
  return out;
}) as typeof redis.pipeline;

/** The index of the stores a Meta user connected (lib/meta-ads.ts userKey), as Redis names it. */
const userIndex = (user: string) => `nl:metaads:user:${createHash("sha256").update(`metaads-user:${user}`).digest("hex").slice(0, 40)}`;
/** The mark a deletion leaves for a Meta user (lib/meta-ads.ts goneKey), as Redis names it. */
const goneMark = (user: string) => `nl:metaads:gone:${createHash("sha256").update(`metaads-gone:${user}`).digest("hex").slice(0, 40)}`;

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  await claimHandle("metarace@example.com", "metarace", "Meta Race", "");
  await ensureStatsId("metarace@example.com");
  const store = (await storeForEmail("metarace@example.com"))!;
  const statsId = store.statsId!;
  const connKey = `nl:metaads:conn:${statsId}`;
  const readKey = `nl:metaads:read:${statsId}`;
  // A consent flow that began at `startedAt` (lib/meta-ads.ts beginMeta) and is finished now.
  const fin = (startedAt = Date.now()) =>
    finishMeta({ statsId, sid: store.sid, code: "good-code", redirect: "https://marktmorgen.com/api/integrations/meta/callback", by: "metarace@example.com", owner: { email: store.email, handle: store.handle }, currency: store.currency, startedAt });
  const connect = async () => {
    // A prior case's deletion leaves its mark: each case starts as if that deletion were long past.
    await pipeline([["DEL", goneMark(USER)]]);
    const connected = await fin();
    if (!connected.ok) throw new Error(`not connected: ${connected.error}`);
    // Two accounts in the store's currency: none is taken for the creator, so the one read is chosen here.
    if (!(await chooseAccount(statsId, "act_333"))) throw new Error("the account could not be chosen");
    // Nothing a prior case left (a read lock, a read record) changes the next one.
    await pipeline([["DEL", `nl:metaads:reading:${statsId}`], ["DEL", readKey], ["DEL", linesKey(statsId)]]);
    forgotNow = null;
  };
  const kept = async () => pipeline([["EXISTS", connKey], ["EXISTS", linesKey(statsId)], ["EXISTS", readKey]]);
  /** Everything about the person: the connection, the lines, the read's record, and the store in the person's index. */
  const keptAll = async () => [...(await kept()), Number((await pipeline([["SISMEMBER", userIndex(USER), statsId]]))[0])];

  part("Control: a deletion with nothing under way leaves nothing");
  await connect();
  insights = "rows";
  is("a read with nothing in its way reads", await readMetaSpend(statsId, store.currency), "read");
  is("it kept the lines and its record", (await kept()).slice(1, 3), [1, 1]);
  is("the deletion confirms the store", ((await forgetMetaUser(USER)) as unknown[]).length, 1);
  is("connection, lines and record all gone", await kept(), [0, 0, 0]);

  part("The spend lines: a deletion confirmed just before the daily read writes them");
  await connect();
  insights = "rows";
  armedFor = linesKey(statsId);
  const lines = await readMetaSpend(statsId, store.currency).catch((error: unknown) => `threw ${error}`);
  is("the deletion was confirmed to Meta for the store", confirmed(), 1);
  is("the read does not say it read", lines === "read", false);
  is("nothing read from Meta is kept after the confirmed deletion (connection, lines, record)", await kept(), [0, 0, 0]);

  part("note: a deletion confirmed just before a failed read writes its record");
  await connect();
  insights = "outage";
  armedFor = readKey;
  const noted = await readMetaSpend(statsId, store.currency).catch((error: unknown) => `threw ${error}`);
  is("the deletion was confirmed to Meta for the store", confirmed(), 1);
  is("the read did not read", noted === "read", false);
  is("no record of the read is written back (connection, lines, record)", await kept(), [0, 0, 0]);

  part("markBroken: a deletion confirmed just before a refused token is written as broken");
  await connect();
  insights = "auth";
  armedFor = connKey;
  const broken = await readMetaSpend(statsId, store.currency).catch((error: unknown) => `threw ${error}`);
  is("the deletion was confirmed to Meta for the store", confirmed(), 1);
  is("the read did not read", broken === "read", false);
  is("the connection (sealed token, owner's address) is not written back (connection, lines, record)", await kept(), [0, 0, 0]);

  part("chooseAccount: a deletion confirmed just before the account chosen is written");
  await connect();
  armedFor = connKey;
  const chosen = await chooseAccount(statsId, "act_444").catch((error: unknown) => `threw ${error}`);
  is("the deletion was confirmed to Meta for the store", confirmed(), 1);
  is("the choice is not said as made on a connection that is gone", chosen, false);
  is("the connection is not written back (connection, lines, record)", await kept(), [0, 0, 0]);

  part("finishMeta: a deletion confirmed just before a reconnection writes the connection");
  await connect();
  gaveBack = 0;
  armedFor = connKey;
  const reconnected = await fin().catch((error: unknown) => `threw ${error}`);
  is("the deletion was confirmed to Meta for the store", confirmed(), 1);
  is("the reconnection says honestly that nothing was kept", reconnected, { ok: false, error: "removed" });
  is("nothing about the person is kept after the confirmed deletion (connection, lines, record, index)", await keptAll(), [0, 0, 0, 0]);
  is("the token the flow was holding is given back to Meta", gaveBack, 1);

  part("finishMeta: a deletion confirmed after the flow began, before it finishes");
  await connect();
  const began = Date.now();
  is("the deletion confirms the store", ((await forgetMetaUser(USER)) as unknown[]).length, 1);
  is("the flow begun before it is not kept", await fin(began), { ok: false, error: "removed" });
  is("nothing about the person is kept (connection, lines, record, index)", await keptAll(), [0, 0, 0, 0]);
  is("a flow begun within the clocks' margin after it is not kept either", await fin(Date.now() + 1_000), { ok: false, error: "removed" });

  part("finishMeta: a reconnection begun well after the deletion connects again");
  // The deletion's mark says it was confirmed two minutes ago: a consent given since is the person's new choice.
  await pipeline([["SET", goneMark(USER), String(Date.now() - 120_000), "EX", 86_400]]);
  const fresh = await fin();
  is("it connects", fresh.ok, true);
  is("and keeps the connection and the person's index", await keptAll(), [1, 0, 0, 1]);
  await forgetMetaUser(USER);

  part("finishMeta: a flow older than the deletion's mark can cover is not written");
  await pipeline([["DEL", goneMark(USER)]]);
  is("a flow begun 21 minutes ago is refused as expired", await fin(Date.now() - 21 * 60_000), { ok: false, error: "expired" });
  is("nothing is kept (connection, lines, record, index)", await keptAll(), [0, 0, 0, 0]);

  part("The inverse race: a deletion just after the read wrote its lines");
  await connect();
  insights = "rows";
  after = linesKey(statsId);
  const inverse = await readMetaSpend(statsId, store.currency).catch((error: unknown) => `threw ${error}`);
  is("the deletion was confirmed to Meta for the store", confirmed(), 1);
  is("the read read before it", inverse, "read");
  is("nothing is kept after it (connection, lines, record)", await kept(), [0, 0, 0]);

  part("A reply in a shape no Redis gives is unknown, never written or refused");
  await connect();
  weird = "1";
  is("chooseAccount fails closed", await chooseAccount(statsId, "act_444").then((v) => `ok ${v}`, (error: Error) => error.name), "UnknownReplyError");
  insights = "rows";
  is("a read does not say it read", await readMetaSpend(statsId, store.currency).catch((error: Error) => error.name), "error");
  insights = "auth";
  // Changed with the merge of main (rule 23): the reading lock is let go by a checked script now (lib/claim-mark.ts
  // releaseMark), which this part's bent replies answer in another shape too, so the read before keeps it, as a lost
  // reply would; it is taken off here, as its expiry would, so this read reaches the connection's mark again.
  await pipeline([["DEL", `nl:metaads:reading:${statsId}`]]);
  is("markBroken fails closed", await readMetaSpend(statsId, store.currency).then((v) => `ok ${v}`, (error: Error) => error.name), "UnknownReplyError");
  is("finishMeta fails closed", await fin().then((v) => `ok ${v.ok}`, (error: Error) => error.name), "UnknownReplyError");
  weird = undefined;
  weirdMark = true;
  is("a deletion whose mark is not confirmed does not say it deleted", await forgetMetaUser(USER).then((v) => `ok ${v.length}`, (error: Error) => error.name), "UnknownReplyError");
  is("the deletion confirms once its mark is written", ((await forgetMetaUser(USER)) as unknown[]).length, 1);

  part("Control: with nothing in the way, a choice and a broken token are still written");
  await connect();
  is("the other account is chosen", await chooseAccount(statsId, "act_444"), true);
  const afterChoice = JSON.parse(String((await pipeline([["GET", connKey]]))[0])) as { account?: string };
  is("the connection reads the account chosen", afterChoice.account, "act_444");
  is("choosing the account it already reads is a no-op that says yes", await chooseAccount(statsId, "act_444"), true);
  is("a choice of an account it does not have is refused", await chooseAccount(statsId, "act_999"), false);
  await chooseAccount(statsId, "act_333");
  insights = "auth";
  is("a refused token marks the connection broken", await readMetaSpend(statsId, store.currency), "broken");
  const afterBroken = JSON.parse(String((await pipeline([["GET", connKey]]))[0])) as { broken?: string };
  is("the connection says why it broke", typeof afterBroken.broken === "string" && afterBroken.broken.length > 0, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
