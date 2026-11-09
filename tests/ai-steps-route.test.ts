/**
 * The writing help's route for a drafted page told step by step, and its
 * stop (758 [STN5] unit 1; app/api/store/ai/route.ts). The model is played
 * by a stand-in for `fetch`; the database is the in-memory one. What is
 * checked:
 *   - a stop leaves one short-lived mark under the store's own name, needs
 *     the products permission like the page itself, and is never held back
 *     by the per-minute limit on writing (stopping must always be possible);
 *   - a run id that is not one is refused, with nothing kept or asked;
 *   - a page asked for with steps comes back as lines: a padding line big
 *     enough for browsers that hold small replies, each step as it starts
 *     and ends, then the result with what is left;
 *   - the same page asked for without steps still comes back as one answer.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { AI_PER_MINUTE } from "@/lib/ai-rules";
import { POST } from "@/app/api/store/ai/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "steps.route@example.com";
const ORIGIN = "https://marktmorgen.com";
const DRAFT = {
  headline: "Forty weeknight dinners your kids will eat",
  sub: "One page per recipe.",
  story: null,
  benefits: ["One recipe per page", "A shopping list each week"],
  inside: [],
  faq: [{ q: "What format is it?", a: "A printable PDF." }],
  guarantee: "",
  cta: "Get the pack",
  seoTitle: "Weeknight Recipe Pack",
  seoDescription: "Forty weeknight dinners.",
};
let calls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  if (new URL(String(input)).hostname !== "api.anthropic.com") return new Response("{}", { status: 404 });
  calls += 1;
  return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(DRAFT) }] }));
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.ANTHROPIC_API_KEY = `sk-ant-api03-${"x".repeat(40)}`;
  await claimHandle(OWNER, "stepsroute", "Steps Route", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_StepsRt0001", subscriptionId: "sub_StepsRt0001", active: true, tier: "scale", trialEnds: 0, period: paidPeriod() });
  const made = await addProduct(OWNER, "Recipe Pack", "Forty weeknight dinners", "27", null);
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail(OWNER))!;
  const session = await openSession(OWNER);
  const ask = (body: Record<string, unknown>) =>
    POST(
      new NextRequest(`${ORIGIN}/api/store/ai`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` },
        body: JSON.stringify(body),
      }),
    );
  const json = async (response: Response) => [response.status, ((await response.json().catch(() => ({}))) as { ok?: boolean; error?: string })];

  part("A stop leaves one short-lived mark under the store's own name");
  const run = "routerun00000001";
  is("the stop is taken", await json(await ask({ kind: "stop", run })), [200, { ok: true }]);
  const key = `nl:ai:stop:${store.statsId}:${run}`;
  const ttl = Number(redis.run(["TTL", key]));
  is("the mark is there and lasts at most five minutes", [redis.run(["GET", key]), ttl > 0 && ttl <= 300], ["1", true]);
  is("a run id that is not one is refused and nothing is kept", await json(await ask({ kind: "stop", run: "no good" })), [400, { ok: false, error: "invalid" }]);
  is("no mark for it", redis.run(["GET", `nl:ai:stop:${store.statsId}:no good`]), null);
  const many = [];
  for (let i = 0; i < AI_PER_MINUTE + 2; i += 1) many.push((await ask({ kind: "stop", run: `routerunmany${String(i).padStart(4, "0")}` })).status);
  is("stopping is never held back by the per-minute limit on writing", many.every((status) => status === 200), true);
  is("and it asks the model nothing", calls, 0);

  part("A page asked for with steps comes back step by step");
  calls = 0;
  const stepped = await ask({ kind: "page", product: made.product.id, steps: true, run: "routerunpage0001", notes: "" });
  is("a stream of lines", [stepped.status, stepped.headers.get("content-type"), stepped.headers.get("cache-control")], [200, "application/x-ndjson; charset=utf-8", "no-store"]);
  const lines = (await stepped.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  const first = new TextEncoder().encode(JSON.stringify(lines[0])).length;
  is("the first line is padding, at least a kilobyte, and says nothing else", [Object.keys(lines[0] ?? {}), first >= 1024], [["pad"], true]);
  is("one step, said as it starts and ends", lines.slice(1, -1), [
    { step: "write", state: "started" },
    { step: "write", state: "done" },
  ]);
  const last = lines[lines.length - 1] as { done?: boolean; ok?: boolean; value?: { headline?: string }; left?: number };
  is("then the draft, with what is left", [last.done, last.ok, last.value?.headline, typeof last.left === "number"], [true, true, DRAFT.headline, true]);
  is("one model call", calls, 1);

  part("Steps with a run id that is not one");
  calls = 0;
  is("refused before anything is asked", await json(await ask({ kind: "page", product: made.product.id, steps: true, run: "nope", notes: "" })), [400, { ok: false, error: "invalid" }]);
  is("no model call", calls, 0);

  part("Without steps, one answer as before");
  calls = 0;
  const plain = await ask({ kind: "page", product: made.product.id, notes: "" });
  const body = (await plain.json()) as { ok?: boolean; value?: { headline?: string } };
  is("the draft as one JSON answer", [plain.status, plain.headers.get("content-type")?.startsWith("application/json"), body.ok, body.value?.headline], [200, true, true, DRAFT.headline]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
