/**
 * Two LOWs of the second money review of #3454 (Claude 1, 11 November 2026):
 * - counted() answers "off" when the writing job's reservation cannot be confirmed (an unreadable INCRBY/EXPIRE
 *   reply). After aiAvailableFor and aiLeft both said yes, the route passed it on as "off" and the page said "AI
 *   writing is not part of this store's plan right now", which is untrue, and the job may or may not have been
 *   taken. It is now "unconfirmed", 503, in words that say neither "nothing was used" nor "not in your plan".
 * - an answer that predicts a result in words ("This can double your sales.") was shown; only digits were caught.
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { aiLeft } from "@/lib/ai";
import { POST as EXPLAIN } from "@/app/api/store/funnel-explain/route";
import { POST as FUNNELS } from "@/app/api/store/page-funnels/route";
import { explainRequest, readExplanation } from "@/lib/funnel-explain";
import { explainErrorText } from "@/components/funnel-issue-explain";
import type { FunnelLaunchIssue } from "@/lib/funnel-launch-review";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

let asked = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.anthropic.com") return new Response("{}", { status: 404 });
  asked += 1;
  return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ why: "Visitors cannot open it while it is off.", todo: ["Open settings."] }) }] }));
}) as typeof fetch;

const disabled: FunnelLaunchIssue = { code: "disabled", title: "The funnel address is disabled", detail: "Review its settings and enable it only after preparing and testing the journey." };
const steps = [{ title: "Free checklist", open: false, why: "This page is kept back.", product: false, free: false }];

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.ANTHROPIC_API_KEY = `sk-ant-api03-${"x".repeat(40)}`;

  part("A reservation that cannot be confirmed is not \"off\"");
  const OWNER = "explainunconfirmed@example.com";
  await claimHandle(OWNER, "explainunconfirmed", "Pixel Studio", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Unconf01", subscriptionId: "sub_Unconf01", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const guide = await addProduct(OWNER, "Pricing Checklist", "A one-page checklist.", "0", null);
  const course = await addProduct(OWNER, "Pricing Course", "Six lessons on pricing.", "99", null);
  if (!guide.ok || !course.ok) throw new Error("no products");
  const session = await openSession(OWNER);
  const post = (route: (request: NextRequest) => Promise<Response>, path: string, body: Record<string, unknown>) =>
    route(new NextRequest(`https://marktmorgen.com/api/store/${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
  const created = await (await post(FUNNELS, "page-funnels", { action: "from-type", type: "lead-magnet", name: "Checklist funnel", products: { freebie: guide.product.id, offer: course.product.id } })).json();
  is("control: a funnel made switched off", [created.ok, created.funnel?.on], [true, false]);
  const left = await aiLeft((await storeForEmail(OWNER))!);
  is("control: the plan has writing jobs left", typeof left === "number" && left > 0, true);

  // The job's INCRBY is answered in no shape counted() can read: the reservation is unknown.
  const pipeline = redis.pipeline.bind(redis);
  let garbled = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((command) => command[0] === "INCRBY" && String(command[1]).includes(":ai:"))) {
      garbled += 1;
      return commands.map(() => null);
    }
    return pipeline(commands);
  }) as typeof redis.pipeline;
  asked = 0;
  const response = await post(EXPLAIN, "funnel-explain", { funnel: created.funnel.id, issue: disabled });
  redis.pipeline = pipeline;
  const body = await response.json();
  is("control: the job's reservation was really answered unreadably", garbled > 0, true);
  is("it is said as unconfirmed, 503, with no model call", [response.status, body.error, asked], [503, "unconfirmed", 0]);
  const words = explainErrorText("unconfirmed");
  is("its words never say the plan has no AI writing, nor that nothing was used", [/not part of this store's plan/i.test(words), /nothing was used/i.test(words), /could not confirm/i.test(words)], [false, false, true]);

  part("An answer that predicts a result in words is never shown");
  const plain = explainRequest(disabled, "Funnel", steps);
  is("control: a plain answer is kept", readExplanation({ why: "Visitors cannot open it while it is off.", todo: ["Open settings."] }, plain) !== null, true);
  for (const why of ["This can double your sales.", "Turning it on will triple your revenue.", "This is guaranteed to work.", "It can multiply your conversions."]) {
    is(`never shown: ${why}`, readExplanation({ why, todo: ["Open settings."] }, plain), null);
  }
  is("nor in a step", readExplanation({ why: "Visitors cannot open it.", todo: ["Turn it on to double your sign-ups."] }, plain), null);
}

main().then(done, (error) => {
  console.error(error);
  process.exitCode = 1;
});
