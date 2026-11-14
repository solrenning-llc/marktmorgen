/**
 * Claude 2's MEDIUM on #3068 (and #3067): the thanks page after a payment is never the error page because its
 * views' count could not be read (PF1). withinStore now throws UnknownReplyError for an unknown count of the page's own
 * window (the store's public requests read exactly belong to #3068, which adds that case here); the page reads it with `.catch(unknownLimit)` and says it could not check
 * just now: the PayPal page its "could not check this payment" state, the Stripe page its "could not check this
 * order" notice. A confirmed spent window still says to wait. Synthetic data only; next/headers reads the request.
 */
import { renderToReadableStream } from "react-dom/server";
import ThanksPage from "@/app/[handle]/thanks/page";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription } from "@/lib/store";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "thanks-unknown@example.com";
const BASE = "https://marktmorgen.com";
globalThis.fetch = (async () => new Response(JSON.stringify({ error: "unexpected" }), { status: 404 })) as typeof fetch;

/** Which counter answers `reply` instead: the page's own window (SET NX + INCR) or the store's public requests (INCRBY). */
let target: "" | "window" | "requests" = "";
let reply: unknown = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const [command, key] = [String(commands[0]?.[0] ?? ""), String(commands[0]?.[1] ?? "")];
  if (target === "window" && command === "SET" && key.startsWith("nl:rl:thanks-view:")) return reply;
  if (target === "requests" && command === "INCRBY" && key.startsWith("nl:traffic:r:")) return reply;
  return pipeline(commands);
}) as typeof redis.pipeline;

type Tree = { type: unknown; props: unknown };
/** The page drawn as HTML, or "crashed" when it threw (the error page). */
async function open(query: Record<string, string>): Promise<string> {
  answering(new Request(`${BASE}/@thanksunknown/thanks?${new URLSearchParams(query)}`, { headers: { "x-forwarded-for": "203.0.113.9" } }));
  try {
    let tree = (await ThanksPage({ params: Promise.resolve({ handle: "@thanksunknown" }), searchParams: Promise.resolve(query) })) as Tree;
    // The PayPal page is a component of its own: resolve it.
    if (typeof tree.type === "function" && query.paypal) tree = (await (tree.type as (p: unknown) => Promise<Tree>)(tree.props)) as Tree;
    const stream = await renderToReadableStream(tree as unknown as React.ReactElement, { onError: () => {} });
    await stream.allReady;
    return await new Response(stream).text();
  } catch {
    return "crashed";
  }
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "thanksunknown", "Thanks Unknown", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_thanks0001", subscriptionId: "sub_thanks0001", active: true, tier: "creator", period: paidPeriod() });

  for (const [label, on, value] of [
    ["the page's window answered in another shape", "window", ["OK", "seven"]],
    ["the page's window answered with no reply", "window", []],
  ] as [string, "window" | "requests", unknown][]) {
    part(label);
    target = on;
    reply = value;
    const paypal = await open({ paypal: "5O190127TN364715T" });
    const stripe = await open({ session_id: "cs_test_thanks_unknown" });
    target = "";
    is(`${label}: the PayPal page is drawn, never the error page`, paypal === "crashed" ? "crashed" : "drawn", "drawn");
    is(`${label}: it says it could not check the payment just now`, paypal.includes("We could not check this payment just now"), true);
    is(`${label}: it never says too many tries`, paypal.includes("tries"), false);
    is(`${label}: the Stripe page is drawn, never the error page`, stripe === "crashed" ? "crashed" : "drawn", "drawn");
    is(`${label}: it says it could not check this order`, stripe.includes("We could not check this order"), true);
    is(`${label}: it never says the page was opened too many times`, stripe.includes("opened many times"), false);
  }

  part("control: a confirmed spent window still says to wait");
  target = "window";
  reply = ["OK", 9_999_999];
  const spent = await open({ session_id: "cs_test_thanks_unknown" });
  target = "";
  is("the Stripe page says it was opened many times", spent.includes("opened many times"), true);
  done();
}

void main();
