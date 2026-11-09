/**
 * Pre-review of claude5/screen-reads-exact: visibleReviews now throws
 * UnknownReplyError on an off-shape reply (rule 24). Read before any model call,
 * that made the route answer 500, and the studio's fallback for an unknown
 * error says "This try counts as one of this month's AI jobs", which is false:
 * nothing was counted. An unread list of reviews is its own answer: no model
 * call, no AI job, and words that say so (VR item 2).
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/review-summary/route";
import { aiMonthKey } from "@/lib/ai";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { makeReviewSummary } from "@/lib/review-ai-summary";
import { saveReview } from "@/lib/reviews";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

let asked = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  if (new URL(String(input)).hostname === "api.anthropic.com") {
    asked++;
    return new Response(JSON.stringify({ content: [{ type: "text", text: "{\"themes\":[]}" }] }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const original: typeof redis.pipeline = redis.pipeline.bind(redis);
/** Every pipeline whose first command reads the product's visible reviews answers off-shape. */
function offShape(key: string): void {
  redis.pipeline = (async (batch: (string | number)[][]) => {
    if (batch[0]?.[0] === "ZREVRANGEBYSCORE" && batch[0]?.[1] === key) return [{ not: "a list" }];
    return original(batch);
  }) as typeof redis.pipeline;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-only-a-stand-in-0123456789";
  const OWNER = "unread-summary@example.com";
  await claimHandle(OWNER, "unreadsummary", "Unread Summary", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Unread0001", subscriptionId: "sub_Unread0001", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(OWNER, "Glaze Course", "", "49");
  if (!made.ok) throw new Error("no product");
  const productId = made.product.id;
  const statsId = (await storeForEmail(OWNER))!.statsId!;
  for (const [i, text] of ["Clear lessons", "Lessons are clear", "Friendly teacher", "Friendly and patient"].entries()) {
    await saveReview(statsId, { productId, email: `b${i}@example.com`, reference: `cs_test_unr${i}0000000000`, pi: `pi_unr${i}`, rating: 5, text, name: `B ${i}` }, ROOM);
  }
  const store = (await storeForEmail(OWNER))!;
  const now = Date.now();
  const jobs = async () => Number((await original([["GET", aiMonthKey(store, new Date(now))!]]))[0] ?? 0);

  part("Reviews that could not be read: no model call, no AI job, said as such");
  offShape(`nl:rev:vis:${statsId}:${productId}`);
  let result: unknown;
  try {
    result = await makeReviewSummary(store, productId, now);
  } catch (error) {
    result = `threw ${(error as Error).name}`;
  } finally {
    redis.pipeline = original;
  }
  is("its own answer, not a server error", result, { ok: false, reason: "unread" });
  is("no model call, no AI job", [asked, await jobs()], [0, 0]);

  offShape(`nl:rev:vis:${statsId}:${productId}`);
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const response = await POST(new NextRequest("https://marktmorgen.com/api/store/review-summary", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ product: productId }) }));
  redis.pipeline = original;
  is("the route says so with a retryable status", [response.status, ((await response.json()) as { error?: string }).error], [503, "unread"]);

  const screen = readFileSync("components/review-ai-summaries.tsx", "utf8");
  const words = screen.match(/\n\s*unread: "([^"]+)"/)?.[1] ?? "";
  is("the studio's words for it say no AI job was used", [words.includes("no AI job"), words.includes("counts as one")], [true, false]);
  done();
}

main();
