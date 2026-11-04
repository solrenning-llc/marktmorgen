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
import { markSeriesEnded, markSeriesOpen, runningSeries, seriesOpenKey, seriesReleaseBytes } from "@/lib/call-series-open";
import { POST as currencyRoute } from "@/app/api/store/currency/route";
import { POST as taxRoute } from "@/app/api/store/tax/route";
import { dataKey } from "@/lib/store-data";
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
  const send = async (route: typeof currencyRoute, path: string, body: Record<string, unknown>) => {
    const response = await route(new NextRequest(`https://marktmorgen.com/api/store/${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; running?: number; currency?: string } };
  };
  const post = (body: Record<string, unknown>) => send(currencyRoute, "currency", body);
  const taxPost = (body: Record<string, unknown>) => send(taxRoute, "tax", body);
  const now = Date.now();

  part("A series running");
  await markSeriesOpen(diary, "a".repeat(32), now + 21 * 86_400_000);
  await markSeriesOpen(diary, "b".repeat(32), now + 7 * 86_400_000);
  is("two running", await runningSeries(store, now), 2);
  const refused = await post({ currency: "eur", confirm: true });
  is("the change is refused, with how many series are running", [refused.status, refused.body.ok, refused.body.error, refused.body.running], [409, false, "series", 2]);
  is("and the store keeps its currency", (await storeForEmail(owner))!.currency, "usd");
  const taxOn = await taxPost({ enabled: true, included: false, ids: false, invoices: false });
  is("switching sales tax on is refused too, with how many series run (C2-94 review, medium 3)", [taxOn.status, taxOn.body.ok, taxOn.body.error, taxOn.body.running], [409, false, "series", 2]);
  is("and tax stays off", (await storeForEmail(owner))!.tax.enabled, false);
  const taxIds = await taxPost({ enabled: false, included: false, ids: true, invoices: false });
  is("the tax number box alone, with tax off, stays free", [taxIds.status, taxIds.body.ok, (await storeForEmail(owner))!.tax.ids], [200, true, true]);

  part("A series over");
  await markSeriesEnded(diary, "a".repeat(32));
  is("one ended early is no longer counted", [await runningSeries(store, now), (await redis.pipeline([["ZCARD", seriesOpenKey(diary.callsId)]]))[0]], [1, 1]);
  is("one whose last session has ended is not counted, nor at the moment it ends", [await runningSeries(store, now + 7 * 86_400_000), await runningSeries(store, now + 8 * 86_400_000)], [0, 0]);
  is("a store with no call diary has none", await runningSeries({ callsId: null }, now), 0);

  part("What is written");
  const room = async () => Number((await redis.pipeline([["HGET", dataKey(store)!, "o"]]))[0] ?? 0);
  const before = await room();
  const id = (c: string) => c.repeat(32);
  const refusedWrite = async (f: () => Promise<void>) => { try { await f(); return false; } catch { return true; } };
  is("an id that is not 32 hex characters, or an end not in milliseconds after now, is refused", [await refusedWrite(() => markSeriesOpen(diary, "s1", now + 86_400_000, now)), await refusedWrite(() => markSeriesOpen(diary, id("c"), Math.floor((now + 86_400_000) / 1000), now)), await refusedWrite(() => markSeriesOpen(diary, id("c"), now, now)), await refusedWrite(() => markSeriesOpen(diary, id("c"), Number.NaN, now)), await refusedWrite(() => markSeriesOpen(diary, id("c"), now + 0.5, now))], [true, true, true, true, true]);
  await markSeriesOpen(diary, id("c"), now + 2 * 86_400_000, now);
  await markSeriesOpen(diary, id("e"), now + 2 * 86_400_000 + 1, now);
  const charged = (await room()) - before;
  // Moving b's end is free (the member is there already): the room changes only by what the pruning gives back.
  const beforePrune = await room();
  await markSeriesOpen(diary, id("b"), now + 9 * 86_400_000, now + 3 * 86_400_000);
  const zset = seriesOpenKey(diary.callsId);
  is("a write removes the series over first and gives back exactly seriesReleaseBytes() for each one removed, never more than was charged", [(await redis.pipeline([["ZSCORE", zset, id("c")]]))[0], (await redis.pipeline([["ZSCORE", zset, id("e")]]))[0], beforePrune - (await room()), charged >= 2 * seriesReleaseBytes(), seriesReleaseBytes() > 0], [null, null, 2 * seriesReleaseBytes(), true, true]);
  const beforeAgain = await room();
  await markSeriesOpen(diary, id("b"), now + 10 * 86_400_000, now + 3 * 86_400_000);
  is("nothing over: nothing given back a second time", beforeAgain - (await room()), 0);
  const beforeEnd = await room();
  await markSeriesEnded(diary, id("b"), now + 3 * 86_400_000);
  await markSeriesEnded(diary, id("b"), now + 3 * 86_400_000);
  is("a series ended early gives its bytes back once, however often it is ended", beforeEnd - (await room()), seriesReleaseBytes());

  part("The studio says why");
  const panel = readFileSync("components/payments-panel.tsx", "utf8");
  const taxEditor = readFileSync("components/tax-editor.tsx", "utf8");
  is("the tax refusal is said in plain words", taxEditor.includes("series: \"A series of calls is still running in your store."), true);
  is("the refusal is said with how many and when it lifts", panel.includes('data.error === "series"') && panel.includes("charging in the currency it was booked in until its last session, whatever you choose here") && !/series of calls[^`]*\$\{chosen/.test(panel), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
