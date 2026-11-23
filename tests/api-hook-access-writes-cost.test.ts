/**
 * #5010 row 150 (route envelope sweep 2f36, coordinator cca1): three API writes take one unit of the store's API
 * figure (UNIT_COST.api: 20 commands and TAKE_COMMANDS, as tests/plan-cost-registry.ts prices it) but send more:
 * POST /api/v1/hooks, DELETE /api/v1/hooks and DELETE /api/v1/access. They keep taking one unit, as the terms, the
 * pricing page and the developers' page say (only a contact added or a product given counts as API_WRITE_UNITS);
 * what they send beyond the unit is priced on its own line, "api-hook-access-writes", at
 * API_HOOK_ACCESS_EXTRA_COMMANDS more commands for every API request of each plan.
 *
 * Measured through the real routes, with a real key, at their dearest: every command sent, each script billed as
 * Upstash bills it (one, plus every redis.call written in it, a bound on its worst branch). Each route must stay at
 * or under the unit's commands plus the priced extra. Synthetic: in-memory Redis, no email or webhook sent.
 */
import "./r34-hook-own-id-scope";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import { DELETE as deleteHook, POST as postHook } from "@/app/api/v1/hooks/route";
import { DELETE as deleteAccess, POST as postAccess } from "@/app/api/v1/access/route";
import { makeKey } from "@/lib/api-keys";
import { makerFor } from "@/lib/api-key-pause";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { MAX_ENDPOINTS, setSendHooksForTests, webhooksView } from "@/lib/webhooks";
import { readFileSync } from "node:fs";
import { API_HOOK_ACCESS_EXTRA_COMMANDS, COMMAND, COST_LINES, TAKE_COMMANDS } from "./plan-cost-registry";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
globalThis.fetch = (async () => new Response(JSON.stringify({ id: "email_1" }), { status: 200 })) as typeof fetch;
setSendHooksForTests({ fetch: { resolve: (async () => { throw new Error("no network in tests"); }) as never } });

type Commands = (string | number)[][];
const real = redis.pipeline.bind(redis);
/** The commands sent while counting, as Upstash bills them: a script is one, plus each redis.call written in it. */
let billed: number | null = null;
redis.pipeline = (async (commands: Commands) => {
  if (billed !== null) {
    for (const command of commands) {
      billed += 1;
      if (String(command[0]).toUpperCase() === "EVAL") billed += (String(command[1]).match(/redis\.call\(/g) ?? []).length;
    }
  }
  return real(commands);
}) as typeof redis.pipeline;

/** The one unit an API request takes, in commands (tests/plan-cost-registry.ts UNIT_COST.api). */
const UNIT_COMMANDS = 20 + TAKE_COMMANDS;
const ORIGIN = "https://marktmorgen.com";
const OWNER = "api-hook-access-cost@example.com";

/** What a route left for after its answer, run inside the request, as Next does; counted with the route. */
async function inRequest<T>(run: () => Promise<T>): Promise<T> {
  const tasks: (() => unknown)[] = [];
  const workStore = { afterContext: { after: (task: () => unknown) => void tasks.push(task) } };
  const answer = await workAsyncStorage.run(workStore as never, () => workUnitAsyncStorage.run({ type: "request" } as never, run));
  for (const task of tasks) await task();
  return answer;
}

/** Sends one request through `handler` and answers its status and the commands it sent, billed. */
async function measured(handler: (r: Request) => Promise<Response>, key: string, method: string, body: unknown): Promise<{ status: number; billed: number }> {
  billed = 0;
  try {
    const response = await inRequest(() => handler(new Request(`${ORIGIN}/api/v1/x`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) })));
    return { status: response.status, billed: billed as number };
  } finally {
    billed = null;
  }
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  process.env.RESEND_API_KEY = "re_test_api_hook_access_cost_only";
  await claimHandle(OWNER, "apihookcost", "API Hook Cost", "");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_apihookcost", subscriptionId: "sub_apihookcost", active: true, tier: "creator", period: paidPeriod() });
  const guide = await addProduct(OWNER, "The Guide", "", "12", null);
  if (!guide.ok) throw new Error("setup: product");
  await setProductLink(OWNER, guide.product.id, "https://example.com/guide");
  const store = (await storeForEmail(OWNER))!;
  const writer = await makeKey(store.sid, "Zapier", Date.now(), true, "none", makerFor(store.sid, "owner", OWNER, true));
  if (!writer.ok) throw new Error("setup: key");

  part("POST /api/v1/hooks, the last endpoint a store may have (the most kept beside it)");
  for (let i = 0; i < MAX_ENDPOINTS - 1; i += 1) {
    const seeded = await inRequest(() => postHook(new Request(`${ORIGIN}/api/v1/hooks`, { method: "POST", headers: { authorization: `Bearer ${writer.key}`, "content-type": "application/json" }, body: JSON.stringify({ url: `https://seed-${i}.example.com/hook`, events: ["sale.completed"] }) })));
    if (seeded.status !== 200) throw new Error(`setup: endpoint ${i} answered ${seeded.status}`);
  }
  const added = await measured(postHook, writer.key, "POST", { url: "https://last.example.com/hook", events: ["sale.completed", "refund.issued"] });
  is("added", added.status, 200);
  is(`its commands, billed (${added.billed}), are within one unit (${UNIT_COMMANDS}) and the priced extra (${API_HOOK_ACCESS_EXTRA_COMMANDS})`, added.billed <= UNIT_COMMANDS + API_HOOK_ACCESS_EXTRA_COMMANDS, true);

  part("DELETE /api/v1/hooks, with every endpoint a store may have");
  const endpoints = (await webhooksView(store)).endpoints;
  is("the store has all its endpoints", endpoints.length, MAX_ENDPOINTS);
  const removed = await measured(deleteHook, writer.key, "DELETE", { id: endpoints[0].id });
  is("removed", removed.status, 200);
  is(`its commands, billed (${removed.billed}), are within one unit (${UNIT_COMMANDS}) and the priced extra (${API_HOOK_ACCESS_EXTRA_COMMANDS})`, removed.billed <= UNIT_COMMANDS + API_HOOK_ACCESS_EXTRA_COMMANDS, true);

  part("DELETE /api/v1/access, taking back a product the API gave");
  const given = await inRequest(() => postAccess(new Request(`${ORIGIN}/api/v1/access`, { method: "POST", headers: { authorization: `Bearer ${writer.key}`, "content-type": "application/json" }, body: JSON.stringify({ email: "cy@example.com", product: guide.product.id }) })));
  is("setup: given", given.status, 200);
  const taken = await measured(deleteAccess, writer.key, "DELETE", { email: "cy@example.com", product: guide.product.id });
  is("taken back", taken.status, 200);
  is(`its commands, billed (${taken.billed}), are within one unit (${UNIT_COMMANDS}) and the priced extra (${API_HOOK_ACCESS_EXTRA_COMMANDS})`, taken.billed <= UNIT_COMMANDS + API_HOOK_ACCESS_EXTRA_COMMANDS, true);

  part("The extra is the dearest of the three, no more, and priced on every API request of each plan");
  const most = Math.max(added.billed, removed.billed, taken.billed) - UNIT_COMMANDS;
  is(`the priced extra (${API_HOOK_ACCESS_EXTRA_COMMANDS}) is the measured excess (${most}), never below it`, API_HOOK_ACCESS_EXTRA_COMMANDS >= most && most > 0, true);
  const line = COST_LINES.find((l) => l.id === "api-hook-access-writes");
  is("its line is in the registry", Boolean(line), true);
  for (const tier of Object.keys(STORE_ALLOWANCES) as (keyof typeof STORE_ALLOWANCES)[]) {
    const usd = STORE_ALLOWANCES[tier].api * API_HOOK_ACCESS_EXTRA_COMMANDS * COMMAND;
    is(`${tier}: ${STORE_ALLOWANCES[tier].api} API requests x ${API_HOOK_ACCESS_EXTRA_COMMANDS} commands = $${usd.toFixed(5)} a month`, line ? Math.abs(line.monthlyUsd(tier as never) - usd) < 1e-12 : false, true);
  }

  // A trial's API requests are priced with the stores that pay nothing (nonPayingWorst), the same extra on each.
  is("a trial's API requests carry the same extra in the worst of a store that pays nothing", /\+ allowances\.api \* API_HOOK_ACCESS_EXTRA_COMMANDS \* COMMAND/.test(readFileSync("tests/plan-cost-registry.ts", "utf8")), true);

  done();
}

void main().catch((error) => {
  console.log(error);
  process.exit(1);
});
