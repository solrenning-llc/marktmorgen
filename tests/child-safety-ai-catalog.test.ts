/**
 * A product kept for a child-safety report goes to no AI provider, through the
 * writing helps that read the whole catalog too (Codex L on #3588, MEDIUM):
 * blog, store posts, bio, media kit, FAQ and email sequence. The keep mark is
 * written before the product is hidden; when that hide write fails, the
 * product stays listed (hidden false), and these six built their prompt from
 * every product not hidden. Each now leaves out every held product, and a hold
 * that cannot be read leaves out every product it was read for. Synthetic: the
 * memory Redis, and a stand-in for fetch that records only what would have
 * crossed to the model, answering nothing.
 */
import { NextRequest } from "next/server";
import { POST as aiRoute } from "@/app/api/store/ai/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { keepKey } from "@/lib/child-safety-holds";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "catalog-held@example.com";
const BASE = "https://marktmorgen.com";
const HELD = "QZXHELDMARKER";
const OPEN = "Plain Open Guide";

async function main(): Promise<void> {
  redis.clear();
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-only-a-stand-in";
  await claimHandle(OWNER, "catalogheld", "Catalog Held", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_catheld001", subscriptionId: "sub_catheld001", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const heldMade = await addProduct(OWNER, `${HELD} Guide`, `${HELD} summary words`, "29", null);
  const openMade = await addProduct(OWNER, OPEN, "An open summary", "19", null);
  if (!heldMade.ok || !openMade.ok) throw new Error("no products");
  const store = (await storeForEmail(OWNER))!;
  // The keep mark went in and the hide did not: the product is still listed (hidden false).
  redis.run(["SET", keepKey(store, heldMade.product.id), "1"]);
  is("the held product is still listed, as after a failed hide", store.catalog.head.find((p) => p.id === heldMade.product.id)?.hidden, false);

  const session = await openSession(OWNER);
  const outbound: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    // The model, by its exact host or by its messages path (lib/ai.ts may point it at a local stand-in).
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "api.anthropic.com" || url.pathname === "/v1/messages") outbound.push(String(init?.body ?? ""));
    return new Response("", { status: 500 });
  }) as typeof fetch;
  const ask = async (body: Record<string, unknown>): Promise<string> => {
    // A fresh minute for the writing help's pace (AI_PER_MINUTE), which these asks would otherwise reach.
    for (const key of redis.keys().filter((key) => key.startsWith("nl:rl:ai:"))) redis.run(["DEL", key]);
    const at = outbound.length;
    const request = new NextRequest(`${BASE}/api/store/ai`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, host: "marktmorgen.com", cookie: `${SESSION_COOKIE}=${session}` },
      body: JSON.stringify(body),
    });
    await aiRoute(request);
    return outbound.slice(at).join("\n");
  };
  const modes: [string, Record<string, unknown>][] = [
    ["blog", { kind: "blog", notes: "A post about what my shop sells." }],
    ["store posts", { kind: "posts", notes: "Posts about my shop." }],
    ["bio", { kind: "bio", notes: "A short bio." }],
    ["media kit", { kind: "kit", notes: "A pitch." }],
    ["FAQ", { kind: "faq", notes: "Common questions." }],
    ["email sequence", { kind: "sequence", trigger: "joined", notes: "A welcome series." }],
  ];

  try {
    part("Held and still listed: the six whole-catalog writing helps leave it out");
    for (const [name, body] of modes) {
      const sent = await ask(body);
      is(`${name}: the model was asked, with the store's other product`, sent.includes(OPEN), true);
      is(`${name}: the held title and summary did not cross to the model`, sent.includes(HELD), false);
    }

    part("A hold that cannot be read leaves out every product it was read for");
    const real = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: (string | number)[][]) =>
      commands.some((command) => command.slice(1).some((arg) => String(arg).startsWith("nl:csa:keep:"))) ? commands.map(() => 42) : real(commands)) as typeof redis.pipeline;
    try {
      for (const [name, body] of modes) {
        const sent = await ask(body);
        is(`${name}: neither product crossed to the model`, [sent.includes(HELD), sent.includes(OPEN)], [false, false]);
      }
    } finally {
      redis.pipeline = real;
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  done();
}

void main();
