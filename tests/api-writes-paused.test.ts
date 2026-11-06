/**
 * 232 [CA1] unit 4c: while a store's plan renewal is unpaid, or a payment for
 * its plan is disputed, adding or changing anything through one of its API
 * keys (a lead, a lead's labels, a product given with no payment) is refused
 * with its sentence before any of the month's API requests is taken or the
 * body is read; taking back access and removing a webhook endpoint stay open,
 * and the writes work again once paid (lib/api-guard.ts).
 */
import { POST as leadAdd } from "@/app/api/v1/leads/route";
import { POST as labelsChange } from "@/app/api/v1/leads/labels/route";
import { POST as accessGive, DELETE as accessTake } from "@/app/api/v1/access/route";
import { POST as hookAdd } from "@/app/api/v1/hooks/route";
import { makeKey } from "@/lib/api-keys";
import { allowanceUsed } from "@/lib/store-allowance";
import { claimHandle, ensureStatsId, recordPlanDispute, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { API_READ_PAUSED_WORDS, API_WRITE_PAUSED_WORDS, integrationPauseWord } from "@/lib/integration-pause";
import { RENEWAL_PAUSED_WORDS } from "@/lib/renewal-unpaid-words";
import { DISPUTE_PAUSED_WORDS } from "@/lib/plan-dispute-rules";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "api-writes-paused@example.com";

type Answer = { status: number; body: { data?: unknown; error?: string; message?: string } };

async function main(): Promise<void> {
  redis.clear();
  const previousFetch = globalThis.fetch;
  let outside = 0;
  globalThis.fetch = (async () => { outside += 1; throw new Error("No outside requests in this test"); }) as typeof fetch;
  try {
    await claimHandle(OWNER, "api-writes-paused-shop", "API Writes Paused Shop", "");
    await ensureStatsId(OWNER);
    await setSubscription(OWNER, { customerId: "cus_ApiWritesPause", subscriptionId: "sub_ApiWritesPause", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
    let store = (await storeForEmail(OWNER))!;
    const writer = await makeKey(store.sid, "Synthetic writer", Date.now(), true);
    const reader = await makeKey(store.sid, "Synthetic reader");
    if (!writer.ok || !reader.ok) throw new Error("No synthetic keys");
    const send = async (handler: (r: Request) => Promise<Response>, path: string, body: unknown, key = writer.key, method = "POST"): Promise<Answer> => {
      const res = await handler(new Request(`https://marktmorgen.com${path}`, { method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }));
      return { status: res.status, body: (await res.json()) as Answer["body"] };
    };
    const used = async () => allowanceUsed((await storeForEmail(OWNER))!, "api");

    part("Paid: writes work and are counted");
    is("a lead is added", (await send(leadAdd, "/api/v1/leads", { email: "first@example.com", agreed: true })).status, 200);
    is("its labels are changed", (await send(labelsChange, "/api/v1/leads/labels", { email: "first@example.com", add: ["vip"] })).status, 200);
    const given = await send(accessGive, "/api/v1/access", { email: "buyer@example.com", product: "none-such", notify: false });
    is("giving a product reaches the product check", given.body.error === "paused_unpaid" || given.body.error === "paused_disputed", false);
    const paidCount = await used();
    is("they were counted", paidCount >= 3, true);

    part("Renewal unpaid: every adding write refused with the sentence, nothing counted");
    await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: true });
    store = (await storeForEmail(OWNER))!;
    is("paused", integrationPauseWord(store), "paused_unpaid");
    const lead = await send(leadAdd, "/api/v1/leads", { email: "second@example.com", agreed: true });
    is("adding a lead is refused with its sentence", [lead.status, lead.body.error, lead.body.message], [409, "paused_unpaid", API_WRITE_PAUSED_WORDS.paused_unpaid]);
    is("no data is sent back", lead.body.data, undefined);
    const labels = await send(labelsChange, "/api/v1/leads/labels", { email: "first@example.com", add: ["late"] });
    is("adding labels is refused", [labels.status, labels.body.error], [409, "paused_unpaid"]);
    const mixed = await send(labelsChange, "/api/v1/leads/labels", { email: "first@example.com", add: ["late"], remove: ["vip"] });
    is("adding and removing in one request is refused", [mixed.status, mixed.body.error], [409, "paused_unpaid"]);
    const odd = await send(labelsChange, "/api/v1/leads/labels", { email: "first@example.com", add: "late" });
    is("an add that cannot be read is refused as an add", [odd.status, odd.body.error], [409, "paused_unpaid"]);
    const access = await send(accessGive, "/api/v1/access", { email: "buyer@example.com", product: "none-such", notify: false });
    is("giving a product is refused", [access.status, access.body.error], [409, "paused_unpaid"]);
    const hook = await send(hookAdd, "/api/v1/hooks", { url: "https://hooks.example.com/paused", events: ["sale.completed"] });
    is("adding a webhook endpoint is refused the same way, before it counts", [hook.status, hook.body.error, hook.body.message], [409, "paused_unpaid", API_WRITE_PAUSED_WORDS.paused_unpaid]);
    const malformed = await leadAdd(new Request("https://marktmorgen.com/api/v1/leads", { method: "POST", headers: { Authorization: `Bearer ${writer.key}`, "Content-Type": "application/json" }, body: "not json" }));
    is("refused before the body is read", malformed.status, 409);
    is("nothing was counted for the refused writes", await used(), paidCount);
    const readOnly = await send(leadAdd, "/api/v1/leads", { email: "third@example.com", agreed: true }, reader.key);
    is("a read-only key still hears it reads only", [readOnly.status, readOnly.body.error], [403, "read_only"]);
    const missing = await leadAdd(new Request("https://marktmorgen.com/api/v1/leads", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
    is("a missing key is still 401, not the pause", missing.status, 401);

    part("Taking something away stays open");
    const removedLabel = await send(labelsChange, "/api/v1/leads/labels", { email: "first@example.com", remove: ["vip"] });
    is("removing a label works while paused", [removedLabel.status, (removedLabel.body.data as { labels?: string[] } | undefined)?.labels], [200, []]);
    const taken = await send(accessTake, "/api/v1/access", { email: "buyer@example.com", product: "none-such" }, writer.key, "DELETE");
    is("taking back access is not refused by the pause", taken.body.error === "paused_unpaid", false);

    part("The sentences say it");
    is("the write sentence names leads, labels, products and webhook endpoints and keeps the removals open", [/leads/.test(API_WRITE_PAUSED_WORDS.paused_unpaid), /labels/.test(API_WRITE_PAUSED_WORDS.paused_unpaid), /products/.test(API_WRITE_PAUSED_WORDS.paused_unpaid) && /adding webhook endpoints/.test(API_WRITE_PAUSED_WORDS.paused_unpaid), Object.values(API_WRITE_PAUSED_WORDS).every((w) => w.endsWith("Removing labels, taking back access and removing webhook endpoints through the API are not paused."))], [true, true, true, true]);
    is("the read sentence names the same removals", Object.values(API_READ_PAUSED_WORDS).every((w) => w.endsWith("Removing labels, taking back access and removing webhook endpoints through the API are not paused.")), true);
    is("the renewal and dispute notices say adding through API keys waits, and which removals do not", [RENEWAL_PAUSED_WORDS, DISPUTE_PAUSED_WORDS].every((w) => w.endsWith("and so does adding to it through them; removing labels, taking back access and removing webhook endpoints do not.")), true);

    part("Disputed: the dispute's sentence");
    await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: false });
    store = (await storeForEmail(OWNER))!;
    const now = Math.floor(Date.now() / 1000);
    is("the dispute is written down", Boolean(await recordPlanDispute(storeRef(store), { id: "du_ApiWritesPause1", status: "open", at: now, coversUntil: now + 30 * 86_400 })), true);
    const disputed = await send(leadAdd, "/api/v1/leads", { email: "second@example.com", agreed: true });
    is("refused for the dispute", [disputed.status, disputed.body.error, disputed.body.message], [409, "paused_disputed", API_WRITE_PAUSED_WORDS.paused_disputed]);

    part("Settled: writes work again");
    store = (await storeForEmail(OWNER))!;
    is("the dispute won", Boolean(await recordPlanDispute(storeRef(store), { id: "du_ApiWritesPause1", status: "won", at: now, coversUntil: now + 30 * 86_400 })), true);
    const before = await used();
    is("adding a lead works again", (await send(leadAdd, "/api/v1/leads", { email: "second@example.com", agreed: true })).status, 200);
    is("and is counted", (await used()) > before, true);

    part("A dispute decided for the store keeps adding paused for the period it covered");
    store = (await storeForEmail(OWNER))!;
    is("a second dispute is written down", Boolean(await recordPlanDispute(storeRef(store), { id: "du_ApiWritesPause2", status: "open", at: now, coversUntil: now + 30 * 86_400 })), true);
    store = (await storeForEmail(OWNER))!;
    is("and is lost", Boolean(await recordPlanDispute(storeRef(store), { id: "du_ApiWritesPause2", status: "lost", at: now, coversUntil: now + 30 * 86_400 })), true);
    const lost = await send(leadAdd, "/api/v1/leads", { email: "fourth@example.com", agreed: true });
    is("adding a lead still answers 409 with the dispute's sentence", [lost.status, lost.body.error, /until the period that payment covered ends/.test(lost.body.message ?? "")], [409, "paused_disputed", true]);
    is("nothing outside was reached", outside, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
