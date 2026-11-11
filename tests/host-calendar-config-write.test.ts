/**
 * A host's calendar settings are written only when Redis says so (CX-123 rule 24).
 *
 * removeHostIcs, disconnectHostGoogle and setHostSource write the host's settings
 * (nl:hostcal:cfg:<host>) through writeConfig. When that SET's reply was not "OK"
 * (missing, short, queued, another shape), the write is unknown: before this test,
 * removeHostIcs still resolved, the route answered ok and the studio said "Calendar
 * address removed.", while the sealed private iCal address stayed the host's source
 * and the next booking-page refresh fetched it again. Now the unknown reply throws
 * UnknownReplyError and the route answers 500, so the host is never told an address
 * was forgotten when it was not. Forgetting what was read from it (the DEL of the
 * last reading and failure) is read the same way.
 *
 * Synthetic data only; no calendar, Google or network is reached.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/host-calendar/route";
import { openSession, SESSION_COOKIE } from "@/lib/auth";
import { disconnectHostGoogle, hostSync, removeHostIcs, setHostSource } from "@/lib/host-calendar";
import { hostId } from "@/lib/host-claims";
import { UnknownReplyError } from "@/lib/redis-reply";
import { seal } from "@/lib/secret-box";
import { type Store, claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
globalThis.fetch = (async () => {
  throw new Error("Unexpected external request in a synthetic test");
}) as typeof fetch;

const EMAIL = "host@example.com";
const HOST = hostId(EMAIL);
const CFG = `nl:hostcal:cfg:${HOST}`;
const GOOD = `nl:hostcal:good:${HOST}`;
const ERR = `nl:hostcal:err:${HOST}`;
const URL_ICS = "https://calendar.example.com/private-abc123.ics";
const statsStore = { statsId: "s0000000000000000077" };
/** setHostSource takes a whole store; it reads only statsId and the paid period (none here). */
const sourceStore = statsStore as unknown as Store;
const real = redis.pipeline.bind(redis);

/** SET replies that are not Redis confirming the write. */
const UNKNOWN_SET: unknown[] = [[], [undefined], ["QUEUED"], [null], [1], [["OK"]], ["OK", "OK"], ["ok"], {}];
/** DEL replies that are not a count. */
const UNKNOWN_DEL: unknown[] = [[], [undefined], ["QUEUED"], [null], [-1], [1.5], ["1"], [1, 1]];

/** A reply's shape in words, with a missing slot shown as such (JSON would print it as null). */
const label = (shape: unknown): string => (Array.isArray(shape) ? `[${shape.map((v) => (v === undefined ? "undefined" : JSON.stringify(v))).join(",")}]` : JSON.stringify(shape));

function seed(source: "ics" | "google" | "none"): void {
  redis.clear();
  redis.run(["SET", CFG, JSON.stringify({ email: EMAIL, source, read: ["primary"], write: "", ics: seal(URL_ICS, `hostcal|${HOST}|ics`), icsAddedAt: "2026-11-01T00:00:00.000Z" })]);
  redis.run(["SET", GOOD, JSON.stringify({ at: Date.now(), busy: [[1, 2]], source: "ics" }), "EX", 600]);
  redis.run(["SET", ERR, JSON.stringify({ at: Date.now(), message: "synthetic" }), "EX", 600]);
}

/** Answers `shape` for the first command `which` matches, Redis's own answer otherwise. */
function answer(which: (command: (string | number)[]) => boolean, shape: unknown): void {
  redis.pipeline = (async (commands: (string | number)[][]) => (commands[0] && which(commands[0]) ? shape : real(commands))) as typeof redis.pipeline;
}
const isCfgSet = (command: (string | number)[]) => command[0] === "SET" && command[1] === CFG;
const isReadingsDel = (command: (string | number)[]) => command[0] === "DEL" && command[1] === GOOD;

async function thrown(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "resolved";
  } catch (error) {
    return error instanceof UnknownReplyError ? "UnknownReplyError" : `other: ${String(error)}`;
  }
}

function kept(): { source: string; ics: boolean } {
  const raw = redis.run(["GET", CFG]);
  const config = JSON.parse(String(raw)) as { source: string; ics: string };
  return { source: config.source, ics: config.ics.length > 0 };
}

async function fetchesOnRefresh(): Promise<number> {
  let fetched = 0;
  await hostSync(statsStore, EMAIL, "UTC", { refresh: true, force: true, hooks: { feed: { resolve: async () => { fetched += 1; throw new Error("synthetic: no network"); } } } });
  return fetched;
}

async function main(): Promise<void> {
  part("removeHostIcs: an unconfirmed settings write is refused, never told as removed");
  for (const shape of UNKNOWN_SET) {
    seed("ics");
    answer(isCfgSet, shape);
    const outcome = await thrown(() => removeHostIcs(statsStore, EMAIL));
    redis.pipeline = real;
    is(`SET answered ${label(shape)}: removeHostIcs throws UnknownReplyError`, outcome, "UnknownReplyError");
  }

  part("removeHostIcs: forgetting what was read is read as a count");
  for (const shape of UNKNOWN_DEL) {
    seed("ics");
    answer(isReadingsDel, shape);
    const outcome = await thrown(() => removeHostIcs(statsStore, EMAIL));
    redis.pipeline = real;
    is(`DEL answered ${label(shape)}: removeHostIcs throws UnknownReplyError`, outcome, "UnknownReplyError");
  }

  part("disconnectHostGoogle and setHostSource: the same settings write");
  for (const shape of UNKNOWN_SET) {
    seed("google");
    answer(isCfgSet, shape);
    const disconnecting = await thrown(() => disconnectHostGoogle(statsStore, EMAIL));
    redis.pipeline = real;
    is(`SET answered ${label(shape)}: disconnectHostGoogle throws UnknownReplyError`, disconnecting, "UnknownReplyError");
    seed("ics");
    answer(isCfgSet, shape);
    const choosing = await thrown(() => setHostSource(sourceStore, EMAIL, "none"));
    redis.pipeline = real;
    is(`SET answered ${label(shape)}: setHostSource throws UnknownReplyError`, choosing, "UnknownReplyError");
  }
  for (const shape of UNKNOWN_DEL) {
    seed("google");
    answer(isReadingsDel, shape);
    const outcome = await thrown(() => disconnectHostGoogle(statsStore, EMAIL));
    redis.pipeline = real;
    is(`DEL answered ${label(shape)}: disconnectHostGoogle throws UnknownReplyError`, outcome, "UnknownReplyError");
  }

  part("the route: an unconfirmed removal answers 500, not ok");
  redis.clear();
  const owner = "calendar-owner@example.com";
  await claimHandle(owner, "calendarowner", "A store", "");
  await ensureStatsId(owner);
  const ownerStore = (await storeForEmail(owner))!;
  const token = await openSession(owner);
  const ownerHost = hostId(owner);
  const ownerCfg = `nl:hostcal:cfg:${ownerHost}`;
  const request = (action: string) => new NextRequest("https://local.example/api/store/host-calendar", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://local.example", Host: "local.example", Cookie: `${SESSION_COOKIE}=${token}` },
    body: JSON.stringify({ action, tz: "UTC" }),
  });
  const seedOwner = () => redis.run(["SET", ownerCfg, JSON.stringify({ email: owner, source: "ics", read: [], write: "", ics: seal(URL_ICS, `hostcal|${ownerHost}|ics`), icsAddedAt: "2026-11-01T00:00:00.000Z" })]);
  for (const shape of [[], ["QUEUED"], [null]] as unknown[]) {
    seedOwner();
    answer((command) => command[0] === "SET" && command[1] === ownerCfg, shape);
    const response = await POST(request("ics-remove"));
    redis.pipeline = real;
    const body = (await response.json()) as { ok: boolean };
    is(`SET answered ${label(shape)}: ics-remove answers 500 and not ok`, [response.status, body.ok], [500, false]);
    const config = JSON.parse(String(redis.run(["GET", ownerCfg]))) as { source: string; ics: string };
    is(`SET answered ${label(shape)}: the address is still kept, and nobody was told otherwise`, [config.source, config.ics.length > 0], ["ics", true]);
  }
  seedOwner();
  const healthy = await POST(request("ics-remove"));
  const healthyBody = (await healthy.json()) as { ok: boolean; view: { source: string; ics: unknown } };
  is("healthy: ics-remove answers 200 ok with no address and no source", [healthy.status, healthyBody.ok, healthyBody.view.source, healthyBody.view.ics], [200, true, "none", null]);
  is("healthy: the store used for the route is the synthetic one", Boolean(ownerStore.statsId), true);

  part("healthy and confirmed-empty controls");
  seed("ics");
  is("healthy: removeHostIcs resolves", await thrown(() => removeHostIcs(statsStore, EMAIL)), "resolved");
  is("healthy: the address is forgotten and the source is none", kept(), { source: "none", ics: false });
  is("healthy: what was read from it is forgotten", [redis.run(["GET", GOOD]), redis.run(["GET", ERR])], [null, null]);
  is("healthy: the next refresh fetches nothing", await fetchesOnRefresh(), 0);
  seed("google");
  is("healthy: disconnectHostGoogle resolves", await thrown(() => disconnectHostGoogle(statsStore, EMAIL)), "resolved");
  is("healthy: the Google source is gone, the iCal address untouched", kept(), { source: "none", ics: true });
  seed("ics");
  is("healthy: setHostSource resolves", await thrown(() => setHostSource(sourceStore, EMAIL, "none")), "resolved");
  is("healthy: the source is none", kept().source, "none");
  redis.clear();
  is("confirmed empty: removeHostIcs with no settings resolves", await thrown(() => removeHostIcs(statsStore, EMAIL)), "resolved");
  is("confirmed empty: and writes nothing", redis.run(["GET", CFG]), null);
  is("confirmed empty: disconnectHostGoogle with no settings resolves", await thrown(() => disconnectHostGoogle(statsStore, EMAIL)), "resolved");
  is("confirmed empty: and writes nothing", redis.run(["GET", CFG]), null);
  seed("ics");
  redis.run(["DEL", GOOD, ERR]);
  is("confirmed empty: removeHostIcs with nothing read yet (DEL answers 0) resolves", await thrown(() => removeHostIcs(statsStore, EMAIL)), "resolved");
  is("confirmed empty: and the address is forgotten", kept(), { source: "none", ics: false });

  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
