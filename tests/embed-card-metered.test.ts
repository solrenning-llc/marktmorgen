/**
 * The embedded product card counts as one of the store's public requests before it reads anything (#4634).
 *
 * app/embed/[handle]/[product]/page.tsx is dynamic, so the CDN never answers it, and every render read the store's
 * stock (with up to five Stripe reads for lapsed holds), its licence keys, its bumps' listings and its reviews
 * summary, with no public request taken and isResting never called; an opened card from a site the creator did not
 * list skipped even the script's own limit (lib/embed-open.ts). A loop of requests from anywhere cost the store's
 * Redis and the company's function time with no ceiling. The store's own pages call isResting before their reads
 * (app/[handle]/p/[product]/page.tsx); the card now does the same, on every path, and a resting store's card is the
 * card's own "could not be loaded just now" line with a link to the store, reading nothing else.
 *
 * Rendered too (Claude 7 on #4645): an open by the checkout script takes the store's request once, not twice; the
 * card's worst render (limited stock with lapsed holds, keys, a bump, the summary, opened by the script) stays inside
 * a later page's commands (COMMANDS.laterPage + COMMANDS.laterCount); and a resting store's card reads none of it.
 * Synthetic store; Stripe is a stand-in; MemoryRedis.
 */
import { readFileSync } from "node:fs";
import { renderToReadableStream } from "react-dom/server";
import { NextRequest } from "next/server";
import EmbedCard from "@/app/embed/[handle]/[product]/page";
import { addProduct, claimHandle, ensureStatsId, setProductExtras, setProductKeys, setProductLink, setStripeAccount, setSubscription, storeFolder, storeForEmail } from "@/lib/store";
import { DEFAULT_KEYS } from "@/lib/key-setup";
import { allowanceWindow } from "@/lib/allowance-window";
import { publicVisitLimit, requestLimitFor } from "@/lib/traffic-rules";
import { COMMANDS } from "./traffic-cost";
import { answering } from "./security/next-headers";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const card = readFileSync("app/embed/[handle]/[product]/page.tsx", "utf8");
const at = (text: string) => card.indexOf(text);

async function main(): Promise<void> {
part("Counted before anything is read");
is("the card asks isResting", /isResting\(store\)/.test(card), true);
is("before the script's open is read", at("isResting(store)") > 0 && at("isResting(store)") < at("await readScriptOpen("), true);
is("before stock, keys, bumps and the summary are read", at("isResting(store)") > 0 && at("isResting(store)") < at("stockLeft(store, product)"), true);

part("A resting store's card reads nothing more");
is("it says the product could not be loaded just now, with a way to the store", /if \(resting\)[\s\S]{0,400}cardUnread[\s\S]{0,400}seeStore/.test(card), true);

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let log: Command[] | null = null;
redis.pipeline = (async (batch: Command[]) => {
  if (log) log.push(...batch);
  return real(batch);
}) as typeof redis.pipeline;
// Each lapsed hold's checkout, asked of Stripe: expired, so the hold is let go.
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.stripe.com" && url.pathname.startsWith("/v1/checkout/sessions/")) {
    return new Response(JSON.stringify({ id: url.pathname.split("/").pop(), object: "checkout.session", status: "expired", payment_status: "unpaid" }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

async function html(node: React.ReactElement): Promise<string> {
  const stream = await renderToReadableStream(node, { onError: () => {} });
  await stream.allReady;
  return new Response(stream).text();
}

redis.clear();
process.env.STRIPE_SECRET_KEY = "sk_test_embed_card_metered_only";
const owner = "embed-card-metered@example.test";
await claimHandle(owner, "embmetered", "Embed Metered", "");
await ensureStatsId(owner);
await setSubscription(owner, { customerId: "cus_EmbMeter0001", subscriptionId: "sub_EmbMeter0001", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
await setStripeAccount(owner, "acct_1EmbMetered01", true);
const main_ = await addProduct(owner, "Worst Guide", "A synthetic guide.", "40", null);
const extra = await addProduct(owner, "Side Guide", "A synthetic extra.", "10", null);
if (!main_.ok || !extra.ok) throw new Error("product fixture");
await setProductLink(owner, main_.product.id, "https://example.test/worst");
await setProductLink(owner, extra.product.id, "https://example.test/side");
await setProductKeys(owner, main_.product.id, DEFAULT_KEYS);
if (!(await setProductExtras(owner, main_.product.id, { stock: 5 })).ok) throw new Error("stock fixture");
if (!(await setProductExtras(owner, main_.product.id, { bump: { productId: extra.product.id, priceCents: 500, pitch: "Add it." }, slot: 0 })).ok) throw new Error("bump fixture");
const store = (await storeForEmail(owner))!;
// Five holds that ran out, so the stock count asks Stripe about each (the most it reads) and lets them go.
const lapsed = Date.now() - 60_000;
for (let i = 0; i < 5; i += 1) await redis.pipeline([["HSET", `nl:stock:${store.statsId}:${main_.product.id}`, `cs_test_${"h".repeat(20)}${i}`, JSON.stringify({ until: lapsed })]]);

const render = async (mm?: string) => {
  answering(new NextRequest(`https://marktmorgen.com/embed/embmetered/${main_.product.id}${mm ? `?mm=${mm}` : ""}`));
  return html((await EmbedCard({ params: Promise.resolve({ handle: "embmetered", product: main_.product.id }), searchParams: Promise.resolve(mm ? { mm } : {}) } as never)) as React.ReactElement);
};
const folder = await storeFolder(owner);
const counter = `nl:traffic:r:${folder}:${allowanceWindow(store)!.id}`;

part("An open by the checkout script takes the store's request once");
log = [];
await render("page");
const opened = log;
log = null;
is("one INCRBY of the store's requests, not two", opened.filter((c) => c[0] === "INCRBY").length, 1);

part("The worst card stays inside a later page's commands");
const ceiling = COMMANDS.laterPage + COMMANDS.laterCount;
is(`opened by the script, with limited stock, five lapsed holds, keys, a bump and the summary: at most ${ceiling} commands (${opened.length}: ${opened.map((c) => c[0]).join(", ")})`, opened.length <= ceiling, true);
log = [];
await render();
const plain = log;
log = null;
is(`a plain render: at most ${ceiling} commands (${plain.length})`, plain.length <= ceiling, true);

part("A resting store's card reads none of it");
await redis.pipeline([["SET", counter, String(publicVisitLimit(requestLimitFor(store, Date.now() / 1000)))]]);
log = [];
await render("page");
const rested = log;
log = null;
const readsContent = rested.some((c) => typeof c[1] === "string" && /^nl:(stock|wl|rev|rl:embed-open|lk|keys)[:]/.test(c[1]));
// The keys the worst render above reads: nl:stock (stock and its holds), nl:wl (coming soon), nl:rev (the summary),
// nl:rl:embed-open (the script's own limit).
is("no stock, coming-soon, summary or script-open read", readsContent ? rested.map((c) => `${c[0]} ${c[1]}`).join("; ") : "none", "none");

done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
