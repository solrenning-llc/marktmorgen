/**
 * 624 [SZ8](9), unit 1: the page review also reads the page as three kinds of
 * buyer, named by the code, in the same AI job; an objection that predicts a
 * result, a lens the code did not name, or a half answer is dropped
 * (lib/ai.ts reviewPage, lib/page-coach.ts BUYER_LENSES). The model is a
 * stand-in for fetch; nothing leaves the process.
 */
import { reviewPage } from "@/lib/ai";
import { BUYER_LENSES, PREDICTS } from "@/lib/page-coach";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

let reply = "";
const asked: { system: string; maxTokens: number }[] = [];
globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as { system: string; max_tokens: number };
  asked.push({ system: body.system, maxTokens: body.max_tokens });
  return new Response(JSON.stringify({ content: [{ type: "text", text: reply }] }));
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.ANTHROPIC_API_KEY = `sk-ant-api03-${"x".repeat(40)}`;
  await claimHandle("buyers@example.com", "buyers-review", "Harbor Kitchen", "");
  await ensureStatsId("buyers@example.com");
  await setSubscription("buyers@example.com", { customerId: "cus_Buyers00001", subscriptionId: "sub_Buyers00001", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const store = (await storeForEmail("buyers@example.com"))!;
  const base = { verdict: "Clear offer.", fixes: [{ title: "Add a button near the top", detail: "Ready buyers should not scroll." }], headlines: [], fit: null, questions: [] };
  const input = { facts: "Product: Knife Skills", missing: [], drop: "", language: "English", free: false, notes: "" };

  part("The three readers, named by the code, in its order");
  reply = JSON.stringify({
    ...base,
    buyers: [
      { lens: "doubtful", objection: "Will this work with a cheap knife?", add: "Say which knives the lessons use." },
      { lens: "first", objection: "Who is the teacher?", add: "Add a short bio." },
      { lens: "comparing", objection: "Why not free videos?", add: "Show what is in the ten lessons." },
      { lens: "expert", objection: "Too basic.", add: "Nothing." },
    ],
  });
  const reviewed = await reviewPage(store, input);
  if (!reviewed.ok) throw new Error(`no review: ${reviewed.reason}`);
  is("in the code's order, the unknown lens dropped", reviewed.value.buyers.map((b) => b.lens), BUYER_LENSES.map((l) => l.id));
  is("each objection and what could answer it", reviewed.value.buyers[0], { lens: "first", objection: "Who is the teacher?", add: "Add a short bio." });
  is("the model is told never to predict", asked[0].system.includes("Never predict a conversion rate, a lift, a percent or a number of sales."), true);
  is("the same AI job: one call, the same token ceiling as before", [asked.length, asked[0].maxTokens], [1, 2_500]);
  is("one of the month's jobs, as before", reviewed.left, 39);

  part("A prediction or a half answer is dropped, the review still stands");
  reply = JSON.stringify({
    ...base,
    buyers: [
      { lens: "first", objection: "Who is the teacher?", add: "A bio would lift sales by 20%." },
      { lens: "comparing", objection: "Why not free videos?", add: "" },
      { lens: "doubtful", objection: "Will this work for me?", add: "Show three real students' first lessons." },
    ],
  });
  const second = await reviewPage(store, input);
  is("only the usable one is kept", second.ok ? second.value.buyers.map((b) => b.lens) : null, ["doubtful"]);
  reply = JSON.stringify(base);
  const none = await reviewPage(store, input);
  is("none sent: none shown, the review still returned", none.ok ? [none.value.verdict, none.value.buyers] : null, ["Clear offer.", []]);

  part("What counts as a prediction");
  is("percent, conversion, lift and counts of sales", ["20% more", "a higher conversion", "a lift", "50 more sales", "converts better"].every((t) => PREDICTS.test(t)), true);
  is("plain advice is not", ["Add a short bio.", "Show what is in the ten lessons."].some((t) => PREDICTS.test(t)), false);

  done();
}

void main();
