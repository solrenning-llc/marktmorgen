/**
 * The product card pasted into a creator's own site (DONO-20261113-DEC-2, the
 * owner's decision on Claude 7's ALTO finding, 13 November 2026).
 *
 * Before: every display of the pasted frame (/embed/<store>/<product>, no
 * ?mm=) ran the card page as a function, with no cache, and sent the database
 * about seven commands (the store, the product, coming soon, stock, keys, the
 * boxes added at checkout, the rating), counted as no visit, never resting
 * and with no limit per connection; the checkout script's open (?mm=) read
 * the store and the product before its limit per connection was asked. The
 * cost registry priced it at zero.
 *
 * Held here, against the in-memory Redis double and a synthetic store:
 *   - a pasted display reaches a cached copy, never the card page that reads
 *     the database (proxy.ts rewrites it), with the place and the site it is
 *     shown on in the copy's address and the policy of a page built ahead of
 *     time, framed by any site;
 *   - the copy is forced static and made again once a CARD_FRESH_SECONDS
 *     window (revalidate, expireTime), reads nothing of the request, and
 *     each store's copies take one of CARD_BUILDS_PER_WINDOW before the store
 *     is read: past them a copy reads nothing and is a plain link;
 *   - a copy at its largest (limited stock, boxes added at checkout, a rating)
 *     stays inside CARD_COPY_COMMANDS, never says how many are left, and
 *     still says "Sold out" when it was; whether it sells on a site follows
 *     the store's list as the card page does;
 *   - an open by the checkout script past its limit per connection and store
 *     reads neither the store nor the product;
 *   - the registry's line is the store's month of copies at the most each
 *     costs, and it is no longer zero.
 */
import { renderToReadableStream } from "react-dom/server";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import EmbedCard from "@/app/embed/[handle]/[product]/page";
import CardCopy, { dynamic, revalidate } from "@/app/embed/[handle]/[product]/card/[view]/page";
import { proxy } from "@/proxy";
import { OPENS_PER_TEN_MINUTES } from "@/lib/embed-sites";
import { CARD_BUILDS_PER_WINDOW, CARD_FRESH_SECONDS, cardView, readCardView } from "@/lib/embed-card-view";
import { wordsIn } from "@/lib/buyer-words";
import { MAX_BUMPS } from "@/lib/product-extras";
import { addProduct, claimHandle, ensureStatsId, setEmbedSites, setProductExtras, setProductLink, setProductShipping, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { CARD_COPIES_PER_MONTH, CARD_COPY_BUILD, CARD_COPY_COMMANDS, CARD_WINDOWS_PER_MONTH, COST_LINES } from "./plan-cost-registry";
import { answering } from "./security/next-headers";
import { paidPeriod } from "./billing-period-fixture";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const sent: Command[] = [];
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: Command[]) => {
  sent.push(...batch);
  return real(batch);
}) as typeof redis.pipeline;
globalThis.fetch = (async () => {
  throw new Error("No external provider in this test");
}) as typeof fetch;

const OWNER = "embed-card-cached@example.test";
const HANDLE = "embcached";

/** Whether a command reads the store's record or a product's. */
const readsStoreOrProduct = (c: Command) => c.slice(1).some((k) => typeof k === "string" && /^nl:(store|catalog|product)/.test(k));

async function html(node: React.ReactElement): Promise<string> {
  const stream = await renderToReadableStream(node, { onError: () => {} });
  await stream.allReady;
  return new Response(stream).text();
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_embed_card_cached";
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Embed Cached", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_EmbCached01", subscriptionId: "sub_EmbCached01", active: true, tier: "creator", cycle: "month", period: paidPeriod() });
  await setStripeAccount(OWNER, "acct_1EmbCachedTest01", true);
  const made = await addProduct(OWNER, "Field guide", "A synthetic guide.", "40", null);
  if (!made.ok) throw new Error("product fixture");
  await setProductLink(OWNER, made.product.id, "https://example.test/guide");
  const id = made.product.id;

  const display = async (search: string, ip: string) => {
    const url = `https://marktmorgen.com/embed/${HANDLE}/${id}${search}`;
    answering(new NextRequest(url, { headers: { "x-forwarded-for": ip, referer: "https://blog.example.test/post" } }));
    const query = Object.fromEntries(new URL(url).searchParams);
    const from = sent.length;
    await html((await EmbedCard({ params: Promise.resolve({ handle: HANDLE, product: id }), searchParams: Promise.resolve(query) } as never)) as React.ReactElement);
    return sent.slice(from);
  };

  part("What one display of the card page sends");
  const once = await display("?utm_source=blog", "198.51.100.7");
  console.log(`one display of the card page: ${once.length} commands (${once.map((c) => c[0]).join(", ")})`);
  is("the card page reads the store and the product when it is drawn", once.some(readsStoreOrProduct), true);

  part("A pasted display reaches the cached copy, never the card page");
  const pasted = proxy(new NextRequest(`https://marktmorgen.com/embed/${HANDLE}/${id}?utm_source=blog`, { headers: { referer: "https://blog.example.test/post" } }));
  const rewrite = (await pasted).headers.get("x-middleware-rewrite") ?? "";
  is("the proxy rewrites it to the cached copy", new URL(rewrite || "https://x.invalid/").pathname.startsWith(`/embed/${HANDLE}/${id}/card/`), true);
  const opened = proxy(new NextRequest(`https://marktmorgen.com/embed/${HANDLE}/${id}?mm=overlay`));
  is("an open by the checkout script stays on the card page, drawn for that open", (await opened).headers.get("x-middleware-rewrite"), null);

  part("The copy's address and its policy");
  const view = new URL(rewrite || "https://x.invalid/").pathname.split("/").at(-1) ?? "";
  is("the copy's address carries the place and the site it is shown on", readCardView(view), { place: "blog", site: "https://blog.example.test" });
  is("and nothing else of the display: no query", new URL(rewrite || "https://x.invalid/").search, "");
  const policy = (await pasted).headers.get("content-security-policy") ?? "";
  is("the copy's policy has no nonce, and any site may frame it", [/'nonce-/.test(policy), /frame-ancestors \*/.test(policy)], [false, true]);
  const direct = await proxy(new NextRequest(`https://marktmorgen.com/embed/${HANDLE}/${id}/card/${view}`));
  is("asked for at its own address, the copy gets the same policy", direct.headers.get("content-security-policy"), policy);
  const odd = await proxy(new NextRequest(`https://marktmorgen.com/embed/${HANDLE}/${id}?mm=nonsense`));
  is("a ?mm= the script never sends is a pasted card too", new URL(odd.headers.get("x-middleware-rewrite") ?? "https://x.invalid/").pathname.startsWith(`/embed/${HANDLE}/${id}/card/`), true);
  const join = await proxy(new NextRequest(`https://marktmorgen.com/embed/${HANDLE}/join`));
  is("the sign-up form is left where it is", join.headers.get("x-middleware-rewrite"), null);
  is("no Referer is no site", readCardView(cardView("blog", null)), { place: "blog", site: null });
  is("a site forged into the address that is not an origin is no site", readCardView("blog~" + btoa("javascript:alert(1)")).site, null);

  part("The copy is built ahead of its displays and made again once a window");
  const copySource = readFileSync("app/embed/[handle]/[product]/card/[view]/page.tsx", "utf8");
  is("forced static, made again every CARD_FRESH_SECONDS", [dynamic, revalidate], ["force-static", CARD_FRESH_SECONDS]);
  is("served stale at most one more window while it is made again (expireTime)", /expireTime: 600,/.test(readFileSync("next.config.ts", "utf8")) && 600 === 2 * CARD_FRESH_SECONDS, true);
  is("it reads nothing of the request", /next\/headers|connection\(|searchParams|cookies\(/.test(copySource), false);

  const copy = async (shown: string, site: string | null = null) => {
    const from = sent.length;
    const page = await html((await CardCopy({ params: Promise.resolve({ handle: HANDLE, product: shown, view: cardView("blog", site) }) } as never)) as React.ReactElement);
    return { page, commands: sent.slice(from) };
  };
  const w = wordsIn((await storeForEmail(OWNER))!.language);

  part("A copy at its largest");
  const pan = await addProduct(OWNER, "Cast iron pan", "Seasoned, shipped in a week.", "59", null);
  if (!pan.ok) throw new Error("product fixture");
  const shipped = await setProductShipping(OWNER, pan.product.id, { cents: 0, region: "us", countries: ["US"], note: "" });
  if (!shipped.ok) throw new Error(`not shipped: ${shipped.reason}`);
  if (!(await setProductExtras(OWNER, pan.product.id, { stock: 7 })).ok) throw new Error("stock fixture");
  // The most a card reads: a limited product with every box it may have (MAX_BUMPS), each another product read.
  const kit = await addProduct(OWNER, "Starter kit", "Everything to begin.", "49", null);
  if (!kit.ok) throw new Error("product fixture");
  await setProductLink(OWNER, kit.product.id, "https://example.test/kit");
  if (!(await setProductExtras(OWNER, kit.product.id, { stock: 7 })).ok) throw new Error("stock fixture");
  for (let slot = 0; slot < MAX_BUMPS; slot += 1) {
    const extra = await addProduct(OWNER, `Extra ${slot + 1}`, "A synthetic extra.", "15", null);
    if (!extra.ok) throw new Error("product fixture");
    await setProductLink(OWNER, extra.product.id, `https://example.test/extra-${slot + 1}`);
    const added = await setProductExtras(OWNER, kit.product.id, { bump: { productId: extra.product.id, priceCents: 500, pitch: "Add it." }, slot });
    if (!added.ok) throw new Error(`bump fixture: ${added.reason}`);
  }
  // A new window for the store's copies.
  advance((CARD_FRESH_SECONDS + 1) * 1000);
  const largest = await copy(kit.product.id);
  console.log(`one copy at its largest: ${largest.commands.length} commands (${largest.commands.map((c) => c[0]).join(", ")})`);
  is(`it stays inside CARD_COPY_COMMANDS (${largest.commands.length} of ${CARD_COPY_COMMANDS})`, largest.commands.length <= CARD_COPY_COMMANDS, true);
  const sold = await copy(pan.product.id);
  is("a shipped product's copy sells from its button where the store lists no site", sold.page.includes('action="/api/store/checkout"'), true);
  is("it never says how many are left, which could be out of date", [sold.page.includes(w.left(7, "7")), largest.page.includes(w.left(7, "7"))], [false, false]);
  is("it asks no other service: stock is counted without Stripe", largest.commands.some((c) => c[0] === "HGETALL" && String(c[1]).startsWith("nl:stock:")), true);
  // Every unit sold: seven paid entries in the product's stock record (lib/stock.ts).
  const stockRecord = `nl:stock:${(await storeForEmail(OWNER))!.statsId}:${pan.product.id}`;
  await redis.pipeline(Array.from({ length: 7 }, (_, i) => ["HSET", stockRecord, `cs_test_sold_${i}`, JSON.stringify({ until: 0, paid: true })]));
  const soldOut = (await copy(pan.product.id)).page;
  is("a product sold out when the copy is made says so, and sells nothing", [soldOut.includes(w.soldOut), soldOut.includes('action="/api/store/checkout"')], [true, false]);
  await redis.pipeline([["DEL", stockRecord]]);

  part("A store that lists its sites sells only from them, as the card page does");
  if (!(await setEmbedSites(OWNER, ["https://shop.example.test"])).ok) throw new Error("sites fixture");
  is("on a listed site, the copy sells from its button", (await copy(pan.product.id, "https://shop.example.test/page")).page.includes('action="/api/store/checkout"'), true);
  const off = (await copy(pan.product.id, "https://blog.example.test/post")).page;
  is("on any other, its button is a plain link to the product's page", [off.includes('action="/api/store/checkout"'), off.includes(`/@${HANDLE}/p/`)], [false, true]);
  is("with no site read, the same", (await copy(pan.product.id)).page.includes('action="/api/store/checkout"'), false);
  if (!(await setEmbedSites(OWNER, [])).ok) throw new Error("sites fixture");

  part("Each store's copies of a window are counted before anything is read");
  advance((CARD_FRESH_SECONDS + 1) * 1000);
  for (let i = 0; i < CARD_BUILDS_PER_WINDOW; i += 1) await copy(id);
  const spent = await copy(id);
  is(`the copy after ${CARD_BUILDS_PER_WINDOW} in a window reads neither the store nor the product`, spent.commands.some(readsStoreOrProduct), false);
  is("and sends only its counter", spent.commands.length <= 2, true);
  is("it is a plain link to the product's page, in a new tab", [spent.page.includes(`href="/@${HANDLE}/p/${id}?utm_source=blog&amp;utm_medium=buy-button"`), spent.page.includes('target="_blank"'), spent.page.includes('action="/api/store/checkout"')], [true, true, false]);

  part("The registry prices the store's month of copies");
  const line = COST_LINES.find((l) => l.id === "embed")!;
  is("a month is CARD_BUILDS_PER_WINDOW copies in every window a 31-day month can touch", [CARD_WINDOWS_PER_MONTH, CARD_COPIES_PER_MONTH], [Math.floor((31 * 86_400) / CARD_FRESH_SECONDS) + 1, CARD_BUILDS_PER_WINDOW * CARD_WINDOWS_PER_MONTH]);
  is("the line is that many copies at the most each costs, on every plan", (["creator", "pro", "scale"] as const).map((tier) => line.monthlyUsd(tier)), (["creator", "pro", "scale"] as const).map(() => CARD_COPIES_PER_MONTH * CARD_COPY_BUILD));
  console.log(`one copy at its largest: $${CARD_COPY_BUILD.toFixed(6)}; a store's worst month: $${line.monthlyUsd("creator").toFixed(4)}`);
  is("and it is no longer priced at zero", line.monthlyUsd("creator") > 0, true);

  part("An open by the checkout script past its limit reads nothing");
  const ip = "203.0.113.41";
  for (let i = 0; i < OPENS_PER_TEN_MINUTES; i += 1) await display("?mm=overlay", ip);
  const past = await display("?mm=overlay", ip);
  is(`the open after ${OPENS_PER_TEN_MINUTES} from one connection reads neither the store nor the product`, past.some(readsStoreOrProduct), false);
  is("and sends only its counter", past.length <= 2, true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
