/**
 * The store's currency is never changed while a series of calls is running
 * (637 [GL5]; C2-94, 4 November 2026): each series is charged in the
 * currency it was booked in (lib/call-series-billing.ts,
 * ChargeRecord.currency), so the currency route refuses, with the reason
 * and how many, until its last session has ended. Through the real route,
 * on a synthetic store with no Stripe account and the memory stand-in for
 * Redis.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStoreId, setProductCall, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import type { CallSetup } from "@/lib/call-setup";
import { markSeriesEnded, markSeriesOpen, runningSeries, seriesOpenKey } from "@/lib/call-series-open";
import { POST as currencyRoute } from "@/app/api/store/currency/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const weekly = {
  kind: "weekly",
  minutes: 60,
  tz: "America/New_York",
  weekly: [[], [[540, 1020]], [], [], [], [], []],
  noticeHours: 12,
  horizonDays: 30,
  bufferMinutes: 0,
  room: "https://example.com/room",
  video: false,
  meet: null,
  seats: 1,
  sessions: [],
} as unknown as CallSetup;

async function main(): Promise<void> {
  redis.clear();
  const owner = "seriescurrency@example.com";
  await claimHandle(owner, "seriescur", "Series Currency", "");
  await ensureStoreId(owner);
  const call = await addProduct(owner, "Coaching Call", "", "80", null);
  if (!call.ok) throw new Error("no product");
  is("a weekly call", (await setProductCall(owner, call.product.id, weekly)).ok, true);
  const store = (await storeForEmail(owner))!;
  const diary = { ...store, callsId: store.callsId! };
  const session = await openSession(owner);
  const post = async (body: Record<string, unknown>) => {
    const response = await currencyRoute(new NextRequest("https://marktmorgen.com/api/store/currency", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; running?: number; currency?: string } };
  };
  const now = Date.now();

  part("A series running");
  await markSeriesOpen(diary, "a".repeat(32), now + 21 * 86_400_000);
  await markSeriesOpen(diary, "b".repeat(32), now + 7 * 86_400_000);
  is("two running", await runningSeries(store, now), 2);
  const refused = await post({ currency: "eur", confirm: true });
  is("the change is refused, with how many series are running", [refused.status, refused.body.ok, refused.body.error, refused.body.running], [409, false, "series", 2]);
  is("and the store keeps its currency", (await storeForEmail(owner))!.currency, "usd");

  part("A series over");
  await markSeriesEnded(diary, "a".repeat(32));
  is("one ended early is no longer counted", [await runningSeries(store, now), (await redis.pipeline([["ZCARD", seriesOpenKey(diary.callsId)]]))[0]], [1, 1]);
  is("one whose last session has ended is not counted, nor at the moment it ends", [await runningSeries(store, now + 7 * 86_400_000), await runningSeries(store, now + 8 * 86_400_000)], [0, 0]);
  is("a store with no call diary has none", await runningSeries({ callsId: null }, now), 0);

  part("The studio says why");
  const panel = readFileSync("components/payments-panel.tsx", "utf8");
  is("the refusal is said with how many and when it lifts", panel.includes('data.error === "series"') && panel.includes("charged in ${currency.toUpperCase()}, the currency it was booked in"), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
