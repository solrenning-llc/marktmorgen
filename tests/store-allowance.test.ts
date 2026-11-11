/**
 * The figures added on 17 October 2026 for the uses that had none
 * (lib/store-allowance.ts, lib/free-pool.ts, lib/email.ts meters,
 * lib/studio-route.ts, lib/traffic.ts public requests), run against the
 * in-memory Redis: each refused, before the cost, once the store's window
 * has used it; a store that pays nothing let in only with one of the month's
 * places; a paying store whose billing month is not known let in to nothing.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { allowanceUsed, takeAllowance } from "@/lib/store-allowance";
import { ALLOWANCE_KINDS, STORE_ALLOWANCES, NON_PAYING_ALLOWANCES, allowanceListWords } from "@/lib/store-allowance-rules";
import { admitNonPaying, poolThisMonth } from "@/lib/free-pool";
import { FREE_POOL_BASE_STORES, PAID_STORES_PER_FREE_STORE, PAYING_INDEX, freePoolSize } from "@/lib/free-pool-rules";
import { sendEmail } from "@/lib/email";
import { countStudio } from "@/lib/studio-route";
import { ESSENTIAL_PER_DAY, STUDIO_PAGE_UNITS } from "@/lib/studio-allowance-rules";
import { isResting, takePublicRequest } from "@/lib/traffic";
import { REQUESTS_PER_VISIT, EXTRA_REQUESTS, VISITS_INCLUDED, publicVisitLimit, requestLimitFor } from "@/lib/traffic-rules";
import { claimHandle, ensureStatsId, setSubscription, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { allowanceWindow } from "@/lib/allowance-window";
import { connect, refreshTargets, saveSettings, testConnection, disconnect, syncView } from "@/lib/email-sync";
import { seal } from "@/lib/secret-box";
import { setPlatformHooksForTests } from "@/lib/email-platforms";

const paying = (n: number, extra: Partial<Store> = {}) => ({
  sid: `${String(n).padStart(2, "0")}`.padEnd(32, "a"), handle: `paying${n}`, statsId: null, tier: "creator" as const,
  subscriptionActive: true, subscriptionId: `sub_Paying${String(n).padStart(6, "0")}`, trialEnds: 0, planEndedAt: "", cycle: "month" as const, period: paidPeriod(), ...extra,
});
const free = (n: number) => ({ sid: `${String(n).padStart(3, "0")}`.padEnd(32, "f"), handle: `free${n}`, statsId: null, tier: "creator" as const, subscriptionActive: false, subscriptionId: null, trialEnds: 0, planEndedAt: "" });

let sends = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  if (new URL(String(input)).hostname === "api.resend.com") { sends += 1; return new Response(JSON.stringify({ id: `email_${sends}` })); }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

beforeEach(() => { redis.clear(); sends = 0; process.env.RESEND_API_KEY = "re_test_allowances_only"; });

test("a figure is taken whole or refused, and a refused use takes nothing", async () => {
  const store = paying(1);
  const limit = STORE_ALLOWANCES.creator.studio;
  assert.deepEqual(await takeAllowance(store, "studio", limit), { ok: true, left: 0 });
  const refused = await takeAllowance(store, "studio");
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok && refused.reason === "used" && refused.message.includes(`${limit.toLocaleString("en-US")} studio requests`) && /next billing month/.test(refused.message), JSON.stringify(refused));
  assert.equal(await allowanceUsed(store, "studio"), limit);
  // A larger plan has a larger figure in the same window.
  assert.equal((await takeAllowance({ ...store, tier: "pro" }, "studio")).ok, true);
  // The next billing month starts with all of it.
  const next = { ...store, period: { start: store.period!.end, end: store.period!.end + 30 * 86_400, renews: true } };
  assert.equal((await takeAllowance(next, "studio", limit, next.period.start * 1000 + 1000)).ok, true);
});

// Codex H (#2269): a first period cut short before the first whole invoice (31 January to 15 February). In the two days
// after it ends, before Stripe's next period is written down, and once it is (15 February to 15 March), the studio's
// allowance is one, never two: the window in between begins at the known end, never on the anchor day after now.
test("after a partial first period, the grace window and the real next period share one allowance", async () => {
  const at = (m: number, d: number, h = 9) => Date.UTC(2027, m - 1, d, h, 23, 47);
  const limit = STORE_ALLOWANCES.creator.studio;
  const partial = paying(5, { period: { start: at(1, 31) / 1000, end: at(2, 15) / 1000, renews: true } });
  const now = at(2, 16);
  const grace = allowanceWindow(partial, now)!;
  assert.deepEqual([grace.start, grace.end, grace.start <= now && now < grace.end], [at(2, 15), at(3, 15), true]);
  assert.deepEqual(await takeAllowance(partial, "studio", limit, now), { ok: true, left: 0 });
  const real = { ...partial, period: { start: at(2, 15) / 1000, end: at(3, 15) / 1000, renews: true } };
  const again = await takeAllowance(real, "studio", limit, now);
  assert.equal(again.ok, false, JSON.stringify(again));
  assert.equal(await allowanceUsed(real, "studio", now), limit);
});

test("a paying store whose billing month is not known is let in to nothing", async () => {
  const unknown = await takeAllowance(paying(2, { period: null }), "api");
  assert.equal(unknown.ok, false);
  assert.ok(!unknown.ok && unknown.reason === "unknown" && /Open your studio/.test(unknown.message));
});

test("stores that pay nothing share the month's places, which grow with the stores that pay", async () => {
  assert.equal(freePoolSize(0), FREE_POOL_BASE_STORES);
  assert.equal(freePoolSize(PAID_STORES_PER_FREE_STORE * 3 + 1), FREE_POOL_BASE_STORES + 3);
  assert.equal(await admitNonPaying(paying(3)), true, "a store that pays needs no place");
  for (let i = 0; i < FREE_POOL_BASE_STORES; i += 1) assert.equal(await admitNonPaying(free(i)), true, `place ${i}`);
  assert.equal(await admitNonPaying(free(0)), true, "a place held is kept");
  assert.equal(await admitNonPaying(free(FREE_POOL_BASE_STORES)), false, "past the places");
  const pooled = await takeAllowance(free(FREE_POOL_BASE_STORES + 1), "studio");
  assert.ok(!pooled.ok && pooled.reason === "pool" && /full for this month/.test(pooled.message));
  // Paying stores open more places, and a store turned away asks again later.
  await redis.pipeline(Array.from({ length: PAID_STORES_PER_FREE_STORE }, (_, i) => ["SADD", PAYING_INDEX, `payer${i}`]));
  assert.deepEqual(await poolThisMonth(), { taken: FREE_POOL_BASE_STORES, size: FREE_POOL_BASE_STORES + 1 });
  assert.equal(await admitNonPaying(free(FREE_POOL_BASE_STORES + 2)), true);
  // Each has only its own small figures.
  assert.equal((await takeAllowance(free(0), "studio", NON_PAYING_ALLOWANCES.none.studio)).ok, true);
  assert.equal((await takeAllowance(free(0), "studio")).ok, false);
});

test("an email counted against a store's figure is not sent past it, and the provider is never asked", async () => {
  const store = paying(4);
  const limit = STORE_ALLOWANCES.creator.transactional;
  for (let i = 0; i < limit; i += 1) assert.equal(await sendEmail({ meter: { by: "store", store, kind: "transactional" }, from: "Shop <shop@example.com>", to: `b${i}@example.org`, subject: "Your link", text: "Here." }), true);
  assert.equal(await sendEmail({ meter: { by: "store", store, kind: "transactional" }, from: "Shop <shop@example.com>", to: "last@example.org", subject: "Your link", text: "Here." }), false);
  assert.equal(sends, limit);
  // The other meters are counted where they were taken, and go.
  assert.equal(await sendEmail({ meter: { by: "company" }, from: "Marktmorgen <hello@marktmorgen.com>", to: "creator@example.org", subject: "Sign in", text: "Here." }), true);
});

test("the studio counts a page as several requests, and never shuts the owner out of paying, leaving or taking their data", async () => {
  await claimHandle("studio@example.com", "studioshop", "Studio Shop", "");
  await setSubscription("studio@example.com", { customerId: "cus_Studio00001", subscriptionId: "sub_Studio00001", active: true, period: paidPeriod() });
  const store = (await storeForEmail("studio@example.com"))!;
  const limit = STORE_ALLOWANCES.creator.studio;
  assert.deepEqual(await countStudio(store, null, STUDIO_PAGE_UNITS), { ok: true });
  assert.equal(await allowanceUsed(store, "studio"), STUDIO_PAGE_UNITS);
  assert.equal((await takeAllowance(store, "studio", limit - STUDIO_PAGE_UNITS)).ok, true);
  const used = await countStudio(store, "products");
  assert.ok(!used.ok && /studio requests/.test(used.message));
  for (let i = 0; i < ESSENTIAL_PER_DAY; i += 1) for (const need of ["billing"] as const) assert.deepEqual(await countStudio(store, need), { ok: true });
  assert.equal((await countStudio(store, "export")).ok, false, "a small daily figure of its own, shared by the never-paused requests");
});

test("a store's public side rests at its requests as at its visits, and what buyers have goes on to the whole figure", async () => {
  await claimHandle("public@example.com", "publicshop", "Public Shop", "");
  await setSubscription("public@example.com", { customerId: "cus_Public00001", subscriptionId: "sub_Public00001", active: true, period: paidPeriod() });
  const store = (await storeForEmail("public@example.com"))!;
  const whole = requestLimitFor(store);
  assert.equal(whole, REQUESTS_PER_VISIT * VISITS_INCLUDED.creator + EXTRA_REQUESTS.creator);
  const folder = await storeFolder("public@example.com");
  const key = `nl:traffic:r:${folder}:${allowanceWindow(store)!.id}`;
  assert.equal(await isResting(store), false);
  await redis.pipeline([["SET", key, String(publicVisitLimit(whole) - 1)]]);
  assert.equal(await isResting(store), false, "the request that reaches 95% is answered");
  assert.equal(await isResting(store), true, "and the next one rests");
  assert.equal(await takePublicRequest(store, "public"), false);
  assert.equal(await takePublicRequest(store, "buyer"), true);
  await redis.pipeline([["SET", key, String(whole)]]);
  assert.equal(await takePublicRequest(store, "buyer"), false);
  assert.equal(await isResting(store, Date.now(), "buyer"), true);
});

test("a plan's figures are published from the same numbers", () => {
  assert.equal(allowanceListWords("creator"), `${STORE_ALLOWANCES.creator.studio.toLocaleString("en-US")} studio requests, ${STORE_ALLOWANCES.creator.api.toLocaleString("en-US")} API requests, ${STORE_ALLOWANCES.creator.inbox} inbox messages, ${STORE_ALLOWANCES.creator.email} store emails, ${STORE_ALLOWANCES.creator.transactional} access emails, ${STORE_ALLOWANCES.creator.integration} calls to connected services, ${STORE_ALLOWANCES.creator.buyer} buyer actions and ${STORE_ALLOWANCES.creator.webhook} webhook deliveries`);
  assert.doesNotMatch(allowanceListWords("scale"), /unlimited/i);
});

test("the billing month is written down with the plan, forgotten when it stops, and the stores that pay are kept in line", async () => {
  await claimHandle("period@example.com", "periodshop", "Period Shop", "");
  const period = paidPeriod();
  await setSubscription("period@example.com", { customerId: "cus_Period00001", subscriptionId: "sub_Period00001", active: true, period });
  assert.deepEqual((await storeForEmail("period@example.com"))!.period, period);
  const [paysNow] = await redis.pipeline([["SISMEMBER", PAYING_INDEX, "period@example.com"]]);
  assert.equal(Number(paysNow), 1);
  // A plan written again without a period keeps the one it has; a plan that stops forgets it.
  await setSubscription("period@example.com", { active: true, tier: "pro" });
  assert.deepEqual((await storeForEmail("period@example.com"))!.period, period);
  await setSubscription("period@example.com", { active: false });
  assert.equal((await storeForEmail("period@example.com"))!.period, null);
  const [after] = await redis.pipeline([["SISMEMBER", PAYING_INDEX, "period@example.com"]]);
  assert.equal(Number(after), 0);
  // A trial pays nothing yet.
  await setSubscription("period@example.com", { active: true, trialEnds: Math.floor(Date.now() / 1000) + 86_400 });
  const [trial] = await redis.pipeline([["SISMEMBER", PAYING_INDEX, "period@example.com"]]);
  assert.equal(Number(trial), 0);
});

test("the daily job writes a store down again when only its billing month moved", async () => {
  const { recordState } = await import("@/lib/billing-sync");
  await claimHandle("renew@example.com", "renewshop", "Renew Shop", "");
  const first = paidPeriod(Date.now() - 31 * 86_400_000);
  await setSubscription("renew@example.com", { customerId: "cus_Renew000001", subscriptionId: "sub_Renew000001", active: true, tier: "creator", cycle: "month", trialEnds: 0, shared: false, period: first });
  const store = (await storeForEmail("renew@example.com"))!;
  const next = { start: first.end, end: first.end + 30 * 86_400, renews: true };
  const state = { state: "active" as const, trialing: false, until: next.end, cancelsAtEnd: false, tier: "creator" as const, cycle: "month" as const, amountCents: 2200, shared: false, changePending: false, renewalUnpaid: false, period: next };
  assert.equal(await recordState(store, state), true);
  assert.deepEqual((await storeForEmail("renew@example.com"))!.period, next);
  assert.equal(await recordState((await storeForEmail("renew@example.com"))!, state), false, "and not again when nothing moved");
});

test("funded store-metered emails require paid proof before counters or provider dispatch",async()=>{
 const base=paying(50,{statsId:'a'.repeat(32)}),store={...base,period:{...base.period!,funded:true as const}};
 for(const kind of ['email','transactional'] as const){
  assert.equal(await sendEmail({meter:{by:'store',store,kind},from:'Shop <shop@example.com>',to:'reader@example.org',subject:'Synthetic only',text:'No dispatch without approval.'}),false);
  assert.equal(await allowanceUsed(store,kind),0);
 }
 assert.equal(sends,0);
});

test("funded owner platform calls refuse without approval while consent reduction and disconnect remain available",async()=>{
 const oldKey=process.env.NIMBUS_DATA_KEY;
 process.env.NIMBUS_DATA_KEY="synthetic-email-sync-data-key-only-000000";
 let resolved=0;
 setPlatformHooksForTests({resolve:async()=>{resolved+=1;throw new Error("No real platform lookup in this synthetic test");}});
 try{
  await claimHandle("funded-sync@example.com","funded-sync-shop","Funded Sync Shop","");
  await ensureStatsId("funded-sync@example.com");
  await setSubscription("funded-sync@example.com",{customerId:"cus_SyncFunded001",subscriptionId:"sub_SyncFunded001",active:true,period:{...paidPeriod(),funded:true}});
  const store=(await storeForEmail("funded-sync@example.com"))!;
  const key="synthetic_platform_key_000000";
  const config={handle:store.handle,provider:"kit",key:seal(key,`email-sync|${store.statsId}|kit`),last4:"0000",target:{id:"target-old",name:"Synthetic audience"},free:true,buyers:"all",products:[],tags:{},since:Date.now(),connectedAt:Date.now()};
  const configKey=`nl:esync:cfg:${store.statsId}`;
  await redis.pipeline([["SET",configKey,JSON.stringify(config)]]);
  const refused={ok:false,message:"The platform could not be contacted just now. Try again in a moment."};
  assert.deepEqual(await connect(store,"kit",key),refused);
  assert.deepEqual(await refreshTargets(store),refused);
  const tested=await testConnection(store);
  assert.equal(tested.ok,false);assert.equal(tested.message,refused.message);
  assert.equal(tested.view.connected?.target?.id,"target-old");
  assert.deepEqual(await saveSettings(store,{target:"target-new",free:true,buyers:"all",products:[],tags:{}}),refused);
  const [kept]=await redis.pipeline([["GET",configKey]]);
  assert.equal(kept,JSON.stringify(config));
  assert.equal(await allowanceUsed(store,"integration"),0);
  assert.equal(resolved,0,"no provider lookup or network request");
  const reduced=await saveSettings(store,{target:"target-old",free:false,buyers:"none",products:[],tags:{}});
  assert.equal(reduced.ok,true);
  assert.equal((await syncView(store)).connected?.free,false);
  assert.equal((await syncView(store)).connected?.buyers,"none");
  assert.equal((await disconnect(store)).connected,null);
  assert.equal(resolved,0);
 }finally{
  setPlatformHooksForTests(undefined);
  if(oldKey===undefined)delete process.env.NIMBUS_DATA_KEY;else process.env.NIMBUS_DATA_KEY=oldKey;
 }
});

test("marked paid webhook attempts need their cohort without blocking general maintenance allowances",async()=>{
 for(const tier of ["creator","pro","scale"] as const)for(const cycle of ["month","year"] as const){
  redis.clear();
  const base=paying(70,{tier,cycle,statsId:"b".repeat(32)});
  const marked={...base,period:{...paidPeriod(),funded:true as const}};
  for(const kind of ALLOWANCE_KINDS){
   const before=redis.keys();
   const result=await takeAllowance(marked,kind);
   if(kind==="webhook"){
    assert.equal(result.ok,false,tier+"/"+cycle+"/"+kind);
    assert.ok(!result.ok&&result.reason==="unknown");
    assert.deepEqual(redis.keys(),before,"unapproved outbound attempt creates no counter, pool or contract key");
   }else{
    assert.equal(result.ok,true,"general "+kind+" authorization must remain available; new obligations use their own operation guard");
   }
  }
  const legacy={...marked,period:paidPeriod()};
  assert.equal((await takeAllowance(legacy,"integration")).ok,true,"unmarked existing contracts keep their allowance");
 }
});
