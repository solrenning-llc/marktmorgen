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
import { CONFIG_WRITE_TRIES, MAX_ENDPOINTS, setSendHooksForTests, webhooksView } from "@/lib/webhooks";
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
/**
 * How many more of the webhook settings' compare-and-set writes (lib/webhooks.ts changeConfig) lose the race to
 * another write: each answers [-1] ("changed meanwhile") without writing, as a concurrent change makes it, and the
 * route tries again, up to CONFIG_WRITE_TRIES times (Claude 4 3Kc's MEDIUM on #5249). Billed like any other try.
 */
let lose = 0;
redis.pipeline = (async (commands: Commands) => {
  if (billed !== null) {
    for (const command of commands) {
      billed += 1;
      if (String(command[0]).toUpperCase() === "EVAL") billed += (String(command[1]).match(/redis\.call\(/g) ?? []).length;
    }
  }
  if (lose > 0 && commands.length === 1 && String(commands[0][0]).toUpperCase() === "EVAL" && String(commands[0][1]).startsWith("-- marktmorgen:webhook-config-save:")) {
    lose -= 1;
    return [[-1]];
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

  part("POST /api/v1/hooks and DELETE /api/v1/hooks at their dearest: the last endpoint, a full list, every lost try");
  for (let i = 0; i < MAX_ENDPOINTS - 1; i += 1) {
    const seeded = await inRequest(() => postHook(new Request(`${ORIGIN}/api/v1/hooks`, { method: "POST", headers: { authorization: `Bearer ${writer.key}`, "content-type": "application/json" }, body: JSON.stringify({ url: `https://seed-${i}.example.com/hook`, events: ["sale.completed"] }) })));
    if (seeded.status !== 200) throw new Error(`setup: endpoint ${i} answered ${seeded.status}`);
  }
  const firstId = async () => (await webhooksView(store)).endpoints[0].id;
  const count = async () => (await webhooksView(store)).endpoints.length;
  let n = 0;
  const addLast = (losses: number) => {
    lose = losses;
    n += 1;
    return measured(postHook, writer.key, "POST", { url: `https://last-${n}.example.com/hook`, events: ["sale.completed", "refund.issued"] }).finally(() => { lose = 0; });
  };
  const removeFirst = async (losses: number) => {
    const id = await firstId();
    lose = losses;
    return measured(deleteHook, writer.key, "DELETE", { id }).finally(() => { lose = 0; });
  };
  const runs: { what: string; status: number; billed: number; ok: boolean }[] = [];
  const keep = (what: string, run: { status: number; billed: number }, ok: boolean) => runs.push({ what, ...run, ok });
  keep("POST, the last endpoint, first try", await addLast(0), true);
  is("the list is full", await count(), MAX_ENDPOINTS);
  keep("DELETE from a full list, first try", await removeFirst(0), true);
  keep(`POST, the last endpoint, after ${CONFIG_WRITE_TRIES - 1} lost tries`, await addLast(CONFIG_WRITE_TRIES - 1), true);
  is("the list is full again", await count(), MAX_ENDPOINTS);
  keep(`DELETE from a full list, after ${CONFIG_WRITE_TRIES - 1} lost tries`, await removeFirst(CONFIG_WRITE_TRIES - 1), true);
  keep(`POST, the last endpoint, all ${CONFIG_WRITE_TRIES} tries lost`, await addLast(CONFIG_WRITE_TRIES), false);
  is("nothing was added when every try was lost", await count(), MAX_ENDPOINTS - 1);
  const refill = await addLast(0);
  if (refill.status !== 200) throw new Error("setup: refill");
  keep(`DELETE from a full list, all ${CONFIG_WRITE_TRIES} tries lost`, await removeFirst(CONFIG_WRITE_TRIES), false);
  is("nothing was removed when every try was lost", await count(), MAX_ENDPOINTS);
  for (const run of runs) {
    is(`${run.what}: ${run.ok ? "done" : "refused"}`, run.ok ? run.status === 200 : run.status !== 200, true);
    is(`${run.what}: its commands, billed (${run.billed}), are within one unit (${UNIT_COMMANDS}) and the priced extra (${API_HOOK_ACCESS_EXTRA_COMMANDS})`, run.billed <= UNIT_COMMANDS + API_HOOK_ACCESS_EXTRA_COMMANDS, true);
  }
  const lossy = runs.filter((r) => r.what.includes("lost"));
  const once = runs.filter((r) => !r.what.includes("lost"));
  is("every lost try was billed: a run with lost tries sends more than the first-try run", Math.min(...lossy.map((r) => r.billed)) > Math.max(...once.map((r) => r.billed)), true);
  const added = { billed: Math.max(...runs.filter((r) => r.what.startsWith("POST")).map((r) => r.billed)) };
  const removed = { billed: Math.max(...runs.filter((r) => r.what.startsWith("DELETE")).map((r) => r.billed)) };

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
