import assert from "node:assert/strict";
import { test } from "node:test";
import { GET } from "@/app/api/store/download/route";
import { fixture, blobReads } from "./single-digital-access-targeted-world";

test("a live token opens its exact paid reference older than72h and outside the recent40", async () => {
  const f = await fixture(); blobReads.length = 0;
  const response = await GET({ nextUrl: f.url, headers: new Headers() } as never);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "SYNTHETIC_PAID_FILE");
  assert.deepEqual(blobReads, [f.product.file!.pathname]);
  assert.equal(f.gets.filter(url => new URL(url).pathname.endsWith("/checkout/sessions")).length, 0, "no capped recent-purchase scan");
});

import { createCheckout } from "@/lib/store-checkout";
import { readConfirmationOrigin, runOrderConfirmationMail, confirmationOriginRowKey, forgetOrderConfirmationMail } from "@/lib/order-confirmation-outbox";
import { EU_WITHDRAWAL_CONSENT_VERSION } from "@/lib/digital-consent";
import { setCurrency, setProductFile, ensureListId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { suppressCommand } from "@/lib/suppression";
import { seal } from "@/lib/secret-box";
import { readSingleDigitalAccess } from "@/lib/single-digital-access";

async function originalCheckout() {
  const f = await fixture();
  f.runtime.policy = { ...f.runtime.policy!, singleDigitalAccessEvidence: "SYNTHETIC_ONLY same-review token24h storage after acceptance, renewal and paid delivery resource grant; not real coverage" };
  const checkout = await createCheckout(f.store, f.product, "https://example.test", undefined,
    { digitalConsent: { version: EU_WITHDRAWAL_CONSENT_VERSION, at: Math.floor(f.created/1000) } }, f.runtime);
  const session = f.sessions.get(checkout.id)!;
  Object.assign(session, { ...f.session, id: checkout.id, created: session.created, metadata: session.metadata });
  const key = [...redis.keys()].find(k => k.startsWith("nl:order-confirmation:row:"))!;
  return { ...f, checkout, original: session, id: key.slice("nl:order-confirmation:row:".length) };
}

test("real synthetic funded checkout -> restart96h -> accepted receipt -> exact file after source removal", async () => {
  const f = await originalCheckout();
  const before = await readConfirmationOrigin(f.id, f.runtime); assert.ok(before);
  assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
  await setCurrency(f.store.email, "eur");
  const update = { ...f.product.file!, pathname: f.product.file!.pathname.replace("original.pdf", "updated.pdf"), name: "Updated.pdf" };
  await setProductFile(f.store.email, f.product.id, update);
  f.advance(96*3_600_000);
  let text = "";
  const result = await runOrderConfirmationMail(f.runtime.now!()+30_000, async (message, beforePost) => {
    assert.ok(message.text.includes("Paid: $35")); assert.equal(message.text.includes("€"), false);
    assert.ok(message.text.includes("Original digital file"));
    assert.equal(await beforePost(), true); text = message.text; return "accepted";
  }, { ...f.runtime });
  assert.equal(result.accepted, 1);
  assert.equal(await readConfirmationOrigin(f.id, f.runtime), null);
  const url = new URL(text.split("\n").find(line => line.startsWith("Open what you bought: "))!.slice("Open what you bought: ".length));
  const response = await GET({ nextUrl: url, headers: new Headers() } as never);
  assert.equal(response.status, 200); assert.equal(await response.text(), "SYNTHETIC_PAID_FILE");
  assert.equal(blobReads.at(-1), update.pathname);
  assert.equal(f.gets.some(url => new URL(url).pathname.endsWith("/checkout/sessions")), false);
  assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
  assert.ok(Number(redis.run(["TTL", `nl:order-confirmation:source:${f.id}`])) > 399*86400);
});

test("expired token, altered capsule, different buyer, refunds/disputes and unknown proof deny before file reads", async () => {
  const f = await fixture(), origin = f.url.searchParams.get("origin")!;
  const initially = blobReads.length;
  assert.equal(await readSingleDigitalAccess(f.store, "0".repeat(64), origin), null);
  assert.equal(await readSingleDigitalAccess(f.store, f.token, origin+"x"), null);
  assert.equal(await readSingleDigitalAccess(f.store, f.token, seal("{}", "single-digital-access|v1")), null);
  for (const change of [() => { f.session.customer_details.email = "somebodyelse@example.test"; },
    () => { f.session.payment_intent.latest_charge.refunded = true; },
    () => { f.session.payment_intent.latest_charge.disputed = true; },
    () => { delete (f.session.payment_intent.latest_charge as { disputed?: boolean }).disputed; }]) {
    change(); assert.equal(await readSingleDigitalAccess(f.store, f.token, origin), null);
    f.session.customer_details.email = f.email; f.session.payment_intent.latest_charge.refunded = false; f.session.payment_intent.latest_charge.disputed = false;
  }
  await ensureListId(f.store.email);
  const current = (await storeForEmail(f.store.email))!;
  await redis.pipeline([suppressCommand(current.listId!, f.email)]);
  assert.equal(await readSingleDigitalAccess(current, f.token, origin), null);
  assert.equal(blobReads.length, initially);
});

test("unknown receipt ACK keeps its permanent barrier and paid source across another restart", async () => {
  const f = await originalCheckout(); f.advance(25*3_600_000); let posts = 0;
  const send = async (_message: unknown, barrier: () => Promise<boolean>) => { if (await barrier()) posts++; return "unknown" as const; };
  await runOrderConfirmationMail(f.runtime.now!()+30_000, send, f.runtime);
  f.advance(96*3_600_000);
  await runOrderConfirmationMail(f.runtime.now!()+30_000, send, { ...f.runtime });
  assert.equal(posts, 1); assert.equal((await readConfirmationOrigin(f.id, f.runtime))?.row.state, "dispatching");
  assert.equal(redis.run(["TTL", confirmationOriginRowKey(f.id)]), -1);
  assert.equal(await forgetOrderConfirmationMail(f.store.statsId, undefined, f.runtime), 1);
});

import { ordersLinkFor } from "@/lib/buyer-orders";

test("token expiration denies access; a fresh same-inbox grant renews exact access without the recent40", async () => {
  const f = await fixture(), origin = f.url.searchParams.get("origin")!;
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow()+25*3_600_000;
    assert.equal(await readSingleDigitalAccess(f.store, f.token, origin), null);
  } finally { Date.now = originalNow; }
  const fresh = await ordersLinkFor(f.store, f.email, "https://example.test/@"+f.store.handle); assert.ok(fresh);
  const renewed = new URL(fresh).searchParams.get("token")!;
  assert.ok(await readSingleDigitalAccess(f.store, renewed, origin));
});

test("lost create ACK reconciles the original paid session after96h without a payment replay", async () => {
  const f = await fixture();
  f.runtime.policy = { ...f.runtime.policy!, singleDigitalAccessEvidence: "SYNTHETIC_ONLY full token/access cost review" };
  const provider = f.runtime.provider!; let lost = false, readable = false;
  f.runtime.provider = async (...args) => {
    if (args[0] === "GET" && !readable) throw Error("Synthetic initial read outage");
    const result = await provider(...args);
    if (args[0] === "POST" && !lost) { lost = true; throw Error("Synthetic existing payment; create ACK lost"); }
    return result;
  };
  await assert.rejects(createCheckout(f.store, f.product, "https://example.test", undefined,
    { digitalConsent: { version: EU_WITHDRAWAL_CONSENT_VERSION, at: Math.floor(f.created/1000) } }, f.runtime));
  const original = [...f.sessions.values()][0]; assert.ok(original);
  Object.assign(original, { ...f.session, id: original.id, created: original.created, metadata: original.metadata });
  readable = true; f.advance(96*3_600_000);
  let posts = 0;
  const send = async (_message: unknown, barrier: () => Promise<boolean>) => { assert.equal(await barrier(), true); posts++; return "accepted" as const; };
  await runOrderConfirmationMail(f.runtime.now!()+30_000, send, f.runtime);
  f.advance(97*3_600_000);
  await runOrderConfirmationMail(f.runtime.now!()+30_000, send, { ...f.runtime });
  assert.equal(posts, 1); assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
  assert.ok(f.calls.some(c => c.method === "GET" && c.path.startsWith("/checkout/sessions?")));
});

test("unreviewed access and expired original financial horizon cannot spend or silently drop pending", async () => {
  const f = await originalCheckout();
  f.runtime.policy = { ...f.runtime.policy!, singleDigitalAccessEvidence: undefined };
  f.advance(25*3_600_000); let sent = 0;
  await runOrderConfirmationMail(f.runtime.now!()+30_000, async () => { sent++; return "accepted"; }, f.runtime);
  assert.equal(sent, 0); assert.ok(await readConfirmationOrigin(f.id, f.runtime));
  f.runtime.policy.singleDigitalAccessEvidence = "SYNTHETIC_ONLY";
  f.advance(450*86400000);
  await runOrderConfirmationMail(f.runtime.now!()+30_000, async () => { sent++; return "accepted"; }, f.runtime);
  assert.equal(sent, 0); assert.equal(redis.run(["TTL", confirmationOriginRowKey(f.id)]), -1);
});

test("erasure installed during the paid lookup and unknown suppression replies both deny access", async () => {
  const f = await fixture(), origin = f.url.searchParams.get("origin")!, network = globalThis.fetch;
  let erased = false;
  globalThis.fetch = async (...args) => {
    const response = await network(...args);
    if (!erased) {
      erased = true; await ensureListId(f.store.email);
      const current = (await storeForEmail(f.store.email))!;
      await redis.pipeline([suppressCommand(current.listId!, f.email)]);
    }
    return response;
  };
  assert.equal(await readSingleDigitalAccess(f.store, f.token, origin), null);
  const realPipeline = redis.pipeline.bind(redis);
  try {
    redis.pipeline = async commands => commands.some(c => c[0] === "HEXISTS") ? [null] : realPipeline(commands);
    const current = (await storeForEmail(f.store.email))!;
    assert.equal(await readSingleDigitalAccess(current, f.token, origin), null);
  } finally { redis.pipeline = realPipeline; }
});
