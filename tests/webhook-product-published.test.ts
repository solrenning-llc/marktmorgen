/**
 * The webhook event product.published (378 [TB4] complement WG (a)): sent
 * when a product goes on the store through the studio's product route
 * (app/api/store/product/route.ts): a new product added, which is on the
 * store at once, or a draft published. What is checked, through the real
 * route with a synthetic store and session:
 *
 *   - adding a product sends one message, "added", with its id, title,
 *     price, currency and link;
 *   - taking it off the store sends nothing; publishing it again sends one,
 *     "draft_published";
 *   - asking to publish a product already on the store sends nothing;
 *   - a publish that is refused (nothing to hand over) sends nothing;
 *   - only to endpoints that listen for it; it is an event a store can
 *     listen for, listed in the studio.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductHidden, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as productRoute } from "@/app/api/store/product/route";
import { WEBHOOK_EVENTS, addEndpoint, recentMessages, setSendHooksForTests } from "@/lib/webhooks";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
setSendHooksForTests({ fetch: { resolve: (async () => { throw new Error("no network in tests"); }) as never } });
console.error = () => {};

type Message = { type: string; data: { product: { id: string; title: string; price_cents: number; currency: string; url: string }; how: string; published_at: string } };

async function main(): Promise<void> {
  redis.clear();
  const owner = "publish-hook@example.com";
  await claimHandle(owner, "publishhook", "Publish Hook", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1PubHookxxxxxxx", true);
  await setSubscription(owner, { customerId: "cus_pubhook", subscriptionId: "sub_pubhook", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  let store = (await storeForEmail(owner))!;
  const listening = await addEndpoint(store, "https://hooks.example.com/products", ["product.published"]);
  const deaf = await addEndpoint(store, "https://hooks.example.com/sales", ["sale.completed"]);
  if (!listening.ok || !deaf.ok) throw new Error("no endpoints");
  const session = await openSession(owner);
  const send = async (body: Record<string, unknown>) => {
    const response = await productRoute(new NextRequest("https://marktmorgen.com/api/store/product", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; product?: { id: string } } };
  };
  const messages = async () => {
    store = (await storeForEmail(owner))!;
    return (await recentMessages(store, "product.published", 10)) as unknown as Message[];
  };

  part("An event a store can listen for, in the studio's list");
  is("product.published is one of the events", (WEBHOOK_EVENTS as readonly string[]).includes("product.published"), true);
  is("the studio lists it with what it means", readFileSync("components/webhook-editor.tsx", "utf8").includes('key: "product.published", label: "Product published"'), true);

  part("A new product: on the store at once, said once as added");
  const added = await send({ action: "add", title: "The Bread Guide", summary: "How I bake every day", price: "19" });
  const id = added.body.product?.id ?? "";
  is("added", [added.status, added.body.ok, id.length > 0], [200, true, true]);
  let sent = await messages();
  is("one message, added", [sent.length, sent[0]?.type, sent[0]?.data.how], [1, "product.published", "added"]);
  is("its id, title, price, currency and link", [sent[0]?.data.product.id, sent[0]?.data.product.title, sent[0]?.data.product.price_cents, sent[0]?.data.product.currency, sent[0]?.data.product.url.endsWith(id)], [id, "The Bread Guide", 1900, store.currency, true]);

  part("Off the store and on again");
  const off = await send({ action: "visibility", id, hidden: true });
  is("taken off", [off.status, off.body.ok], [200, true]);
  is("nothing sent for taking it off", (await messages()).length, 1);
  // A product with nothing to hand over is not published (754 [STN1]): refused, and nothing sent.
  const refused = await send({ action: "visibility", id, hidden: false });
  is("a publish refused for nothing to hand over", [refused.status, refused.body.error], [409, "nothing_to_hand_over"]);
  is("sends nothing", (await messages()).length, 1);

  part("A draft with something to hand over, published");
  const made = await addProduct(owner, "The Starter Notes", "Notes", "9", null);
  if (!made.ok) throw new Error("no product");
  await setProductHidden(owner, made.product.id, true);
  is("its link added", (await setProductLink(owner, made.product.id, "https://example.com/starter-notes")).ok, true);
  const published = await send({ action: "visibility", id: made.product.id, hidden: false });
  is("published", [published.status, published.body.ok], [200, true]);
  sent = await messages();
  const last = sent.find((m) => m.data.product.id === made.product.id);
  is("one message, draft_published, with its title", [last?.data.how, last?.data.product.title], ["draft_published", "The Starter Notes"]);
  const before = sent.length;
  const again = await send({ action: "visibility", id: made.product.id, hidden: false });
  is("asked to publish a product already on the store", [again.status, again.body.ok], [200, true]);
  is("sends nothing more", (await messages()).length, before);

  part("Only to the endpoint that listens");
  const log = await redis.pipeline([["LRANGE", `nl:hooks:log:${store.statsId}`, 0, -1]]);
  const rows = (await redis.pipeline(((log[0] as string[]) ?? []).map((d) => ["GET", `nl:hooks:d:${d}`]))) as string[];
  const to = new Set(rows.map((raw) => JSON.parse(raw) as { endpoint: string; type: string }).filter((d) => d.type === "product.published").map((d) => d.endpoint));
  is("every delivery to it", [...to], [listening.view.endpoints.find((e) => e.where.endsWith("/products"))!.id]);

  done();
}

void main();
