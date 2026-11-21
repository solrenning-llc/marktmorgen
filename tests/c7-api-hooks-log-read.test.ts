/**
 * C7 (API bug hunt): POST and DELETE /api/v1/hooks take one of the store's API requests (the door's,
 * UNIT_COST.api in tests/plan-cost-registry.ts: about twenty commands and twenty kilobytes through the database),
 * yet each read the store's whole webhook delivery log on the way (lib/webhooks.ts webhooksView: LOG_SIZE
 * deliveries, each kept up to DELIVERY_MAX_BYTES), which neither answer sends. DELETE read it twice (before, and
 * the view removeEndpoint hands back), even for an id the store does not have. GET /api/v1/events reads the same
 * deliveries and pays for them by the byte, before it reads them; these two paid nothing for them.
 *
 * So a request whose cost is not covered before it is spent (the margin rule: a ceiling before every cost). This
 * test fills the log with LOG_SIZE large deliveries and checks, through the real routes and a real write key, that
 * neither route reads a single delivery record, and that what each reads stays inside one API request's bytes.
 *
 * Synthetic: in-memory Redis, no webhook and no email sent.
 */
import { DELETE as deleteHook, POST as postHook } from "@/app/api/v1/hooks/route";
import { makeKey } from "@/lib/api-keys";
import { makerFor } from "@/lib/api-key-pause";
import { DELIVERY_MAX_BYTES, LOG_SIZE, setSendHooksForTests } from "@/lib/webhooks";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
globalThis.fetch = (async () => new Response(JSON.stringify({ id: "email_1" }), { status: 200 })) as typeof fetch;
setSendHooksForTests({ fetch: { resolve: (async () => { throw new Error("no network in tests"); }) as never } });
console.error = () => {};

type Commands = (string | number)[][];
const real = redis.pipeline.bind(redis);
let deliveryReads = 0;
let bytesRead = 0;
const bytesOf = (v: unknown): number => (typeof v === "string" ? Buffer.byteLength(v) : Array.isArray(v) ? v.reduce((n: number, x) => n + bytesOf(x), 0) : 0);
redis.pipeline = (async (commands: Commands) => {
  const replies = await real(commands);
  commands.forEach((c) => {
    if (c[0] === "GET" && /^nl:hooks:d:/.test(String(c[1]))) deliveryReads += 1;
  });
  bytesRead += bytesOf(replies);
  return replies;
}) as typeof redis.pipeline;

/** One API request's bytes through the database (UNIT_COST.api: request("light", 20 + TAKE_COMMANDS, 20_000)). */
const API_UNIT_DB_BYTES = 20_000;
const ORIGIN = "https://marktmorgen.com";
const OWNER = "c7-api-hooks-log@example.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "c7-api-hooks-log", "C7 Hooks Log", "");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_c7hookslog", subscriptionId: "sub_c7hookslog", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const key = await makeKey(store.sid, "Zapier", Date.now(), true, "none", makerFor(store.sid, "owner", OWNER, true));
  if (!key.ok || !store.statsId) throw new Error("setup");

  // A full log of large deliveries, as a store that sells a lot keeps it.
  const ids = Array.from({ length: LOG_SIZE }, (_, i) => `dlv_${i.toString(16).padStart(24, "0")}`);
  const body = "x".repeat(DELIVERY_MAX_BYTES - 200);
  for (const id of ids) await real([["SET", `nl:hooks:d:${id}`, JSON.stringify({ id, body })]]);
  await real([["RPUSH", `nl:hooks:log:${store.statsId}`, ...ids]]);

  const send = (method: "POST" | "DELETE", payload: unknown) =>
    (method === "POST" ? postHook : deleteHook)(
      new Request(`${ORIGIN}/api/v1/hooks`, { method, headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json" }, body: JSON.stringify(payload) }),
    );

  part("DELETE /api/v1/hooks with an id the store does not have");
  deliveryReads = 0;
  bytesRead = 0;
  const missing = await send("DELETE", { id: "we_0000000000000000" });
  is("answered 404", missing.status, 404);
  is("no delivery record is read to answer it", deliveryReads, 0);
  is("what it reads stays inside one API request's bytes", bytesRead <= API_UNIT_DB_BYTES, true);

  part("POST /api/v1/hooks");
  deliveryReads = 0;
  bytesRead = 0;
  const added = await send("POST", { url: "https://hooks.example.com/c7", events: ["sale.completed"] });
  const id = ((await added.json()) as { data?: { id?: string } }).data?.id ?? "";
  is("added", [added.status, id.startsWith("we_")], [200, true]);
  is("no delivery record is read to answer it", deliveryReads, 0);
  is("what it reads stays inside one API request's bytes", bytesRead <= API_UNIT_DB_BYTES, true);

  part("DELETE /api/v1/hooks of that endpoint");
  deliveryReads = 0;
  bytesRead = 0;
  const removed = await send("DELETE", { id });
  is("removed", removed.status, 200);
  is("no delivery record is read to answer it", deliveryReads, 0);
  is("what it reads stays inside one API request's bytes", bytesRead <= API_UNIT_DB_BYTES, true);

  done();
}

void main();
