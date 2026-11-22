/**
 * 663 [HF1], Claude 3 (cloud K) review 6804352166 on #3549 (MEDIUM, VR item 2): "failed" also comes back when no
 * call reached the model (a reservation refused it before the fetch), and then lib/ai.ts `counted` gives the month's
 * job back. So the words a panel shows for "failed" must be true in both cases: never "this try counted" without a
 * condition, never "nothing was counted" either. Checked through the real code, with the dollar reservation refused
 * (tests/hf1-returned-failure-ai-spend.ts) and the model never reached. Synthetic data only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { aiMonthKey, writePitch } from "@/lib/ai";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.ANTHROPIC_API_KEY = `sk-ant-api03-${"x".repeat(40)}`;

let modelCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.anthropic.com") modelCalls++;
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

function said(file: string, key: string): string {
  const source = readFileSync(join(process.cwd(), file), "utf8");
  const found = new RegExp(`\\n\\s*${key}: "([^"]*)"`).exec(source);
  if (!found) throw new Error(`${file} has no ${key} words`);
  return found[1];
}

const OWNER = "hf1-returned@example.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "hfonereturned", "HF One Returned", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_HfOneReturned1", subscriptionId: "sub_HfOneReturned1", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const now = Date.now();
  const key = aiMonthKey(store, new Date(now));
  const jobs = async () => Number((await redis.pipeline([["GET", key ?? ""]]))[0] ?? 0);

  part("Refused before the model: failed, no call, and the month's job given back");
  const before = await jobs();
  const pitch = await writePitch(store, { goal: "sponsor", sender: "Sam", company: "Brand Co", about: "We make running shoes.", sells: ["Trail Plan"], commission: null, notes: "A paid mention." }, now);
  is("failed, the model never asked, the job given back", [pitch.ok ? "ok" : pitch.reason, modelCalls, (await jobs()) - before], ["failed", 0, 0]);

  part("So no panel's words for failed say the try counted without a condition");
  for (const [file, job] of [["components/outreach-studio.tsx", "writing jobs"], ["components/numbers-ask.tsx", "AI jobs"]] as const) {
    const words = said(file, "failed");
    is(`${file}: never "this try counted" as a fact`, /this try counted/i.test(words), false);
    is(`${file}: never "nothing was counted" either`, /nothing was counted/i.test(words), false);
    is(`${file}: says it counted only if the request reached the AI`, new RegExp(`if [^.]*reached the AI[^.]*counted as one of this month's ${job}`, "i").test(words), true);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
