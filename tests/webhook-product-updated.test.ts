/**
 * The webhook event product.updated (378 [TB4] complement WG (a)): sent when
 * a product on the store (not a draft) is saved through the studio's product
 * route (app/api/store/product/route.ts, action "edit"). What is checked,
 * through the real route with a synthetic store and session:
 *
 *   - a price change: one message with the product as it is now and previous
 *     holding only the price as it was;
 *   - a title and summary change: previous holds those two;
 *   - a save that changes none of them still says the product was saved, with
 *     an empty previous;
 *   - a draft saved sends nothing; a save refused sends nothing;
 *   - it is an event a store can listen for, listed in the studio.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId, ensureStoreId, setProductHidden, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as productRoute } from "@/app/api/store/product/route";
import { WEBHOOK_EVENTS, addEndpoint, recentMessages, setSendHooksForTests } from "@/lib/webhooks";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
setSendHooksForTests({ fetch: { resolve: (async () => { throw new Error("no network in tests"); }) as never } });
console.error = () => {};

type Message = { data: { product: { id: string; title: string; summary: string; price_cents: number; url: string }; previous: Record<string, unknown>; updated_at: string } };

async function main(): Promise<void> {
  redis.clear();
  const owner = "update-hook@example.com";
  await claimHandle(owner, "updatehook", "Update Hook", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1UpdHookxxxxxxx", true);
  await setSubscription(owner, { customerId: "cus_updhook", subscriptionId: "sub_updhook", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  let store = (await storeForEmail(owner))!;
  if (!(await addEndpoint(store, "https://hooks.example.com/products", ["product.updated"])).ok) throw new Error("no endpoint");
  const session = await openSession(owner);
  const send = async (body: Record<string, unknown>) => {
    const response = await productRoute(new NextRequest("https://marktmorgen.com/api/store/product", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; product?: { id: string } } };
  };
  const messages = async () => {
    store = (await storeForEmail(owner))!;
    return (await recentMessages(store, "product.updated", 10)) as unknown as Message[];
  };

  part("An event a store can listen for, in the studio's list");
  is("product.updated is one of the events", (WEBHOOK_EVENTS as readonly string[]).includes("product.updated"), true);
  is("the studio lists it", readFileSync("components/webhook-editor.tsx", "utf8").includes('key: "product.updated", label: "Product updated"'), true);

  const added = await send({ action: "add", title: "The Bread Guide", summary: "How I bake every day", price: "19" });
  const id = added.body.product?.id ?? "";
  is("a product on the store", [added.status, id.length > 0], [200, true]);
  is("adding it is not an update", (await messages()).length, 0);

  part("A price change: previous is the price as it was");
  const priced = await send({ action: "edit", id, title: "The Bread Guide", summary: "How I bake every day", price: "29" });
  is("saved", [priced.status, priced.body.ok], [200, true]);
  let sent = await messages();
  is("one message, the product as it is now", [sent.length, sent[0]?.data.product.id, sent[0]?.data.product.price_cents, sent[0]?.data.product.title, sent[0]?.data.product.url.endsWith(id)], [1, id, 2900, "The Bread Guide", true]);
  is("previous: only the price, as it was", sent[0]?.data.previous, { price_cents: 1900 });

  part("A title and summary change; a save with none");
  await send({ action: "edit", id, title: "The Bread Book", summary: "Every loaf I bake", price: "29" });
  sent = await messages();
  is("previous: the title and summary as they were", sent[0]?.data.previous, { title: "The Bread Guide", summary: "How I bake every day" });
  await send({ action: "edit", id, title: "The Bread Book", summary: "Every loaf I bake", price: "29" });
  sent = await messages();
  is("saved again unchanged: said saved, nothing in previous", [sent.length, sent[0]?.data.previous], [3, {}]);

  part("A draft saved, or a save refused, sends nothing");
  await setProductHidden(owner, id, true);
  await send({ action: "edit", id, title: "The Bread Book, draft", summary: "Every loaf I bake", price: "29" });
  is("a draft saved: nothing", (await messages()).length, 3);
  await setProductHidden(owner, id, false);
  const refused = await send({ action: "edit", id, title: "Make easy money from home", summary: "Every loaf I bake", price: "29" });
  is("a save refused (the Terms check)", [refused.status, refused.body.error], [409, "fast_money"]);
  is("sends nothing", (await messages()).length, 3);

  done();
}

void main();
