/**
 * #5285 row #2978, Claude 4's LEVE (6708130791, rule 24): the cart's GET answered 404 { error: "unknown" } whenever the
 * store behind the handle could not be read (Redis not configured, a reply in another shape, a record that does not
 * parse), and the cart (components/store-cart.tsx) shows that 404 as "this store is not taking orders", with no "Try
 * again". A store that could not be read is not a store that does not exist: it now answers 503 { error: "unavailable" },
 * which the cart shows as an ordinary failure, while a free handle still answers 404 { error: "unknown" }.
 *
 * Synthetic store; the Redis stand-in only.
 */
import { NextRequest } from "next/server";
import { GET as readCart } from "@/app/api/store/cart/route";
import { claimHandle, ensureStatsId } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Pipeline = (commands: (string | number)[][]) => Promise<unknown[]>;
const real: Pipeline = redis.pipeline.bind(redis);

async function ask(handle: string): Promise<{ status: number; error?: string }> {
  const response = await readCart(new NextRequest(`https://marktmorgen.test/api/store/cart?handle=${handle}&ids=`, { headers: { host: "marktmorgen.test" } })).catch(() => new Response("{}", { status: 500 }));
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return { status: response.status, error: body.error };
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle("cart-unreadable@example.test", "cartunread", "Cart Unreadable", "");
  await ensureStatsId("cart-unreadable@example.test");

  part("A free handle is still a store that does not exist");
  is("404 unknown", await ask("nosuchstorehere"), { status: 404, error: "unknown" });

  part("A store that could not be read is not a store that does not exist (rule 24)");
  const pipelines = redis as unknown as { pipeline: Pipeline };
  pipelines.pipeline = async (commands) => {
    const replies = await real(commands);
    // The handle's own GET answers in another shape than text or nothing.
    return commands.map((c, i) => (c[0] === "GET" && String(c[1]).includes("cartunread") ? 7 : replies[i]));
  };
  try {
    is("a handle read in another shape: 503 unavailable, never 'not taking orders'", await ask("cartunread"), { status: 503, error: "unavailable" });
  } finally {
    pipelines.pipeline = real;
  }
  pipelines.pipeline = async (commands) => {
    const replies = await real(commands);
    // The owner's record reads back as text that is not a store.
    return commands.map((c, i) => (c[0] === "GET" && String(c[1]).startsWith("nl:store:") ? "{not a store" : replies[i]));
  };
  try {
    is("a record that does not parse: 503 unavailable", await ask("cartunread"), { status: 503, error: "unavailable" });
  } finally {
    pipelines.pipeline = real;
  }
  pipelines.pipeline = () => Promise.reject(new Error("database down"));
  try {
    is("a database that does not answer: 503 unavailable", await ask("cartunread"), { status: 503, error: "unavailable" });
  } finally {
    pipelines.pipeline = real;
  }

  part("A live store still reads");
  is("200", (await ask("cartunread")).status, 200);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
