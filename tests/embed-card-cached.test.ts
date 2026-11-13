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
 *     the database (proxy.ts rewrites it);
 *   - an open by the checkout script past its limit per connection and store
 *     reads neither the store nor the product.
 */
import { renderToReadableStream } from "react-dom/server";
import { NextRequest } from "next/server";
import EmbedCard from "@/app/embed/[handle]/[product]/page";
import { proxy } from "@/proxy";
import { OPENS_PER_TEN_MINUTES } from "@/lib/embed-sites";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription } from "@/lib/store";
import { answering } from "./security/next-headers";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
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
