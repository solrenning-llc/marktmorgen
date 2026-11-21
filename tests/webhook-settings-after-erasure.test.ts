/**
 * Synthetic regression for a settings writer finishing after the store's erasure.
 * Calls the real addEndpoint, forgetStoreWebhooks and closeStoreRecord; no endpoint is contacted.
 * The last case checks the watch-index tail after a save that won before the erasure.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as studioPost } from "@/app/api/store/webhooks/route";
import { ERASING_KEY, claimHandle, closeStoreRecord, ensureStatsId, erasingField, setSubscription, storeForEmail, storeRef, type Store } from "@/lib/store";
import { addEndpoint, forgetStoreWebhooks } from "@/lib/webhooks";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "synthetic-webhook-erasure-key-not-for-production";
globalThis.fetch = (async () => { throw new Error("No network in the webhook erasure regression"); }) as typeof fetch;

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let cfg = "";
let beforeWrite: (() => Promise<void>) | null = null;
let afterWrite: (() => Promise<void>) | null = null;
redis.pipeline = (async (commands: Command[]) => {
  // Config remains the first key in both the old CAS and the proposed fenced script.
  const writing = commands.length === 1 && commands[0][0] === "EVAL" && commands[0][3] === cfg;
  if (writing && beforeWrite) {
    const hook = beforeWrite; beforeWrite = null;
    await hook();
  }
  const replies = await real(commands);
  if (writing && afterWrite) {
    const hook = afterWrite; afterWrite = null;
    await hook();
  }
  return replies;
}) as typeof redis.pipeline;

const OWNER = "settings-erasure@example.com";
const STORES = "nl:hooks:stores";
async function setup(seed: boolean): Promise<Store> {
  redis.clear();
  await claimHandle(OWNER, "hook-erasure", "Hook Erasure", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_HookErase0001", subscriptionId: "sub_HookErase0001", active: true, period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  cfg = `nl:hooks:cfg:${store.statsId}`;
  if (seed) {
    const added = await addEndpoint(store, "https://hooks.example.com/original", ["sale.completed"], Date.now(), "", false);
    if (!added.ok) throw new Error("the live setup could not add an endpoint");
  }
  return store;
}
async function close(store: Store): Promise<void> {
  await forgetStoreWebhooks(store.statsId);
  is("the real final close finishes", await closeStoreRecord(store), true);
  is("the canonical record is absent", await storeForEmail(OWNER), null);
  is("the config was deleted", (await real([["GET", cfg]]))[0], null);
}
async function main(): Promise<void> {
  part("First and later adds cannot recreate settings after a completed erasure");
  for (const seed of [false, true]) {
    const store = await setup(seed);
    beforeWrite = () => close(store);
    const result = await addEndpoint(store, "https://hooks.example.com/private?owner=synthetic@example.com", ["sale.completed"], Date.now(), "", false);
    is("the stale add is refused", result.ok, false);
    is("no signing secret or URL was recreated", (await real([["GET", cfg]]))[0], null);
    is("the store was not re-added to the watch set", (await real([["SISMEMBER", STORES, store.statsId!]]))[0], 0);
  }

  part("A marked erasure refuses the write even before the live identity is deleted");
  {
    const store = await setup(true);
    beforeWrite = async () => {
      await real([["HSET", ERASING_KEY, await erasingField(storeRef(store)), "1"]]);
      await forgetStoreWebhooks(store.statsId);
    };
    const result = await addEndpoint(store, "https://hooks.example.com/erasing", ["sale.completed"], Date.now(), "", false);
    is("not added during erasure", result.ok, false);
    is("the erased config stays absent", (await real([["GET", cfg]]))[0], null);
    is("no watch member after erasure", (await real([["SISMEMBER", STORES, store.statsId!]]))[0], 0);
  }

  part("A legacy snapshot cannot write into the old stats after its owner creates another store");
  {
    const current = await setup(true);
    const legacy = { ...current, sid: "" };
    let replacementStats = "";
    beforeWrite = async () => {
      await close(legacy);
      is("the owner can claim a different handle", (await claimHandle(OWNER, "replacement-hooks", "Replacement Hooks", "")).ok, true);
      await ensureStatsId(OWNER);
      replacementStats = (await storeForEmail(OWNER))!.statsId!;
      is("the new store has another identity", replacementStats !== legacy.statsId, true);
    };
    const result = await addEndpoint(legacy, "https://hooks.example.com/old-legacy", ["sale.completed"], Date.now(), "", false);
    is("the old legacy writer is refused", result.ok, false);
    is("no old config", (await real([["GET", cfg]]))[0], null);
    is("no old watch member", (await real([["SISMEMBER", STORES, legacy.statsId!]]))[0], 0);
    is("the new store is untouched", (await real([["GET", `nl:hooks:cfg:${replacementStats}`]]))[0], null);
  }

  part("The studio route does not return a secret after a concurrent erasure");
  {
    const store = await setup(false);
    const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
    beforeWrite = () => close(store);
    const response = await studioPost(new NextRequest(`https://marktmorgen.com/api/store/webhooks?store=${store.sid}`, {
      method: "POST", headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", cookie, "content-type": "application/json" },
      body: JSON.stringify({ action: "add", url: "https://hooks.example.com/route", events: ["sale.completed"] }),
    }));
    const body = await response.json() as { ok?: boolean; error?: string; secret?: string };
    is("the existing unavailable response, no secret", [response.status, body.ok, body.error, "secret" in body], [503, false, "unavailable", false]);
    is("no config after the refused request", (await real([["GET", cfg]]))[0], null);
  }

  part("A write that wins before erasure has no unfenced SADD tail");
  {
    const store = await setup(false);
    afterWrite = () => close(store);
    await addEndpoint(store, "https://hooks.example.com/won-before-erasure", ["sale.completed"], Date.now(), "", false);
    is("the subsequent erasure wins over the whole mutation", (await real([["GET", cfg], ["SISMEMBER", STORES, store.statsId!]])), [null, 0]);
  }

  part("Live controls retain exact CAS behavior, same legacy identity and first-endpoint anchor reset");
  {
    const store = await setup(false);
    const stats = store.statsId!;
    await real([["SET", `nl:hooks:anchor:${stats}`, "old"], ["SET", `nl:hooks:anchor:${stats}:back`, "old"], ["SET", `nl:hooks:wait:${stats}`, "old"]]);
    const first = await addEndpoint({ ...store, sid: "" }, "https://hooks.example.com/healthy-legacy", ["sale.completed"], Date.now(), "", false);
    is("a live legacy snapshot given a sid since still works", first.ok, true);
    is("its setting is persistent as before and its watch member exists", (await real([["TTL", cfg], ["SISMEMBER", STORES, stats]])), [-1, 1]);
    is("only the first add resets its read anchors", (await real([["GET", `nl:hooks:anchor:${stats}`], ["GET", `nl:hooks:anchor:${stats}:back`], ["GET", `nl:hooks:wait:${stats}`]])), [null, null, null]);
  }

  redis.pipeline = real;
  done();
}
main().catch((error) => {
  redis.pipeline = real;
  console.error(error);
  process.exit(1);
});
