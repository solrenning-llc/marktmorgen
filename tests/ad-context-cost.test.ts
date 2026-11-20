/**
 * A save of a campaign landing checks the ad's words against the product's reviews, and those reads are counted
 * before they are made (Claude 5's second review of #1950, item 2): AD_CONTEXT_UNITS studio requests at the reviews'
 * heaviest, besides the save's own, and a save that moves the most it can stays inside what those requests cover.
 * A page deleted while the save ran answers 410 "gone" with the reason, never a server error (item 1). The real route,
 * session and store (MemoryRedis); no outside request.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/campaign-landing/route";
import { AD_CONTEXT_UNITS, AD_REVIEWS, AD_REVIEW_BYTES, STUDIO_REQUEST_BYTES, pageReadUnits } from "@/lib/ad-context";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { dropLandings } from "@/lib/campaign-landing-store";
import { MAX_REPLY_TEXT, MAX_REVIEW_NAME, MAX_REVIEW_TEXT } from "@/lib/review-summary";
import { parsePage } from "@/lib/sales-page";
import { writePage } from "@/lib/sales-page-store";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { allowanceUsed } from "@/lib/store-allowance";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

let outside = 0;
globalThis.fetch = (async () => {
  outside++;
  throw new Error("No outside request in this test");
}) as typeof fetch;

// A review at every field's longest, in characters of three bytes each (the most one UTF-16 unit takes in UTF-8).
const heavy = (id: string, productId: string) =>
  JSON.stringify({
    id,
    productId,
    reference: "c".repeat(220),
    pi: "p".repeat(220),
    rating: 5,
    text: "€".repeat(MAX_REVIEW_TEXT),
    name: "€".repeat(MAX_REVIEW_NAME),
    createdAt: 1_790_000_000_000,
    editedAt: 1_790_000_000_000,
    hidden: false,
    hiddenReason: null,
    refunded: false,
    reply: { text: "€".repeat(MAX_REPLY_TEXT), at: 1_790_000_000_000 },
    photo: { path: `stores/${"s".repeat(40)}/reviews/${"r".repeat(200)}.webp`, width: 4_000, height: 4_000 },
    paidAt: 1_790_000_000,
  });

async function main(): Promise<void> {
  part("The figures");
  is("a review at its longest fits AD_REVIEW_BYTES", Buffer.byteLength(heavy("a".repeat(24), "p".repeat(10))) <= AD_REVIEW_BYTES, true);
  const registry = readFileSync("tests/plan-cost-registry.ts", "utf8");
  is("STUDIO_REQUEST_BYTES is the studio request's bytes in UNIT_COST", registry.includes(`studio: request("studio", 20 + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS, ${STUDIO_REQUEST_BYTES.toLocaleString("en-US").replace(/,/g, "_")})`), true);
  is("the check is counted at every review it reads", AD_CONTEXT_UNITS, Math.ceil((AD_REVIEWS * AD_REVIEW_BYTES) / STUDIO_REQUEST_BYTES));

  redis.clear();
  const owner = "landing-cost@example.test";
  await claimHandle(owner, "landingcost", "Landing Cost", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_landingcost", subscriptionId: "sub_landingcost", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(owner, "Knife Skills", "", "40");
  const product = made.ok ? made.product.id : "";
  const store = (await storeForEmail(owner))!;
  await writePage(store.statsId!, product, parsePage({ blocks: [{ id: "hero0001", kind: "hero", headline: "Knife Skills", sub: "", media: "none", video: null }] }), store);
  const commands: (string | number)[][] = [];
  for (let i = 0; i < AD_REVIEWS; i += 1) {
    const id = i.toString(16).padStart(24, "0");
    commands.push(["HSET", `nl:rev:${store.statsId}:${product}`, id, heavy(id, product)], ["ZADD", `nl:rev:vis:${store.statsId}:${product}`, 1_790_000_000 + i, id]);
  }
  await redis.pipeline(commands);
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const save = async () => {
    const response = await POST(
      new NextRequest("https://marktmorgen.com/api/store/campaign-landing", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ action: "save", product, campaign: "spring-sale", headline: "Cook a real dinner in twenty minutes", text: "A short course on knife skills.", button: "Start cooking" }),
      }),
    );
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; message?: string } };
  };

  part("A save that reads every review at its heaviest");
  const pipe = redis.pipeline.bind(redis);
  let moved = 0;
  redis.pipeline = (async (cs: (string | number)[][]) => {
    const replies = await pipe(cs);
    moved += Buffer.byteLength(JSON.stringify(cs)) + Buffer.byteLength(JSON.stringify(replies ?? null));
    return replies;
  }) as typeof redis.pipeline;
  const before = await allowanceUsed(store, "studio");
  let saved: Awaited<ReturnType<typeof save>>;
  try {
    saved = await save();
  } finally {
    redis.pipeline = pipe;
  }
  is("saved", saved.status, 200);
  const [pageKept] = (await pipe([["STRLEN", `nl:product:page:${store.statsId}:${product}`]])) as number[];
  const units = 1 + AD_CONTEXT_UNITS + pageReadUnits(pageKept);
  is("the save and the check's reads were counted first (its page's too, Claude 5's return on #1950)", (await allowanceUsed(store, "studio")) - before, units);
  is("what it moved fits the requests it was counted at", moved <= units * STUDIO_REQUEST_BYTES, true);

  part("The page is deleted while a save runs");
  await dropLandings(store.statsId!, product, store);
  const gone = await save();
  is("410, never a server error", [gone.status, gone.body.error], [410, "gone"]);
  is("the reason is said in plain words", gone.body.message?.startsWith("This product's page was removed"), true);
  is("no outside request", outside, 0);
  done();
}
void main();
