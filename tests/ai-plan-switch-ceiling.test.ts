/**
 * R32 finding 1 (synthetic): a store that moves between Studio and Scale in
 * the middle of its billing month (lib/billing.ts switchPlan,
 * proration_behavior "always_invoice": Stripe keeps the period, so the
 * allowance window and its id stay the same) must keep AI writing, under the
 * ceiling of the plan it is on now, counting what the window already spent:
 *
 * - an upgrade gets the new plan's ceiling minus what was already spent;
 * - a downgrade never adds the new plan's ceiling to what the old one spent:
 *   the window's one total stays at or under the new, lower ceiling;
 * - switching back and forth claims at most one funded allocation per tier;
 * - a scope or marker in any other shape refuses without a write (rule 24);
 * - a job whose dollar reservation is refused before any model call is given
 *   back to the month (lib/ai.ts counted): nothing reached the provider.
 *
 * Money ledger: the contract double tests/ai-spend-redis.ts, which follows
 * the Lua step for step; scripts/test_ai_spend_redis.py runs the exact
 * RESERVE_AI_SPEND text on the CI Redis. The model API is a stand-in that
 * counts calls; no provider is reached.
 */
import "./frozen-clock"; // first: the month this file names at load is the month the code reads on every call
import { writeBio, aiLeft } from "@/lib/ai";
import { reserveAiSpend } from "@/lib/ai-spend";
import { aiSpendLedgerKey, AUTOMATIC_AI_STORE_MICRO_USD, currentAiSpendPolicy } from "@/lib/ai-spend-policy";
import { allowanceWindow } from "@/lib/allowance-window";
import type { Store } from "@/lib/store";
import { reset, ledger } from "./path-wording-provider-world";
import { done, is, part } from "./check";
import { calendarPeriod, calendarPeriodId } from "./billing-period-fixture";

let modelCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.anthropic.com") throw new Error(`unexpected host ${url.hostname}`);
  modelCalls += 1;
  return Response.json({ content: [{ type: "text", text: '{"lines":["Bread for busy cooks","Slow bread, fast","Sourdough at home"]}' }], usage: { input_tokens: 900, output_tokens: 40 } });
}) as typeof fetch;

const STUDIO = AUTOMATIC_AI_STORE_MICRO_USD.pro;
const SCALE = AUTOMATIC_AI_STORE_MICRO_USD.scale;
const input = { products: [{ title: "Sourdough course", summary: "Bake bread at home" }], notes: "Weekend baker" };

function storeOf(statsId: string, tier: "pro" | "scale"): Store {
  return {
    handle: "baker", name: "Baker", statsId, language: "en", createdAt: 1, tier,
    subscriptionActive: true, subscriptionId: "sub_R32Upgrade0001", stripeCustomerId: "cus_R32Upgrade001",
    trialEnds: 0, planEndedAt: "", cycle: "month", period: calendarPeriod(),
  } as unknown as Store;
}

async function main(): Promise<void> {
  reset();
  process.env.ANTHROPIC_API_KEY = "sk-ant-" + "r32synthetic".repeat(3);
  const key = aiSpendLedgerKey(new Date().toISOString().slice(0, 7));
  const row = () => ledger.get(key)!;
  const fieldOf = (id: string) => `store:${id}:${calendarPeriodId()}`;
  const spent = (id: string) => Number(row().get(fieldOf(id)) ?? 0);
  const snapshot = () => JSON.stringify([...row().entries()].sort());
  is("Studio's ceiling is below Scale's (the fixture's premise)", STUDIO < SCALE, true);

  part("Control: on Studio, a writing job reaches the model");
  const field = fieldOf("r32upgrade");
  const first = await writeBio(storeOf("r32upgrade", "pro"), input);
  is("Studio job ok", first.ok, true);
  is("model calls so far", modelCalls, 1);
  is("ledger scope pinned to the tier that claimed it", row().get("tier:" + field), "pro");
  const slotsPro = row().get("slots:pro"), slotsScale = row().get("slots:scale");

  part("Upgrade: same store, same billing month, now on Scale (Stripe kept the period)");
  const scale = storeOf("r32upgrade", "scale");
  const beforeUpgrade = spent("r32upgrade");
  const leftBefore = await aiLeft(scale);
  const second = await writeBio(scale, input);
  is("the upgraded store's writing job is answered", second.ok, true);
  is("the model is asked for it", modelCalls, 2);
  is("the answered job is one of the month's", await aiLeft(scale), leftBefore - 1);
  is("the window keeps one total: Studio's spending stays in it", spent("r32upgrade") > beforeUpgrade, true);
  is("the field now runs under Scale", row().get("tier:" + field), "scale");
  is("one Scale allocation is claimed", row().get("slots:scale"), String(Number(slotsScale) - 1));
  is("the Studio allocation stays claimed (never handed back)", row().get("slots:pro"), slotsPro);
  is("and the field remembers it holds it", row().get("held:pro:" + field), "1");

  part("Rest of the month on Scale");
  let refused = 0;
  for (let i = 0; i < 5; i++) if (!(await writeBio(scale, input)).ok) refused += 1;
  is("none of five further Scale jobs is refused while the Scale ceiling has room", refused, 0);
  is("model calls", modelCalls, 7);

  part("Upgrade room is Scale's ceiling minus what the window spent, never more");
  const total = spent("r32upgrade");
  row().set(field, String(SCALE - 1));
  row().set("company", String(Number(row().get("company")) - total + SCALE - 1));
  const atCeiling = snapshot(), leftAtCeiling = await aiLeft(scale);
  const over = await writeBio(scale, input);
  is("a job past Scale's ceiling is refused", over.ok, false);
  is("no model call for it", modelCalls, 7);
  is("no write to the ledger", snapshot(), atCeiling);
  is("a job with no provider call is given back to the month", await aiLeft(scale), leftAtCeiling);

  part("Downgrade past the lower ceiling: Scale spent more than Studio's whole month");
  const down = fieldOf("r32down");
  is("Scale claims first", (await writeBio(storeOf("r32down", "scale"), input)).ok, true);
  const downSpent = spent("r32down");
  row().set(down, String(STUDIO + 1));
  row().set("company", String(Number(row().get("company")) - downSpent + STUDIO + 1));
  const studioDown = storeOf("r32down", "pro");
  const beforeDown = snapshot(), leftDown = await aiLeft(studioDown), callsDown = modelCalls;
  const downJob = await writeBio(studioDown, input);
  is("Studio after Scale spent past Studio's ceiling: refused", downJob.ok, false);
  is("no model call", modelCalls, callsDown);
  is("no write: still under Scale, no allocation moved", snapshot(), beforeDown);
  is("the job is given back", await aiLeft(studioDown), leftDown);

  part("Downgrade with room: the one total stops at Studio's ceiling");
  const room = fieldOf("r32room");
  is("Scale claims first", (await writeBio(storeOf("r32room", "scale"), input)).ok, true);
  const studioRoom = storeOf("r32room", "pro");
  is("Studio after a small Scale spend: answered", (await writeBio(studioRoom, input)).ok, true);
  is("the field now runs under Studio", row().get("tier:" + room), "pro");
  const policy = currentAiSpendPolicy()!;
  const window = allowanceWindow(studioRoom)!;
  let taken = 0;
  while (taken < 100_000 && await reserveAiSpend("r32room", "pro", "claude-haiku-5-5", policy, 1_000, window)) taken += 1;
  is("reservations stop", taken < 100_000, true);
  is("the window's total never passes Studio's ceiling", spent("r32room") <= STUDIO, true);
  is("and stops within one reservation of it", STUDIO - spent("r32room") < 1_000, true);

  part("Back and forth: at most one allocation per tier");
  const flip = fieldOf("r32flip");
  const pro0 = Number(row().get("slots:pro")), scale0 = Number(row().get("slots:scale"));
  const flipWindow = allowanceWindow(storeOf("r32flip", "pro"))!;
  for (const tier of ["pro", "scale", "pro", "scale", "pro"] as const) {
    is(`reserve on ${tier}`, await reserveAiSpend("r32flip", tier, "claude-haiku-5-5", policy, 1_000, flipWindow), true);
  }
  is("one Studio allocation", Number(row().get("slots:pro")), pro0 - 1);
  is("one Scale allocation", Number(row().get("slots:scale")), scale0 - 1);
  is("the window's one total", spent("r32flip"), 5_000);
  is("both held", [row().get("held:pro:" + flip), row().get("held:scale:" + flip)], ["1", "1"]);

  part("Unknown shapes refuse without a write (rule 24)");
  for (const odd of ["bogus", "", "PRO", "1"]) {
    row().set("tier:" + flip, odd);
    const before = snapshot();
    is(`scope ${JSON.stringify(odd)} refuses`, await reserveAiSpend("r32flip", "scale", "claude-haiku-5-5", policy, 1_000, flipWindow), false);
    is(`scope ${JSON.stringify(odd)}: no write`, snapshot(), before);
  }
  row().set("tier:" + flip, "pro");
  for (const odd of ["2", "", "0", "yes"]) {
    row().set("held:scale:" + flip, odd);
    const before = snapshot();
    is(`held marker ${JSON.stringify(odd)} refuses`, await reserveAiSpend("r32flip", "scale", "claude-haiku-5-5", policy, 1_000, flipWindow), false);
    is(`held marker ${JSON.stringify(odd)}: no write`, snapshot(), before);
  }
  row().set("held:scale:" + flip, "1");
  row().set("held:pro:" + flip, "2");
  const oddOld = snapshot();
  is("a corrupt marker of the tier left behind refuses", await reserveAiSpend("r32flip", "scale", "claude-haiku-5-5", policy, 1_000, flipWindow), false);
  is("and writes nothing", snapshot(), oddOld);
  const stray = fieldOf("r32stray");
  row().set("held:scale:" + stray, "1");
  const strayBefore = snapshot();
  is("a marker with no claimed scope refuses a first claim", await reserveAiSpend("r32stray", "scale", "claude-haiku-5-5", policy, 1_000, flipWindow), false);
  is("and writes nothing", snapshot(), strayBefore);

  part("No allocation of the new tier left: refused, nothing moved");
  const full = fieldOf("r32full");
  is("Studio claims", await reserveAiSpend("r32full", "pro", "claude-haiku-5-5", policy, 1_000, flipWindow), true);
  const scaleLeft = row().get("slots:scale");
  row().set("slots:scale", "0");
  const fullBefore = snapshot();
  is("Scale with no allocation left refuses", await reserveAiSpend("r32full", "scale", "claude-haiku-5-5", policy, 1_000, flipWindow), false);
  is("no write", snapshot(), fullBefore);
  is("still under Studio", row().get("tier:" + full), "pro");
  row().set("slots:scale", String(scaleLeft));

  part("Controls unchanged: the same tier keeps its one allocation and its ceiling");
  const same = fieldOf("r32same");
  const pro1 = Number(row().get("slots:pro"));
  for (let i = 0; i < 3; i++) await reserveAiSpend("r32same", "pro", "claude-haiku-5-5", policy, 1_000, flipWindow);
  is("one allocation for three reservations", Number(row().get("slots:pro")), pro1 - 1);
  is("no marker on the healthy path", row().has("held:pro:" + same), false);
  is("spent", spent("r32same"), 3_000);
  done();
}

void main();
