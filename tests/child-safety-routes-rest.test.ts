/**
 * The last studio routes that changed a product kept for a child-safety
 * report (Claude 3's second review on #3471, MÉDIO, rule 30): the pre-order
 * switch, the one-press offer after paying, a call's setup, a call's package
 * and the AI agent's description proposal, with its undo.
 *
 * The owner's urgent email says the creator cannot change a held product for
 * 400 days; these five refused nothing. Each now refuses the held product
 * (409 `on_hold`, or "terms" for the agent's write), refuses when the hold
 * cannot be read (503, never a write), and leaves another product alone.
 *
 * Synthetic store and placeholder names, in-memory Redis; nothing leaves the
 * process.
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { holdReported } from "@/lib/child-safety";
import { PRODUCT_DESCRIPTION, descriptionRefusal } from "@/lib/agent-kinds";
import { POST as preorderRoute } from "@/app/api/store/preorder/route";
import { POST as nextOfferRoute } from "@/app/api/store/next-offer/route";
import { POST as callRoute } from "@/app/api/store/call/route";
import { POST as callPackageRoute } from "@/app/api/store/call-package/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 404, headers: { "content-type": "application/json" } })) as typeof fetch;

type Handler = (request: NextRequest) => Promise<Response>;
const OWNER = "hold.rest@example.com";
const ORIGIN = "https://marktmorgen.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "holdrest", "Hold Rest", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_hr", subscriptionId: "sub_hr", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const session = await openSession(OWNER);
  const send = async (route: Handler, path: string, body: Record<string, unknown>) => {
    const response = await route(new NextRequest(`${ORIGIN}/api/store/${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}`, origin: ORIGIN, host: "marktmorgen.com" }, body: JSON.stringify(body) }));
    return [response.status, ((await response.json().catch(() => ({}))) as { error?: string }).error ?? "ok"];
  };
  const made = await addProduct(OWNER, "reported-item-2", "", "19", null);
  const other = await addProduct(OWNER, "free-item-2", "", "19", null);
  const third = await addProduct(OWNER, "free-item-3", "", "19", null);
  if (!made.ok || !other.ok || !third.ok) throw new Error("no products");
  const held = made.product.id;
  const free = other.product.id;
  const free2 = third.product.id;
  is("held", await holdReported({ kind: "child_safety", url: `${ORIGIN}/@holdrest/p/${held}` }, (await storeForEmail(OWNER))!), "held");

  const asks: [string, Handler, string, (id: string) => Record<string, unknown>][] = [
    ["stopping a pre-order", preorderRoute, "preorder", (id) => ({ id, day: null })],
    ["the offer after paying, from it", nextOfferRoute, "next-offer", (id) => ({ from: id, to: id === held ? free : free2 })],
    ["the offer after paying, of it", nextOfferRoute, "next-offer", (id) => ({ from: id === held ? free : free2, to: id === held ? held : free })],
    ["removing a call", callRoute, "call", (id) => ({ id, remove: true })],
    ["taking a call's package off", callPackageRoute, "call-package", (id) => ({ id, sessions: 0 })],
  ];

  part("Every remaining route refuses the held product, and only it");
  for (const [what, route, path, body] of asks) {
    is(`${what}: refused while held`, await send(route, path, body(held)), [409, "on_hold"]);
    const free_ = await send(route, path, body(free));
    is(`${what}: another product is not refused for it`, free_[1] !== "on_hold" && free_[0] !== 409, true);
  }

  part("The agent's description: refused on the held product, its undo too");
  const store = (await storeForEmail(OWNER))!;
  is("a proposal is refused", typeof (await descriptionRefusal(store, held, "New words for it.")), "string");
  is("the write is refused", await PRODUCT_DESCRIPTION.write(store, OWNER, held, "New words for it.", ""), "terms");
  is("its description is untouched", await PRODUCT_DESCRIPTION.current(store, held), "");
  is("an undo back to nothing is refused as well", await PRODUCT_DESCRIPTION.write(store, OWNER, held, "", ""), "terms");
  is("another product is not refused for it", await descriptionRefusal(store, free, "New words for it."), null);

  part("A hold that cannot be read refuses, never lets the change through");
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) =>
    commands[0]?.[0] === "GET" && String(commands[0]?.[1] ?? "").startsWith("nl:csa:keep:") ? [42] : real(commands)) as typeof redis.pipeline;
  for (const [what, route, path, body] of asks) is(`${what}: unknown hold`, await send(route, path, body(held)), [503, "unavailable"]);
  is("the agent's write: unknown hold", await PRODUCT_DESCRIPTION.write(store, OWNER, held, "New words for it.", ""), "terms");
  redis.pipeline = real;

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
