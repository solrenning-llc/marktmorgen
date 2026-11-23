/**
 * Issue #4165 (Codex X4, MEDIUM): the studio's product form sends every field it shows, so a second tab opened on
 * the same product before the first one saved wrote its stale copy of every field it did not touch over what the
 * first tab had saved (app/api/store/product/route.ts -> lib/store.ts editProduct). The form now also sends what it
 * opened with (`base`, the same shape as the fields); a field this tab left as it opened it keeps what is saved now,
 * and only what this tab changed is written. A save without `base` (an older screen) writes what it sends, as before.
 * Synthetic only.
 */
import { NextRequest } from "next/server";
import { POST as saveProduct } from "@/app/api/store/product/route";
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { readAbout } from "@/lib/product-about";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const OWNER = "tabs@example.com";

type Fields = { title: string; summary: string; price: string; pwyw: string | null; about: string; every?: "" | "month" };
/** The studio's payloadOf (components/product-editor.tsx): a one-time product, or a monthly one with `every`. */
const payload = (f: Fields) => ({ title: f.title, summary: f.summary, price: f.price, every: f.every ?? "", everyCount: 1, trial: "", payments: "", intro: null, yearly: null, pwyw: f.pwyw, about: f.about });

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.STRIPE_SECRET_KEY = "sk_test_product_edit_stale_tab";
  await claimHandle(OWNER, "tabs", "Two Tabs", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestTabs0001", true);
  await setSubscription(OWNER, { customerId: "cus_tabs00001", subscriptionId: "sub_tabs00001", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Watercolor basics", "Six short lessons.", "45", null);
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;
  const store = (await storeForEmail(OWNER))!;
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const save = async (body: Record<string, unknown>) => {
    const response = await saveProduct(new NextRequest("https://marktmorgen.com/api/store/product", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": store.sid, cookie }, body: JSON.stringify({ action: "edit", id, ...body }) }));
    return (await response.json()) as { ok: boolean; error?: string };
  };
  const now = async () => {
    const fresh = (await storeForEmail(OWNER))!;
    const product = (await readProduct(fresh, id))!;
    return { title: product.title, summary: product.summary, priceCents: product.priceCents, pwyw: product.pwyw?.suggestedCents ?? null, about: product.about ? await readAbout(fresh.statsId!, id) : "" };
  };

  // Both tabs opened the product as it was first saved.
  const opened: Fields = { title: "Watercolor basics", summary: "Six short lessons.", price: "45.00", pwyw: null, about: "" };

  part("Tab A changes the title and the description and saves");
  const a = await save({ ...payload({ ...opened, title: "Watercolor for beginners", about: "Paints, paper and six lessons." }), base: payload(opened) });
  is("saved", a.ok, true);

  part("Tab B, opened before A saved, changes only the summary and the price, and saves");
  const b = await save({ ...payload({ ...opened, summary: "Six lessons, ten minutes each.", price: "49" }), base: payload(opened) });
  is("saved", b.ok, true);
  const after = await now();
  is("B's summary and price are written", [after.summary, after.priceCents], ["Six lessons, ten minutes each.", 4900]);
  is("A's title is kept: B never touched it", after.title, "Watercolor for beginners");
  is("A's description is kept: B never touched it", after.about, "Paints, paper and six lessons.");

  part("Tab C, opened after B saved, gives the buyer a choice of price; tab D, opened before, changes only the title");
  const openedC: Fields = { title: "Watercolor for beginners", summary: "Six lessons, ten minutes each.", price: "49.00", pwyw: null, about: "Paints, paper and six lessons." };
  is("C saved", (await save({ ...payload({ ...openedC, pwyw: "60" }), base: payload(openedC) })).ok, true);
  is("D saved", (await save({ ...payload({ ...openedC, title: "Watercolor, step by step" }), base: payload(openedC) })).ok, true);
  const later = await now();
  is("D's title is written", later.title, "Watercolor, step by step");
  is("C's suggested price is kept: D never touched it", later.pwyw, 6000);

  part("A field this tab did change is written, even over a newer value (the creator typed it here)");
  const openedE: Fields = { ...openedC, title: "Watercolor, step by step", pwyw: "60.00" };
  is("saved", (await save({ ...payload({ ...openedE, summary: "Twelve lessons." }), base: payload({ ...openedE, summary: "Something else it opened with" }) })).ok, true);
  is("its summary is written", (await now()).summary, "Twelve lessons.");

  part("A save without base (an older screen) writes what it sends, as before");
  is("saved", (await save(payload({ ...openedE, title: "Old screen title", pwyw: null }))).ok, true);
  const old = await now();
  is("every field it sent is written", [old.title, old.pwyw], ["Old screen title", null]);

  part("A free product is never left charged again and again by two tabs (Claude 5 icRk's MEDIUM on #5468)");
  const openedF: Fields = { ...openedE, title: "Old screen title", summary: "Twelve lessons.", pwyw: null };
  is("tab F makes it monthly", (await save({ ...payload({ ...openedF, every: "month" }), base: payload(openedF) })).ok, true);
  const g = await save({ ...payload({ ...openedF, price: "0" }), base: payload(openedF) });
  is("tab G, opened before, makes it free leaving billing as it opened it: refused as free", [g.ok, g.error], [false, "free"]);
  const monthly = (await readProduct((await storeForEmail(OWNER))!, id))!;
  is("the product is still paid and monthly", [monthly.priceCents > 0, monthly.recurring?.interval], [true, "month"]);
  const openedH: Fields = { ...openedF, price: (monthly.priceCents / 100).toFixed(2), every: "month" };
  is("tab H takes it back to one-time", (await save({ ...payload({ ...openedH, every: "" }), base: payload(openedH) })).ok, true);
  is("tab I makes it free", (await save({ ...payload({ ...openedF, price: "0" }), base: payload(openedF) })).ok, true);
  const j = await save({ ...payload({ ...openedF, every: "month" }), base: payload(openedF) });
  is("tab J, opened before, makes it monthly leaving the price as it opened it: refused as free", [j.ok, j.error], [false, "free"]);
  const free = (await readProduct((await storeForEmail(OWNER))!, id))!;
  is("the product is still free and one-time", [free.priceCents, free.recurring], [0, null]);

  done();
}

void main();
