/**
 * A product held for a child-safety report keeps its settings as they were
 * (C1-20261109-1546-TODOS-70, unit 2; Claude 6's focal review on #3471).
 *
 * The owner's urgent email says the creator cannot change a held product for
 * 400 days. Beyond its files, options, picture, page, episodes and lessons,
 * the studio routes that change a product's settings refuse it too: buyer
 * fields, stamping, the PDF preview, shipping, picks, the thank-you note,
 * stock and add-ons, and the funnel after paying. A hold that cannot be read
 * refuses as well (503); another product is not touched by it.
 *
 * Synthetic store and placeholder names, in-memory Redis; nothing leaves the
 * process.
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { holdReported } from "@/lib/child-safety";
import { POST as fieldsRoute } from "@/app/api/store/fields/route";
import { POST as stampRoute } from "@/app/api/store/stamp/route";
import { POST as previewRoute } from "@/app/api/store/preview/route";
import { POST as shippingRoute } from "@/app/api/store/shipping/route";
import { POST as pairsRoute } from "@/app/api/store/pairs/route";
import { POST as thanksRoute } from "@/app/api/store/thanks-note/route";
import { POST as extrasRoute } from "@/app/api/store/extras/route";
import { POST as funnelRoute } from "@/app/api/store/funnel/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 404, headers: { "content-type": "application/json" } })) as typeof fetch;

type Handler = (request: NextRequest) => Promise<Response>;
const OWNER = "hold.settings@example.com";
const ORIGIN = "https://marktmorgen.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "holdsettings", "Hold Settings", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_hs", subscriptionId: "sub_hs", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const session = await openSession(OWNER);
  const send = async (route: Handler, path: string, body: Record<string, unknown>) => {
    const response = await route(new NextRequest(`${ORIGIN}/api/store/${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}`, origin: ORIGIN, host: "marktmorgen.com" }, body: JSON.stringify(body) }));
    return [response.status, ((await response.json().catch(() => ({}))) as { error?: string }).error ?? "ok"];
  };
  const made = await addProduct(OWNER, "reported-item-1", "", "19", null);
  const other = await addProduct(OWNER, "free-item-1", "", "19", null);
  if (!made.ok || !other.ok) throw new Error("no products");
  const held = made.product.id;
  const free = other.product.id;
  is("held", await holdReported({ kind: "child_safety", url: `${ORIGIN}/@holdsettings/p/${held}` }, (await storeForEmail(OWNER))!), "held");

  const asks: [string, Handler, string, (id: string) => Record<string, unknown>][] = [
    ["buyer fields", fieldsRoute, "fields", (id) => ({ id, fields: [] })],
    ["stamping", stampRoute, "stamp", (id) => ({ id, on: true })],
    ["the PDF preview", previewRoute, "preview", (id) => ({ id, pages: 1 })],
    ["shipping", shippingRoute, "shipping", (id) => ({ id, shipping: null })],
    ["picks", pairsRoute, "pairs", (id) => ({ id, pairs: [] })],
    ["the thank-you note", thanksRoute, "thanks-note", (id) => ({ id, note: null })],
    ["stock and add-ons", extrasRoute, "extras", (id) => ({ id, stock: null })],
    ["the funnel after paying", funnelRoute, "funnel", (id) => ({ id, funnel: null })],
  ];

  part("Every settings route refuses the held product, and only it");
  for (const [what, route, path, body] of asks) {
    is(`${what}: refused while held`, await send(route, path, body(held)), [409, "on_hold"]);
    const free_ = await send(route, path, body(free));
    is(`${what}: another product is not refused for it`, free_[1] !== "on_hold" && free_[0] !== 409, true);
  }

  part("A hold that cannot be read refuses, never lets the change through");
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) =>
    commands[0]?.[0] === "GET" && String(commands[0]?.[1] ?? "").startsWith("nl:csa:keep:") ? [42] : real(commands)) as typeof redis.pipeline;
  for (const [what, route, path, body] of asks) is(`${what}: unknown hold`, await send(route, path, body(held)), [503, "unavailable"]);
  redis.pipeline = real;

  done();
}

main();
