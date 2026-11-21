/**
 * A PayPal app's link is kept only while its store is live (Codex L-20261119-2344): connectPayPal waits on PayPal
 * to check the app, and a store's erasure can begin or end meanwhile; a plain SET after it would write the sealed
 * Secret back into nl:pp:<statsId>, an erased family, with no expiry. The write is one step that sees the store's
 * own key and no erasing mark. Held too: the connection stays inside the integration unit's 10 commands
 * (tests/plan-cost-registry.ts, UNIT_COST.integration: request("wait", 10 + TAKE_COMMANDS, ...)), counted as
 * Upstash bills a script (1 + every call inside it). Synthetic PayPal only.
 */
import { connectPayPal, readPayPal } from "@/lib/paypal-payouts";
import { claimHandle, closeStoreRecord, ensureStatsId, MAX_STORE_BYTES, moveAccount, storeForEmail, ERASING_KEY, erasingField, ownerKey, storeIdCommand, storeRef, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";
let duringToken: (() => Promise<void>) | null = null;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname !== "api-m.paypal.com" || url.pathname !== "/v1/oauth2/token") return new Response("{}", { status: 404 });
  if (duringToken) {
    const run = duringToken;
    duringToken = null;
    await run();
  }
  return new Response(JSON.stringify({ access_token: "A21AAtoken", token_type: "Bearer", scope: "https://uri.paypal.com/services/payments/payouts https://uri.paypal.com/payments/payouts", expires_in: 32400 }));
}) as typeof fetch;

async function erase(store: Store, how: "gone" | "erasing") {
  if (how === "erasing") await redis.pipeline([["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(Date.now())]]);
  else await redis.pipeline([["DEL", storeIdCommand(store.sid)[1]], ["DEL", await ownerKey(storeRef(store))]]);
  await redis.pipeline([["DEL", `nl:pp:${store.statsId}`]]);
}

async function made(name: string): Promise<Store> {
  redis.clear();
  const result = await claimHandle(`${name}@example.com`, name, "Synthetic", "");
  if (!result.ok) throw new Error("store not made");
  return result.store;
}

async function main() {
  for (const how of ["gone", "erasing"] as const) {
    part(`a PayPal check that answers after the store is ${how} keeps no link`);
    const store = await made(`pplink-${how}`);
    duringToken = () => erase(store, how);
    const result = await connectPayPal(store, CLIENT, SECRET);
    is("the sealed link is not written back", redis.run(["GET", `nl:pp:${store.statsId}`]), null);
    is("and the connection is not answered as done", result.ok, false);
  }

  part("a live store keeps its link, inside the integration unit's commands");
  const store = await made("pplink-live");
  const real = redis.pipeline.bind(redis);
  let commands = 0;
  const callsBefore = redis.scriptCalls;
  redis.pipeline = (async (batch: (string | number)[][]) => {
    commands += batch.length;
    return real(batch);
  }) as typeof redis.pipeline;
  let result;
  try {
    result = await connectPayPal(store, CLIENT, SECRET);
  } finally {
    redis.pipeline = real;
  }
  const billed = commands + (redis.scriptCalls - callsBefore);
  is("connected", result.ok, true);
  const view = await readPayPal(store);
  is("and read back, its Secret opening", [view?.client, view?.broken], [`${CLIENT.slice(0, 6)}…${CLIENT.slice(-4)}`, false]);
  is("at most the integration unit's 10 commands, a script billed as 1 + its calls", billed <= 10, true);

  for (const erasing of [false, true]) {
    part(`a pending connection keeps no secret under the old ref after an account move (${erasing ? "erasing" : "live"})`);
    const oldStore = await made(erasing ? "pplink-move-erase" : "pplink-move-live");
    const to = "moved-link-owner@example.test";
    const key = `nl:pp:${oldStore.statsId}`;
    let interleaved = 0;
    duringToken = async () => {
      interleaved += 1;
      is("real move completes during the provider validation", (await moveAccount(oldStore.email, to)).ok, true);
      const moved = await storeForEmail(to);
      if (!moved) throw new Error("moved synthetic store not found");
      is("move preserves sid and statsId", [moved.sid, moved.statsId], [oldStore.sid, oldStore.statsId]);
      is("the live id maps to the new ref", redis.run(storeIdCommand(oldStore.sid)), storeRef(moved));
      is("the old ref has no erasing marker", redis.run(["HGET", ERASING_KEY, await erasingField(storeRef(oldStore))]), null);
      // The store erasure has already passed its link family. Its marker is at the new ref; final record closure
      // below must not delete this link a second time. The live control tests stale ownership without any marker.
      await redis.pipeline([["DEL", key]]);
      if (erasing) await redis.pipeline([["HSET", ERASING_KEY, await erasingField(storeRef(moved)), String(Date.now())]]);
    };
    const answer = await connectPayPal(oldStore, CLIENT, SECRET);
    is("the real validation boundary ran exactly once", interleaved, 1);
    is("a stale connection is not reported kept", answer.ok, false);
    is("no encrypted credential is recreated", redis.run(["GET", key]), null);
    const moved = await storeForEmail(to);
    if (!moved) throw new Error("moved synthetic store disappeared");
    if (erasing) {
      is("the real moved record closes, with no second link cleanup", await closeStoreRecord(moved), true);
      is("no link survives final closure", redis.run(["GET", key]), null);
    } else {
      is("a current moved-owner snapshot can still connect", (await connectPayPal(moved, CLIENT, SECRET)).ok, true);
      is("the current connection is readable", (await readPayPal(moved))?.broken, false);
    }
  }

  part("a legacy snapshot cannot restore its secret after its owner key is reused by another real store");
  const original = await made("pplink-legacy-old");
  await ensureStatsId(original.email);
  const actual = await storeForEmail(original.email);
  if (!actual?.statsId) throw new Error("legacy fixture has no immutable statsId");
  const legacy = { ...actual, sid: "" };
  let reused = 0;
  duringToken = async () => {
    reused += 1;
    await redis.pipeline([["HSET", ERASING_KEY, await erasingField(storeRef(actual)), String(Date.now())], ["DEL", `nl:pp:${actual.statsId}`]]);
    is("the original real store closes", await closeStoreRecord(actual), true);
    const next = await claimHandle(actual.email, "pplink-new-owner", "Synthetic replacement", "");
    if (!next.ok) throw new Error("replacement store not made");
    await ensureStatsId(actual.email);
    const replacement = await storeForEmail(actual.email);
    if (!replacement) throw new Error("replacement store missing");
    is("the reused owner record names a different immutable statsId", replacement.statsId === actual.statsId, false);
  };
  const legacyResult = await connectPayPal(legacy, CLIENT, SECRET);
  is("the real owner reuse ran during validation", reused, 1);
  is("the old legacy connection is refused", legacyResult.ok, false);
  is("the old store's secret stays absent after owner reuse", redis.run(["GET", `nl:pp:${legacy.statsId}`]), null);

  part("a matching live legacy record still connects; malformed or oversized records never keep a link");
  const matching = await made("pplink-legacy-live");
  const matchingLegacy = { ...matching, sid: "" };
  is("matching legacy identity connects", (await connectPayPal(matchingLegacy, CLIENT, SECRET)).ok, true);
  for (const raw of ["not-json", " ".repeat(MAX_STORE_BYTES + 1)]) {
    await redis.pipeline([["DEL", `nl:pp:${matching.statsId}`], ["SET", await ownerKey(storeRef(matching)), raw]]);
    is("unconfirmed legacy identity is refused", (await connectPayPal(matchingLegacy, CLIENT, SECRET)).ok, false);
    is("nothing is kept for an unreadable or oversized owner record", redis.run(["GET", `nl:pp:${matching.statsId}`]), null);
  }

  done();
}
void main();
