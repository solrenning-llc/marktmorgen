/**
 * A store's front page names one address for search engines, whatever the
 * spelling a visitor typed (issue #4126). Handles are read without regard to
 * case (normaliseHandle), so /@LocalShop draws the same page as /@localshop;
 * without a canonical of its own the root layout's relative "./" made each
 * spelling its own indexable address. Synthetic store, no network.
 */
import { generateMetadata } from "@/app/[handle]/page";
import { addProduct, claimHandle, ensureStatsId } from "@/lib/store";
import { SITE_URL } from "@/lib/site-url";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const OWNER = "front-canonical@example.test";

async function meta(handle: string) {
  return generateMetadata({ params: Promise.resolve({ handle }) });
}

async function main(): Promise<void> {
  redis.clear();
  const made = await claimHandle(OWNER, "localshop", "Local Shop", "Synthetic store.");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  const added = await addProduct(OWNER, "Fictional guide", "", "9", null);
  if (!added.ok) throw new Error("no product");

  part("the front page names the store's own address as its canonical");
  const lower = await meta("@localshop");
  is("lower-case spelling: canonical", lower.alternates?.canonical, `${SITE_URL}/@localshop`);
  const mixed = await meta(encodeURIComponent("@LocalShop"));
  is("mixed-case spelling: the same canonical", mixed.alternates?.canonical, `${SITE_URL}/@localshop`);
  is("mixed-case spelling: still indexable as the one store", mixed.robots, { index: true, follow: true });

  done();
}

void main();
