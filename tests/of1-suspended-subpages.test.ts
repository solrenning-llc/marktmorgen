/**
 * 662 [OF1], unit 1: a store switched off after notices about its content
 * (`store.suspended`, lib/takedown.ts) says so on its public subpages too,
 * as its own page and its product pages already do, through the real pages,
 * route and store:
 *
 * - the full list of a product's reviews (app/[handle]/p/[product]/reviews),
 * - the page where a buyer writes a review (app/[handle]/review) and the
 *   route that saves one (app/api/store/review),
 * - the page where a free copy is asked for and picked up (app/[handle]/free),
 * - the way back from an unpaid checkout (app/[handle]/left),
 * - the store's web app manifest (app/[handle]/manifest.webmanifest).
 *
 * Each page answers with StoreResting `suspended` before it reads anything
 * past the store itself (no product, no review, no claim, no Stripe call),
 * and its tab title names neither the store nor a product. The manifest is
 * a 404 no cache keeps. Switched back on, every one of them works as before.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import ReviewsPage, { generateMetadata as reviewsMeta } from "@/app/[handle]/p/[product]/reviews/page";
import ReviewPage, { generateMetadata as reviewMeta } from "@/app/[handle]/review/page";
import FreePage, { generateMetadata as freeMeta } from "@/app/[handle]/free/page";
import LeftPage, { generateMetadata as leftMeta } from "@/app/[handle]/left/page";
import { GET as manifest } from "@/app/[handle]/manifest.webmanifest/route";
import { POST as saveReview } from "@/app/api/store/review/route";
import { StoreResting } from "@/components/store-resting";
import { BLOCK_WORDS } from "@/lib/buyer-words/blocks";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, noteTakedown, setStripeAccount, setSubscription, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { answering } from "./security/next-headers";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

type Search = Record<string, string>;
type Drawn = { type?: unknown; props?: { suspended?: boolean } } | undefined;

async function main(): Promise<void> {
  // A stand-in key: every call to Stripe is answered by the counting fetch below, never sent.
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  redis.clear();
  const owner = "of1@example.com";
  await claimHandle(owner, "glazeworks", "Glaze Works", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_of1", subscriptionId: "sub_of1", active: true, tier: "creator", period: paidPeriod() });
  // A connected account, so an order on the review page and route is looked up at Stripe while the store is on.
  await setStripeAccount(owner, "acct_1Of1Glaze0000000", true);
  const paid = await addProduct(owner, "Kiln Secrets Course", "", "49");
  const free = await addProduct(owner, "Glaze Chart Freebie", "", "0");
  if (!paid.ok || !free.ok) throw new Error("products not made");
  const paidId = paid.product.id;
  const freeId = free.product.id;
  const handle = "@glazeworks";
  // The pages read the request they answer (its host, a domain of the store's own) as in Next.
  answering(new Request("https://marktmorgen.com/@glazeworks"));

  // A page as Next draws it: the element it returns, or where it sends the visitor.
  const open = async (page: (args: { params: Promise<never>; searchParams: Promise<Search> }) => Promise<unknown>, params: Record<string, string>, search: Search = {}): Promise<Drawn | { redirect: string }> => {
    try {
      return (await page({ params: Promise.resolve(params) as Promise<never>, searchParams: Promise.resolve(search) })) as Drawn;
    } catch (error) {
      const digest = (error as { digest?: string }).digest ?? "";
      if (digest.startsWith("NEXT_REDIRECT")) return { redirect: digest.split(";")[2] ?? "" };
      throw error;
    }
  };
  const resting = (drawn: Drawn | { redirect: string }) => {
    const element = drawn as Drawn;
    return [element?.type === StoreResting, element?.props?.suspended === true];
  };
  const pages = {
    reviews: () => open(ReviewsPage as never, { handle, product: paidId }),
    review: () => open(ReviewPage as never, { handle }, { session_id: "cs_test_of1reviewdoor0000000000" }),
    free: () => open(FreePage as never, { handle }, { status: "sent", product: freeId }),
    left: () => open(LeftPage as never, { handle }, { p: paidId }),
  };
  const titles = async () =>
    Promise.all([
      reviewsMeta({ params: Promise.resolve({ handle, product: paidId }), searchParams: Promise.resolve({}) }),
      reviewMeta({ params: Promise.resolve({ handle }), searchParams: Promise.resolve({}) }),
      freeMeta({ params: Promise.resolve({ handle }), searchParams: Promise.resolve({}) }),
      leftMeta({ params: Promise.resolve({ handle }), searchParams: Promise.resolve({}) }),
    ]).then((all) => all.map((meta) => String(meta.title)));
  const app = () => manifest(new NextRequest("https://marktmorgen.com/@glazeworks/manifest.webmanifest"), { params: Promise.resolve({ handle }) });
  const post = () => {
    const form = new URLSearchParams({ handle: "glazeworks", product: paidId, session_id: "cs_test_of1reviewdoor0000000000", stars: "5", text: "Great course" });
    return saveReview(new NextRequest("https://marktmorgen.com/api/store/review", { method: "POST", body: form, headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://marktmorgen.com", Host: "marktmorgen.com" } }));
  };

  // Stripe is never reached by a store that is switched off: any call to it is counted here.
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched += 1;
    return new Response(JSON.stringify({ error: { message: "not in this test" } }), { status: 500 });
  }) as typeof fetch;

  // Every command the store's data is sent, to see what a page reads.
  const base = redis.pipeline.bind(redis);
  const sent: string[] = [];
  redis.pipeline = async (batch) => {
    sent.push(...batch.map((c) => `${c[0]} ${c[1] ?? ""}`));
    return base(batch);
  };
  const commands = async (run: () => Promise<unknown>) => {
    sent.length = 0;
    await run();
    return [...sent];
  };

  try {
    part("While the store is on");
    is("the list of reviews is drawn", resting(await pages.reviews()), [false, false]);
    fetched = 0;
    is("the review page is drawn", resting(await pages.review()), [false, false]);
    is("and the order in its link is looked up at Stripe", fetched > 0, true);
    fetched = 0;
    const onPost = await post();
    is("a review sent is checked against the order at Stripe", [onPost.status, fetched > 0], [303, true]);
    is("the free copy's page is drawn", resting(await pages.free()), [false, false]);
    is("the way back from a checkout is drawn", resting(await pages.left()), [false, false]);
    const live = await app();
    is("the web app manifest is given", [live.status, live.headers.get("content-type")], [200, "application/manifest+json; charset=utf-8"]);
    is("the list's title names the product", (await titles())[0].includes("Kiln Secrets Course"), true);

    part("Switched off after a report (lib/takedown.ts)");
    await noteTakedown(owner, null, true);
    const words = BLOCK_WORDS.en;
    is("the list of reviews says the store is not available", resting(await pages.reviews()), [true, true]);
    is("so does the review page", resting(await pages.review()), [true, true]);
    is("so does the free copy's page", resting(await pages.free()), [true, true]);
    is("so does the way back from a checkout", resting(await pages.left()), [true, true]);
    const shut = await app();
    is("the web app manifest is not given, and no cache keeps the answer", [shut.status, shut.headers.get("cache-control")], [404, "no-store"]);
    const shown = await titles();
    is("each tab says the page is unavailable", shown.every((title) => title.startsWith(words.unavailableTitle)), true);
    is("and names neither the store nor a product", shown.some((title) => /Glaze Works|Kiln Secrets|Glaze Chart/.test(title)), false);

    part("Nothing past the store is read for a store that is switched off");
    const storeOnly = await commands(() => storeForHandle("glazeworks"));
    for (const [name, run] of Object.entries(pages)) {
      is(`${name}: the same commands as reading the store alone`, await commands(run), storeOnly);
    }
    fetched = 0;
    await pages.review();
    is("the review page asks Stripe nothing about the order", fetched, 0);
    const refused = await post();
    is("a review sent for it is not saved and Stripe is not asked", [refused.status, fetched], [303, 0]);
    is("the buyer is sent back to the review page, which says the store is not available", (refused.headers.get("location") ?? "").includes("/@glazeworks/review?") && (refused.headers.get("location") ?? "").includes("status=error"), true);

    part("Switched back on");
    await noteTakedown(owner, null, false);
    is("every page is drawn again", [resting(await pages.reviews())[0], resting(await pages.review())[0], resting(await pages.free())[0], resting(await pages.left())[0]], [false, false, false, false]);
    is("and the manifest is given again", (await app()).status, 200);
    is("the list's title names the product again", (await titles())[0].includes("Kiln Secrets Course"), true);

    part("Each check is made where the store is read, before anything else");
    // The code between the two, comments set aside.
    const between = (text: string) => text.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("//")).join("\n");
    for (const file of ["app/[handle]/p/[product]/reviews/page.tsx", "app/[handle]/review/page.tsx", "app/[handle]/free/page.tsx", "app/[handle]/left/page.tsx"]) {
      const source = readFileSync(file, "utf8");
      const read = source.indexOf("if (!store) notFound();");
      const check = source.indexOf("if (store.suspended) return <StoreResting store={store} suspended />;");
      is(`${file}: StoreResting suspended right after the store is read`, check > read && read > 0 && between(source.slice(read, check)) === "if (!store) notFound();", true);
    }
  } finally {
    redis.pipeline = base;
    globalThis.fetch = realFetch;
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
