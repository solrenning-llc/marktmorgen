/**
 * Issue #4012 (Claude 1 cloud, integrations): a closing store's walk deleted its meeting and Meta connections
 * (`nl:meet:conn:`, `nl:metaads:conn:`) without giving their grants back at the provider, so its Google Calendar,
 * Zoom and Meta (`ads_read`) access stayed active there, with no token left here to end it.
 *
 * Now the closing store gives each grant back before its keys go, only when nothing else here uses the same account
 * (the account's index, as a disconnect does since #4011), and takes itself out of that index, so a store that is gone
 * never holds a live store's grant at the provider, nor keeps a later disconnect from giving it back.
 *
 * Synthetic only: fetch is mocked, no provider is called, every token is made up here.
 */
import { createHash } from "node:crypto";
import { WALK_GAP_MS, eraseClosed, markDue } from "@/lib/closed-store-data";
import { claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { seal } from "@/lib/secret-box";
import { store as redis } from "./redis-stub";
import { closeForErasure } from "./closed-for-erasure";
import { done, is, part } from "./check";

process.env.META_APP_SECRET ??= "tests-only-meta-secret";

const X = "closing-grants@example.com";
const OTHER = "s0000000000000000-otherstore1";
const ACCOUNT = "synthetic-google-account";
const META_USER = "10150000000004012";
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 40);
const meetUser = `nl:meet:user:google:${hash(`meet-user:google:${ACCOUNT}`)}`;
const metaUser = `nl:metaads:user:${hash(`metaads-user:${META_USER}`)}`;

const calls = { google: 0, meta: 0 };
/** How long each provider takes to answer, on the test clock (the store lock's time runs with it). */
let answerMs = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const u = new URL(String(input));
  if (answerMs) redis.advance(answerMs);
  if (init?.method === "POST" && u.pathname.endsWith("/revoke")) {
    calls.google++;
    return new Response("{}", { status: 200 });
  }
  if (init?.method === "DELETE" && u.pathname.endsWith("/me/permissions")) {
    calls.meta++;
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }
  throw Error(`Unexpected synthetic provider request: ${init?.method ?? "GET"} ${u.pathname}`);
}) as typeof fetch;

function meetConnection(statsId: string) {
  const ctx = (which: string) => `meet|${statsId}|google|${which}`;
  return JSON.stringify({
    provider: "google",
    account: { id: ACCOUNT, email: "creator@example.test", name: "" },
    refresh: seal("synthetic-grant", ctx("refresh")),
    access: seal("synthetic-grant", ctx("access")),
    expires: 0,
    scope: "",
    connectedAt: 1,
    by: "creator@example.test",
    owner: { email: "creator@example.test", handle: "fixture" },
    broken: "",
    brokenAt: 0,
  });
}
function metaConnection(statsId: string) {
  return JSON.stringify({
    user: META_USER,
    token: seal("synthetic-meta-token", `metaads|${statsId}|token`),
    expires: 0,
    accounts: [],
    account: "",
    connectedAt: 1,
    by: "creator@example.test",
    sid: "",
    owner: { email: "creator@example.test", handle: "fixture" },
    broken: "",
  });
}

async function closing(shared: boolean): Promise<{ statsId: string; at: number }> {
  redis.clear();
  calls.google = 0;
  calls.meta = 0;
  await claimHandle(X, "closinggrants", "Closing Grants", "");
  await ensureStatsId(X);
  await ensureStoreId(X);
  const store = await storeForEmail(X);
  if (!store?.statsId) throw new Error("setup: no store");
  const statsId = store.statsId;
  redis.run(["SET", `nl:meet:conn:${statsId}:google`, meetConnection(statsId)]);
  redis.run(["SADD", meetUser, statsId]);
  redis.run(["SET", `nl:metaads:conn:${statsId}`, metaConnection(statsId)]);
  redis.run(["SADD", metaUser, statsId]);
  redis.run(["SADD", "nl:metaads:stores", statsId]);
  if (shared) {
    redis.run(["SET", `nl:meet:conn:${OTHER}:google`, meetConnection(OTHER)]);
    redis.run(["SADD", meetUser, OTHER]);
    redis.run(["SET", `nl:metaads:conn:${OTHER}`, metaConnection(OTHER)]);
    redis.run(["SADD", metaUser, OTHER]);
  }
  await closeForErasure(X);
  const at = Date.now();
  await markDue(X, at - 1000);
  return { statsId, at };
}

async function main(): Promise<void> {
  part("A closing store that alone uses its Google and Meta accounts gives both grants back");
  {
    const { statsId, at } = await closing(false);
    const run = await eraseClosed(Date.now() + 30_000, async () => {}, at);
    is("set-up: the store was prepared and its record closed", [run.stores, (await storeForEmail(X)) === null], [1, true]);
    is("its Google grant is given back at the provider", calls.google, 1);
    is("its Meta permission is given back at the provider", calls.meta, 1);
    is("and it is out of both accounts' indexes", [redis.run(["SISMEMBER", meetUser, statsId]), redis.run(["SISMEMBER", metaUser, statsId])], [0, 0]);
    await eraseClosed(Date.now() + 30_000, async () => {}, at + WALK_GAP_MS + 1);
    is("the walk's next run gives nothing back twice", [calls.google, calls.meta], [1, 1]);
  }

  part("Another store here uses the same accounts: nothing is given back, and the closing store leaves the indexes");
  {
    const { statsId, at } = await closing(true);
    await eraseClosed(Date.now() + 30_000, async () => {}, at);
    is("no grant is given back while another store uses it", [calls.google, calls.meta], [0, 0]);
    is("the other store is still connected", [typeof redis.run(["GET", `nl:meet:conn:${OTHER}:google`]), typeof redis.run(["GET", `nl:metaads:conn:${OTHER}`])], ["string", "string"]);
    is("the closing store is out of both indexes, the other store still in them",
      [redis.run(["SISMEMBER", meetUser, statsId]), redis.run(["SISMEMBER", metaUser, statsId]), redis.run(["SISMEMBER", meetUser, OTHER]), redis.run(["SISMEMBER", metaUser, OTHER])], [0, 0, 1, 1]);
  }

  part("Slow providers, each within its own limit: the store's lock is made to last after each give-back (Claude 5 icRk's LEVE on #5477)");
  // The store lock lasts 15 s; Google and Meta each answering after 9 s (under their 8 s and 10 s limits once a retry
  // is counted) took 18 s in a row, so the lock ran out before the deletes and the store waited a walk.
  {
    const { at } = await closing(false);
    answerMs = 9_000;
    const run = await eraseClosed(Date.now() + 120_000, async () => {}, at).catch((error: unknown) => error);
    answerMs = 0;
    is("both grants are given back", [calls.google, calls.meta], [1, 1]);
    is("and the store is still erased on this walk", [(run as { stores?: number }).stores, (await storeForEmail(X)) === null], [1, true]);
  }

  part("An account index that cannot be read keeps the grant: never given back on an unread answer");
  {
    await closing(false);
    const real = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands.some((c) => c[0] === "SMEMBERS" && (String(c[1]).startsWith("nl:meet:user:") || String(c[1]).startsWith("nl:metaads:user:")))) return [{ unexpected: true }];
      return real(commands);
    }) as typeof redis.pipeline;
    await eraseClosed(Date.now() + 30_000, async () => {}, Date.now()).catch(() => null);
    redis.pipeline = real;
    is("nothing is given back on an unread index", [calls.google, calls.meta], [0, 0]);
  }

  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
