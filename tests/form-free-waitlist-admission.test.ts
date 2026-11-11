/**
 * A store's public form page (/@handle/form/<id>), and the pages a visitor lands on after signing up for a free product
 * (/@handle/free) or a wait list (/@handle/waitlist), read the store's records (the form, the products, its funnel) for
 * anybody who asks. Each is one of the store's counted public requests and rests once the window is used
 * (lib/traffic.ts, isResting), as the store page does (MR, rule 30). What a person already has through their own
 * emailed link (a free product's download, their own wait-list spot) rests only at the whole month, as a buyer's
 * course does ("buyer").
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import FormPage from "@/app/[handle]/form/[form]/page";
import FreePage from "@/app/[handle]/free/page";
import WaitlistPage from "@/app/[handle]/waitlist/page";
import { StoreResting } from "@/components/store-resting";
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { writeForm } from "@/lib/form-store";
import { parseForm } from "@/lib/forms";
import { publicVisitLimit, requestLimitFor } from "@/lib/traffic-rules";
import { takePublicRequest } from "@/lib/traffic";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = async () => { throw new Error("No external service in this test"); };
const owner = "form-free-admission@example.test", handle = "formfreeadmit";
let product = "";

async function fixture() {
  redis.clear();
  assert.equal((await claimHandle(owner, handle, "Synthetic forms shop", "")).ok, true);
  await ensureStatsId(owner);
  assert.ok(await setSubscription(owner, { customerId: "cus_FormFreeAdmit", subscriptionId: "sub_FormFreeAdmit", active: true, tier: "creator", period: paidPeriod() }));
  const made = await addProduct(owner, "Synthetic free guide", "", "0", null);
  assert.ok(made.ok);
  product = made.product.id;
  const store = (await storeForEmail(owner))!;
  assert.ok(await writeForm(store.statsId!, parseForm({ id: "quizform01", name: "Synthetic quiz", fields: [{ id: "q1mail", type: "email", label: "Email", required: true }] })!));
  return store;
}

const p = (handleParams: Record<string, string>, query: Record<string, string>) => ({ params: Promise.resolve({ handle: "@" + handle, ...handleParams }), searchParams: Promise.resolve(query) });
const pages: Record<string, () => Promise<unknown>> = {
  "form page": () => FormPage(p({ form: "quizform01" }, {}) as never),
  "free product signed up": () => FreePage(p({}, { status: "sent", product }) as never),
  "wait list joined": () => WaitlistPage(p({}, { status: "sent", product }) as never),
};

async function render(page: () => Promise<unknown>) {
  const original = redis.pipeline.bind(redis);
  const commands: (string | number)[][] = [];
  redis.pipeline = async (batch) => { commands.push(...batch); return original(batch); };
  let tree: unknown;
  try { tree = await page(); } finally { redis.pipeline = original; }
  return { tree: tree as { type?: unknown } | null, counted: commands.some((c) => c[0] === "INCRBY" && String(c[1]).startsWith("nl:traffic:r:")) };
}

for (const [name, page] of Object.entries(pages)) {
  test(`${name}: an open store's page is counted as one of its public requests`, async () => {
    await fixture();
    const seen = await render(page);
    assert.ok(seen.tree && seen.tree.type !== StoreResting, "the page is drawn");
    assert.equal(seen.counted, true, "the page counts one of the store's public requests");
  });
  test(`${name}: a store whose public requests are used rests`, async () => {
    const store = await fixture();
    assert.equal(await takePublicRequest(store, "buyer", undefined, publicVisitLimit(requestLimitFor(store))), true);
    const seen = await render(page);
    assert.equal(seen.tree?.type, StoreResting, "the page rests, as the store page does");
  });
}
