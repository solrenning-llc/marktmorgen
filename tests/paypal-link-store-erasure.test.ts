/**
 * A PayPal app's link is kept only while its store is live (Codex L-20261119-2344): connectPayPal waits on PayPal
 * to check the app, and a store's erasure can begin or end meanwhile; a plain SET after it would write the sealed
 * Secret back into nl:pp:<statsId>, an erased family, with no expiry. The write is one step that sees the store's
 * own key and no erasing mark. Held too: the connection stays inside the integration unit's 10 commands
 * (tests/plan-cost-registry.ts, UNIT_COST.integration: request("wait", 10 + TAKE_COMMANDS, ...)), counted as
 * Upstash bills a script (1 + every call inside it). Synthetic PayPal only.
 */
import { connectPayPal, readPayPal } from "@/lib/paypal-payouts";
import { claimHandle, ERASING_KEY, erasingField, ownerKey, storeIdCommand, storeRef, type Store } from "@/lib/store";
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
  done();
}
void main();
