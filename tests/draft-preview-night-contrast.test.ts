/**
 * Review of #3440 (Claude 1 cloud R): the preview page's "could not be loaded" sentence keeps 7:1 on a Night card and
 * is marked as the fixed US English it is. Synthetic store only.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductAbout, setProductHidden, setSubscription, storeForEmail, updateLook } from "@/lib/store";
import { writeAbout } from "@/lib/product-about";
import { makeDraftPreview } from "@/lib/draft-preview";
import { DEFAULT_LOOK } from "@/lib/store-look";
import PreviewPage from "@/app/[handle]/preview/[code]/page";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const lum = (hex: string) => {
  const c = [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16) / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

async function main(): Promise<void> {
  redis.clear();
  const owner = "night@example.com";
  await claimHandle(owner, "nightshop", "nightshop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_n", subscriptionId: "sub_n", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  await updateLook(owner, { ...DEFAULT_LOOK, theme: "night" });
  const made = await addProduct(owner, "The Quiet Course", "Six calm lessons", "29", null);
  if (!made.ok) throw new Error("no product");
  await setProductHidden(owner, made.product.id, true);
  const marked = await setProductAbout(owner, made.product.id, true);
  if (marked.ok && marked.store.statsId) await writeAbout(marked.store.statsId, made.product.id, "What is inside.", marked.store);
  const store = (await storeForEmail(owner))!;
  is("the store is Night", store.look.theme, "night");
  const link = await makeDraftPreview(store, made.product.id);
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((command) => String(command[1]).startsWith("nl:product:about:"))) throw new Error("Redis request failed with status 500");
    return real(commands);
  }) as typeof redis.pipeline;
  let html = "";
  try {
    html = renderToStaticMarkup(await PreviewPage({ params: Promise.resolve({ handle: "@nightshop", code: link.code }) }));
  } finally {
    redis.pipeline = real;
  }
  const tag = /<p class="([^"]*)"([^>]*)>The description could not be loaded just now\./.exec(html);
  is("the sentence is drawn", Boolean(tag), true);
  const color = tag && /\btext-ink\b/.test(tag[1]) ? "#111827" : "#f5f3ff";
  is("the sentence keeps 7:1 on the Night card (#16133a)", ratio(color, "#16133a") >= 7, true);
  is("the fixed English sentence is marked as US English inside the store's language (3.1.2)", Boolean(tag && /\blang="en-US"/.test(tag[2])), true);
}

main().then(done);
