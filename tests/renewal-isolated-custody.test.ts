import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  confirmationBodyDigest, confirmationOriginId, confirmationOriginRowKey,
  enqueueSingleDigitalRenewal, forgetOrderConfirmationMail, readConfirmationOrigin,
  readCourseConfirmationOrigin, readSingleDigitalRenewalOrigin, reserveCourseConfirmationOrigin,
  runOrderConfirmationMail, type ConfirmationOriginRuntime,
} from "@/lib/order-confirmation-outbox";
import { enqueueShipmentMail, runShipmentMail, SHIPMENT_MAIL_SCRIPT } from "@/lib/shipment-mail-outbox";
import { paidDownloadRenewalPost } from "@/app/api/store/download/route";
import { EU_WITHDRAWAL_CONSENT_VERSION } from "@/lib/digital-consent";
import { createCheckout } from "@/lib/store-checkout";
import { addProduct, setProductShipping, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { seal } from "@/lib/secret-box";
import { prepareCourseOriginBinding } from "@/lib/course-origin-binding";
import { admitOrders } from "@/lib/order-admission";
import { courseCandidateWorld } from "./order-confirmation-course-world";
import { confirmationLocalPipeline } from "./order-confirmation-paid-fixture";
import { renewalFixture, request, tokenKeys } from "./single-digital-access-renewal-world";
import { metadataHash } from "./single-digital-access-targeted-world";

const native = process.env.MARKTMORGEN_REDIS_INTEGRATION === "1" && Boolean(process.env.CONFIRMATION_ORIGIN_REDIS_PORT);
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const nonce = (n: number) => String(n).padStart(64, "0");

async function world(real: boolean) {
  const f = await renewalFixture(), owned = new Set<string>();
  const runtime: ConfirmationOriginRuntime = { ...f.runtime, ...(real ? { now: Date.now } : {}),
    policy: { ...f.runtime.policy!, coveredOrigins: ["single-digital-confirmation", "single-digital-access-renewal", "course-confirmation"] },
    pipeline: async commands => {
      for (const c of commands) if (c[0] === "EVAL") c.slice(3, 3 + Number(c[2])).forEach(k => owned.add(String(k)));
      return real ? confirmationLocalPipeline(commands) : f.runtime.pipeline!(commands);
    },
  };
  let paymentPosts = 0;
  runtime.provider = async (method, account, path, body) => {
    assert.equal(account, f.store.stripeAccountId);
    if (method === "POST") {
      const id = confirmationOriginId(f.store.statsId!, body!.get("metadata[mm_order_intent]")!);
      assert.equal((await readConfirmationOrigin(id, runtime))?.row.phase, "creating");
      const sessionId = `cs_test_CustodyOpen${++paymentPosts}00000001`;
      const session = { object: "checkout.session", id: sessionId, mode: "payment", status: "open", currency: "usd",
        created: Math.floor(runtime.now!() / 1000), url: `https://checkout.stripe.com/c/pay/${sessionId}`,
        metadata: Object.fromEntries([...body!].filter(([k]) => k.startsWith("metadata[")).map(([k,v]) => [k.slice(9,-1),v])),
        line_items: { object: "list", has_more: false, data: [{ quantity: 1, price: { unit_amount: 3500, currency: "usd" } }] } };
      f.sessions.set(sessionId, session); return session;
    }
    if (path.split("?")[0] === "/checkout/sessions") return { object: "list", has_more: false, data: [...f.sessions.values()] };
    return f.sessions.get(path.split("?")[0].split("/").at(-1)!) ?? {};
  };
  const run = (commands: (string | number)[][]) => runtime.pipeline!(commands);
  const original = f.url.searchParams.get("origin")!;
  function buyer(number: number) {
    const sessionId = `cs_test_CustodyBuyer${number}00000001`, email = `buyer${number}@example.test`;
    const metadata = { ...f.session.metadata, mm_order_intent: nonce(100 + number), mm_order_hash: digest(`paid-metadata-${number}`) };
    const session = { ...structuredClone(f.session), id: sessionId, metadata, customer_details: { email } };
    f.sessions.set(sessionId, session);
    const capsule = { ...f.capsule, sessionId, email, metadataHash: metadataHash(metadata) };
    return { capsule: seal(JSON.stringify(capsule), "single-digital-access|v1"), session, email };
  }
  const pendingKey = `nl:order-confirmation:renewal:store:${f.store.statsId}`;
  const pointer = (capsule: string) => `nl:order-confirmation:renewal:capsule:${f.store.statsId}:${digest(capsule)}`;
  const post = (capsule: string, number: number) => paidDownloadRenewalPost(request(f.url, new URLSearchParams({
    handle: f.store.handle, origin: capsule, request: nonce(number),
  })), runtime);
  // A separate catalog product in the same store, rather than changing the
  // digital product whose original paid capsule is used above.
  const added = await addProduct(f.store.email, "Printed custody regression", "A separate physical product", "35", null);
  assert.ok(added.ok);
  await setProductShipping(f.store.email, added.product.id, { cents: 500, region: "us", countries: ["US"], note: "Original shipping" });
  f.store = (await storeForEmail(f.store.email))!;
  const physical = await readProduct(f.store, added.product.id); assert.ok(physical); assert.equal(physical.file, null);
  return { f, runtime, run, original, buyer, pointer, pendingKey, post, physical, paymentPosts: () => paymentPosts,
    cleanup: async () => { if (real && owned.size) await confirmationLocalPipeline([["DEL", ...owned]]); } };
}
type World = Awaited<ReturnType<typeof world>>;

async function reserveCourse(w: World) {
  const { product: courseProduct } = courseCandidateWorld(), now = w.runtime.now!(), store = w.f.store;
  const admission = await admitOrders(store, 1, now, 1); assert.ok(admission.ok);
  const metadata = { store: store.handle, product: courseProduct.id, dc: `yes:${EU_WITHDRAWAL_CONSENT_VERSION}:d:${Math.floor(now/1000)}`, mm_admit: String(admission.hour) };
  const form = new URLSearchParams({ mode: "payment", "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": store.currency, "line_items[0][price_data][unit_amount]": String(courseProduct.priceCents),
    "line_items[0][price_data][product_data][name]": courseProduct.title,
    ...Object.fromEntries(Object.entries(metadata).map(([k,v]) => [`metadata[${k}]`, v])),
    "metadata[mm_order_intent]": nonce(500), "metadata[mm_order_origin]": "course-v1" });
  form.set("metadata[mm_order_hash]", confirmationBodyDigest(form.toString()));
  const binding = await prepareCourseOriginBinding({ store, product: courseProduct, metadata, body: form.toString(), nonce: nonce(500), admission });
  assert.ok(binding);
  const result = await reserveCourseConfirmationOrigin({ bindingToken: binding.token, nonce: nonce(500) }, w.runtime);
  assert.ok(result.ok); assert.equal((await readCourseConfirmationOrigin(result.id, w.runtime))?.row.phase, "course_reserved");
  return result.id;
}

for (const real of [false, true]) {
  const label = real ? "native Redis" : "fixture";
  const options = { skip: real && !native };
  test(`CX59 ${label}: eight known refusals release capacity but keep their source receipts`, options, async()=>{
    const w=await world(real);
    try {
      for(let i=0;i<8;i++){
        const buyer=w.buyer(40+i);const result=await enqueueSingleDigitalRenewal(w.f.store,buyer.capsule,nonce(800+i),w.runtime);assert.ok(result.ok);
        const source=`nl:order-confirmation:source:${result.id}`;const [originalSource]=await w.run([["GET",source]]);
        await runOrderConfirmationMail(w.runtime.now!()+30000,async(_m,barrier)=>{assert.equal(await barrier(),true);return "refused";},w.runtime);
        assert.deepEqual(await w.run([["GET",w.pointer(buyer.capsule)],["SCARD",w.pendingKey]]),[null,0],"confirmed non-delivery cannot consume a lifetime pending slot");
        assert.equal((await w.run([["GET",source]]))[0],originalSource,"terminal source evidence is retained");
        assert.ok(Number((await w.run([["TTL",source]]))[0])>399*86400);
      }
      assert.equal((await w.post(w.buyer(49).capsule,810)).status,200);
    }finally{await w.cleanup();}
  });
  test(`CX59 ${label}: an unknown dispatch is never described as saved and scheduled again`, options, async()=>{
    const w=await world(real);
    try{
      const result=await enqueueSingleDigitalRenewal(w.f.store,w.original,nonce(820),w.runtime);assert.ok(result.ok);let sends=0;
      await runOrderConfirmationMail(w.runtime.now!()+30000,async(_m,barrier)=>{assert.equal(await barrier(),true);sends++;return "unknown";},w.runtime);
      const response=await w.post(w.original,821);assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/Your request is saved|will be emailed/);
      assert.equal((await readSingleDigitalRenewalOrigin(result.id,w.runtime))?.row.state,"dispatching");assert.equal(sends,1);
    }finally{await w.cleanup();}
  });
  test(`CX59 ${label}: exhausted retained work is not promised as scheduled`, options, async()=>{
    const w=await world(real);
    try{
      const result=await enqueueSingleDigitalRenewal(w.f.store,w.original,nonce(830),w.runtime);assert.ok(result.ok);
      const saved=await readSingleDigitalRenewalOrigin(result.id,w.runtime);assert.ok(saved);
      const held={...saved.row,next:0,checks:w.runtime.policy!.maximumChecks};await w.run([["SET",confirmationOriginRowKey(result.id),JSON.stringify(held)]]);
      const response=await w.post(w.original,831);assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/Your request is saved|will be emailed/);
      assert.ok(await readSingleDigitalRenewalOrigin(result.id,w.runtime));
    }finally{await w.cleanup();}
  });
  test(`R5 ${label}: buyer A's pending renewal permits paid buyer B in the same store`, options, async () => {
    const w = await world(real);
    try {
      const a = await enqueueSingleDigitalRenewal(w.f.store, w.original, nonce(1), w.runtime); assert.ok(a.ok);
      const b = w.buyer(2), response = await w.post(b.capsule, 2); assert.equal(response.status, 200);
      const second = await enqueueSingleDigitalRenewal(w.f.store, b.capsule, nonce(3), w.runtime); assert.ok(second.ok);
      assert.notEqual(second.id, a.id);
      assert.deepEqual(await w.run([["SCARD", w.pendingKey], ["SCARD", `nl:order-confirmation:store:${w.f.store.statsId}`]]), [2, 2]);
      assert.equal(tokenKeys().length, 0); assert.equal(w.paymentPosts(), 0);
    } finally { await w.cleanup(); }
  });
  test(`R6 ${label}: abandoned checkout after 48 hours and worker does not block renewal`, options, async () => {
    const w = await world(real);
    try {
      const checkout = await createCheckout(w.f.store, w.physical, "https://example.test", undefined, {}, w.runtime); assert.ok(checkout.url);
      const [members] = await w.run([["SMEMBERS", `nl:order-confirmation:store:${w.f.store.statsId}`]]);
      const id = (members as string[])[0], found = await readConfirmationOrigin(id, w.runtime); assert.ok(found);
      assert.equal(found.row.phase, "awaiting_payment");
      // The source was captured by the app above. Explicit timestamp seeding
      // models old custody on native Redis; it is not a claim of historical construction.
      if (real) {
        const old = { ...found.row, created: w.runtime.now!() - 48*3_600_000, authorizedAt: w.runtime.now!() - 48*3_600_000, expiresAt: w.runtime.now!() - 24*3_600_000, next: w.runtime.now!() - 1000 };
        await w.run([["SET", confirmationOriginRowKey(id), JSON.stringify(old)], ["ZADD", "nl:order-confirmation:due", old.next, id]]);
      } else {
        w.f.advance(48*3_600_000);
        w.runtime.policy = { ...w.runtime.policy!, admissionsUntil: w.runtime.now!() + 86_400_000 };
      }
      let sends = 0;
      await runOrderConfirmationMail(w.runtime.now!()+30_000, async () => { sends++; return "accepted"; }, w.runtime);
      assert.equal(sends, 0); assert.ok(await readConfirmationOrigin(id, w.runtime), "abandoned source stays owned after worker pass");
      assert.equal((await w.post(w.original, 4)).status, 200); assert.equal(w.paymentPosts(), 1);
      assert.deepEqual(await w.run([["SCARD", w.pendingKey]]), [1]);
    } finally { await w.cleanup(); }
  });
  test(`R7 ${label}: unknown ACK retained for 30 days does not deny another buyer`, options, async () => {
    const w = await world(real);
    try {
      const result = await enqueueSingleDigitalRenewal(w.f.store, w.original, nonce(5), w.runtime); assert.ok(result.ok);
      let posts = 0;
      const unknown = async (_m: unknown, barrier: () => Promise<boolean>) => { assert.equal(await barrier(), true); posts++; return "unknown" as const; };
      await runOrderConfirmationMail(w.runtime.now!()+30_000, unknown, w.runtime);
      const saved = await readSingleDigitalRenewalOrigin(result.id, w.runtime); assert.ok(saved); assert.equal(saved.row.state, "dispatching");
      // Age an app-created, acknowledged dispatch row explicitly, preserving its source and payload.
      if (real) {
        const old = { ...saved.row, created: w.runtime.now!() - 30*86_400_000, authorizedAt: w.runtime.now!() - 30*86_400_000, next: w.runtime.now!() - 1000, leaseUntil: w.runtime.now!() - 1000 };
        await w.run([["SET", confirmationOriginRowKey(result.id), JSON.stringify(old)], ["ZADD", "nl:order-confirmation:due", old.next, result.id]]);
      } else {
        w.f.advance(30*86_400_000);
        w.runtime.policy = { ...w.runtime.policy!, admissionsUntil: w.runtime.now!() + 86_400_000 };
      }
      await runOrderConfirmationMail(w.runtime.now!()+30_000, unknown, w.runtime);
      assert.equal(posts, 1); assert.equal((await readSingleDigitalRenewalOrigin(result.id, w.runtime))?.row.state, "dispatching");
      assert.deepEqual(await enqueueSingleDigitalRenewal(w.f.store, w.original, nonce(55), w.runtime), {ok:false,reason:"acceptance_unknown"}, "unknown ACK keeps capsule deduplication and reports its unresolved state after thirty days");
      assert.equal((await w.post(w.buyer(3).capsule, 6)).status, 200);
      assert.deepEqual(await w.run([["TTL", confirmationOriginRowKey(result.id)], ["GET", w.pointer(w.original)]]), [-1, result.id]);
      assert.deepEqual(await w.run([["SCARD", w.pendingKey]]), [2]);
    } finally { await w.cleanup(); }
  });
  test(`${label}: reserve-only course remains owned while the same store accepts renewal`, options, async () => {
    const w = await world(real);
    try {
      const course = await reserveCourse(w);
      await runOrderConfirmationMail(w.runtime.now!()+30_000, async () => { throw Error("A course reservation cannot send"); }, w.runtime);
      assert.equal((await w.post(w.original, 7)).status, 200);
      assert.equal((await readCourseConfirmationOrigin(course, w.runtime))?.row.phase, "course_reserved");
      assert.deepEqual(await w.run([["ZSCORE", "nl:order-confirmation:due", course], ["SCARD", w.pendingKey]]), [null, 1]);
      assert.equal(w.paymentPosts(), 0);
    } finally { await w.cleanup(); }
  });
  test(`${label}: accepted and canceled renewals atomically release capsule pointer and renewal quota`, options, async () => {
    const w = await world(real);
    try {
      const first = await enqueueSingleDigitalRenewal(w.f.store, w.original, nonce(8), w.runtime); assert.ok(first.ok);
      await runOrderConfirmationMail(w.runtime.now!()+30_000, async (_m, barrier) => { assert.equal(await barrier(), true); return "accepted"; }, w.runtime);
      assert.equal(await readSingleDigitalRenewalOrigin(first.id, w.runtime), null);
      assert.deepEqual(await w.run([["GET", w.pointer(w.original)], ["SCARD", w.pendingKey]]), [null, 0]);
      if (real) assert.deepEqual(await w.run([["TYPE", `nl:ship:mail:pool:${w.f.store.statsId}`], ["HGET", "nl:ship:mail:pool", "items"], ["HGET", "nl:ship:mail:pool", "bytes"]]), ["none", "0", "0"]);
      assert.ok(Number((await w.run([["TTL", `nl:order-confirmation:source:${first.id}`]]))[0]) > 399*86_400);
      // Fixture time advances past a full token lifetime. Native Redis covers
      // immediate terminal cleanup without pretending its clock advanced.
      if (!real) { w.f.advance(25*3_600_000); w.runtime.policy = { ...w.runtime.policy!, admissionsUntil: w.runtime.now!()+86_400_000 }; }
      // Fresh request nonce after terminal completion must reserve its own funded row.
      const second = await enqueueSingleDigitalRenewal(w.f.store, w.original, nonce(9), w.runtime); assert.ok(second.ok); assert.notEqual(second.id, first.id);
      assert.deepEqual(await w.run([["GET", w.pointer(w.original)], ["SCARD", w.pendingKey]]), [second.id, 1]);
      const checkout = await createCheckout(w.f.store, w.physical, "https://example.test", undefined, {}, w.runtime); assert.ok(checkout.url);
      if (real) {
        const saved = await readSingleDigitalRenewalOrigin(second.id, w.runtime); assert.ok(saved);
        const physicalId = (await w.run([["SMEMBERS", `nl:order-confirmation:store:${w.f.store.statsId}`]]))[0] as string[];
        const physical = await readConfirmationOrigin(physicalId.find(id => id !== second.id)!, w.runtime); assert.ok(physical);
        assert.deepEqual(await w.run([["HGET", `nl:ship:mail:pool:${w.f.store.statsId}`, "items"], ["HGET", `nl:ship:mail:pool:${w.f.store.statsId}`, "bytes"]]), ["2", String(saved.row.bytes + physical.row.bytes)]);
      }
      assert.equal(await forgetOrderConfirmationMail(w.f.store.statsId, w.f.email, w.runtime), 1);
      assert.deepEqual(await w.run([["GET", w.pointer(w.original)], ["SCARD", w.pendingKey]]), [null, 0]);
      if (real) {
        const [remaining] = await w.run([["SMEMBERS", `nl:order-confirmation:store:${w.f.store.statsId}`]]);
        assert.equal((remaining as string[]).length, 1);
        const physical = await readConfirmationOrigin((remaining as string[])[0], w.runtime); assert.ok(physical);
        assert.deepEqual(await w.run([["HGET", `nl:ship:mail:pool:${w.f.store.statsId}`, "items"], ["HGET", `nl:ship:mail:pool:${w.f.store.statsId}`, "bytes"]]), ["1", String(physical.row.bytes)]);
      }
      assert.equal(w.paymentPosts(), 1);
    } finally { await w.cleanup(); }
  });
}

test("native Redis: concurrent paid buyers stop at eight pending renewals and preserve the ninth physical slot", { skip: !native }, async () => {
  const w = await world(true);
  try {
    w.runtime.policy = { ...w.runtime.policy!, storeItems: 9, globalItems: 10 };
    const capsules = Array.from({ length: 9 }, (_, i) => w.buyer(i+10).capsule);
    const answers = await Promise.all(capsules.map((capsule, i) => enqueueSingleDigitalRenewal(w.f.store, capsule, nonce(i+600), w.runtime)));
    const accepted = answers.filter((r): r is Extract<typeof r, { ok: true }> => r.ok);
    assert.equal(accepted.length, 8); assert.equal(new Set(accepted.map(r => r.id)).size, 8);
    assert.deepEqual(answers.filter(r => !r.ok), [{ ok: false, reason: "capacity" }]);
    assert.deepEqual(await w.run([["SCARD", w.pendingKey], ["HGET", `nl:ship:mail:pool:${w.f.store.statsId}`, "items"]]), [8, "8"]);
    const winner = answers.findIndex(r => r.ok), again = await enqueueSingleDigitalRenewal(w.f.store, capsules[winner], nonce(700), w.runtime);
    assert.deepEqual(again, answers[winner], "full quota still resolves the authenticated capsule's existing pending request");
    const checkout = await createCheckout(w.f.store, w.physical, "https://example.test", undefined, {}, w.runtime); assert.ok(checkout.url);
    const rows = await Promise.all(accepted.map(r => readSingleDigitalRenewalOrigin(r.id, w.runtime)));
    assert.ok(rows.every(Boolean));
    const [members] = await w.run([["SMEMBERS", `nl:order-confirmation:store:${w.f.store.statsId}`]]);
    const physicalId = (members as string[]).find(id => !accepted.some(r => r.id === id))!;
    const physical = await readConfirmationOrigin(physicalId, w.runtime); assert.ok(physical);
    const chargedBytes = rows.reduce((n, row) => n + row!.row.bytes, physical.row.bytes);
    assert.deepEqual(await w.run([["SCARD", w.pendingKey], ["HGET", `nl:ship:mail:pool:${w.f.store.statsId}`, "items"], ["HGET", `nl:ship:mail:pool:${w.f.store.statsId}`, "bytes"]]), [8, "9", String(chargedBytes)]);
    assert.equal(w.paymentPosts(), 1);
  } finally { await w.cleanup(); }
});

test("native Redis: corrupt capsule pointers retain custody, quota and the erasure fence", { skip: !native }, async () => {
  for (const corrupt of ["corrupt", "f".repeat(64)]) {
    const w = await world(true);
    try {
      const initial = await enqueueSingleDigitalRenewal(w.f.store, w.original, nonce(800), w.runtime); assert.ok(initial.ok);
      const saved = await readSingleDigitalRenewalOrigin(initial.id, w.runtime); assert.ok(saved);
      await w.run([["SET", w.pointer(w.original), corrupt]]);
      const blocked = await enqueueSingleDigitalRenewal(w.f.store, w.original, nonce(801), w.runtime);
      assert.equal(blocked.ok, false, "a malformed pointer or foreign id never authenticates an existing request");
      let posts = 0;
      await runOrderConfirmationMail(w.runtime.now!()+30_000, async () => { posts++; return "accepted"; }, w.runtime);
      assert.equal(posts, 0); assert.equal(tokenKeys().length, 0);
      await assert.rejects(forgetOrderConfirmationMail(w.f.store.statsId, undefined, w.runtime), /Confirmation erasure is unknown/);
      const fence = `nl:order-confirmation:closed:${w.f.store.statsId}`;
      assert.deepEqual(await w.run([["TYPE", fence], ["TTL", fence]]), ["string", -1], "failed cleanup keeps the store fence indefinitely");
      assert.equal((await readSingleDigitalRenewalOrigin(initial.id, w.runtime))?.raw, saved.raw);
      assert.deepEqual(await w.run([["GET", w.pointer(w.original)], ["SCARD", w.pendingKey], ["SCARD", `nl:order-confirmation:store:${w.f.store.statsId}`],
        ["HGET", `nl:ship:mail:pool:${w.f.store.statsId}`, "items"], ["HGET", `nl:ship:mail:pool:${w.f.store.statsId}`, "bytes"]]), [corrupt, 1, 1, "1", String(saved.row.bytes)]);
    } finally { await w.cleanup(); }
  }
});

test("native Redis: the twelve-key renewal custody footprint fits its reserved row envelope", { skip: !native }, async () => {
  const w = await world(true);
  try {
    const result = await enqueueSingleDigitalRenewal(w.f.store, w.original, nonce(900), w.runtime); assert.ok(result.ok);
    const saved = await readSingleDigitalRenewalOrigin(result.id, w.runtime); assert.ok(saved);
    const keyNames = [confirmationOriginRowKey(result.id), `nl:order-confirmation:source:${result.id}`, "nl:order-confirmation:due",
      `nl:order-confirmation:store:${w.f.store.statsId}`, `nl:order-confirmation:person:${w.f.store.statsId}:${saved.row.person}`,
      "nl:ship:mail:pool", `nl:ship:mail:pool:${w.f.store.statsId}`, "nl:ship:mail:all", `nl:order-confirmation:closed:${w.f.store.statsId}`,
      `nl:order-confirmation:erased:${w.f.store.statsId}:${saved.row.person}`, w.pointer(w.original), w.pendingKey];
    assert.equal(new Set(keyNames).size, 12);
    const memory = await w.run(keyNames.map(key => ["MEMORY", "USAGE", key, "SAMPLES", 0]));
    assert.ok(Number(memory[10]) > 0); assert.ok(Number(memory[11]) > 0, "the new pointer and renewal-only index count toward the measured footprint");
    const actualBytes = memory.reduce<number>((sum, value) => sum + Number(value ?? 0), 0);
    assert.ok(actualBytes > Buffer.byteLength(saved.raw)); assert.ok(actualBytes <= saved.row.bytes);
    console.log(JSON.stringify({ proof: "synthetic-renewal-twelve-key-memory", presentKeys: memory.filter(value => value !== null).length, capsulePointerBytes: Number(memory[10]), renewalIndexBytes: Number(memory[11]), actualBytes, reservedBytes: saved.row.bytes }));
  } finally { await w.cleanup(); }
});

test("native Redis: ending a renewal preserves refused physical evidence in the same pool", { skip: !native }, async () => {
  const w = await world(true);
  try {
    const now = w.runtime.now!(), statsId = w.f.store.statsId!;
    const session = "cs_test_SharedPoolShipment000001";
    const queued = await enqueueShipmentMail({ statsId, session, authorizedAt: now,
      shipped: { at: Math.floor(now / 1000), tracking: "" },
      message: { from: "Store <owner@example.test>", to: "physical-buyer@example.test", subject: "Shipment", text: "Original shipment", replyTo: "owner@example.test" },
    }, w.runtime);
    assert.ok(queued.ok);
    await runShipmentMail(w.runtime.now!() + 30_000, async (_message, beforePost) => {
      assert.equal(await beforePost(), true); return "refused";
    }, w.runtime);
    const globalPool = "nl:ship:mail:pool", storePool = `${globalPool}:${statsId}`;
    const summaryFields = await w.run([["HKEYS", storePool]]);
    assert.ok(Array.isArray(summaryFields[0]));
    const fields = (summaryFields[0] as string[]).filter(field => field.startsWith("refused:"));
    assert.equal(fields.length, 1);
    const before = await w.run([["HGET", storePool, fields[0]]]);
    assert.equal(typeof before[0], "string");
    const renewal = await enqueueSingleDigitalRenewal(w.f.store, w.original, nonce(1100), w.runtime);
    assert.ok(renewal.ok);
    const result = await runOrderConfirmationMail(w.runtime.now!() + 30_000, async (_message, beforePost) => {
      assert.equal(await beforePost(), true); return "accepted";
    }, w.runtime);
    assert.equal(result.accepted, 1);
    assert.equal(await readSingleDigitalRenewalOrigin(renewal.id, w.runtime), null);
    assert.deepEqual(await w.run([["HGET", storePool, fields[0]]]), before, "renewal release cannot delete a physical outcome");
    assert.deepEqual(await w.run([["HGET", storePool, "items"], ["HGET", storePool, "bytes"], ["HLEN", storePool]]), [null, null, 1]);
    assert.equal((await w.run([["HLEN", globalPool]]))[0], 3, "global counters and physical outcome survive");
  } finally { await w.cleanup(); }
});

test("native Redis: INFO measures the exact twelve-key app Lua without observer commands", { skip: !native }, async () => {
  const w = await world(true), base = w.runtime.pipeline!;
  type Profile = { operation: string; result: string; total: number; calls: Record<string, number> };
  const profiles: Profile[] = [];
  const counts = (raw: unknown) => {
    assert.equal(typeof raw, "string");
    return Object.fromEntries([...String(raw).matchAll(/^cmdstat_([^:]+):calls=(\d+),/gm)].map(match => [match[1], Number(match[2])]));
  };
  w.runtime.pipeline = async commands => {
    const answers: unknown[] = [];
    for (const command of commands) {
      if (command[0] !== "EVAL" || command[1] !== SHIPMENT_MAIL_SCRIPT || command[2] !== 12) {
        answers.push(...await base([command])); continue;
      }
      // The app's actual command is executed once, unchanged. MULTI prevents a
      // Redis service health PING or another client from entering this window.
      // MULTI/EXEC are test infrastructure, outside the two INFO snapshots.
      const measured = await base([["MULTI"], ["INFO", "commandstats"], command, ["INFO", "commandstats"], ["EXEC"]]);
      assert.deepEqual(measured.slice(0, 4), ["OK", "QUEUED", "QUEUED", "QUEUED"]);
      const executed = measured[4] as unknown[]; assert.equal(executed.length, 3);
      const before = counts(executed[0]), after = counts(executed[2]);
      const delta = Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(after)])].map(name => [name, (after[name] ?? 0) - (before[name] ?? 0)]));
      // The first INFO completes after its snapshot. Remove exactly that one
      // observer; preserve any additional INFO invoked by application Lua.
      assert.ok(delta.info >= 1); delta.info--;
      assert.ok(Object.values(delta).every(value => Number.isSafeInteger(value) && value >= 0));
      assert.equal(delta.eval, 1, "one exact application EVAL, including its redis.call commands");
      assert.equal(delta.multi ?? 0, 0); assert.equal(delta.exec ?? 0, 0);
      const calls = Object.fromEntries(Object.entries(delta).filter(([, value]) => value > 0));
      const total = Object.values(calls).reduce((sum, value) => sum + value, 0);
      // Processing regression ceiling only; observed commands are neither a
      // supplier invoice nor financial approval of the synthetic policy.
      const result = executed[1] as unknown[]; assert.ok(Array.isArray(result));
      const operation = String(command[3 + Number(command[2])]);
      const ceilings: Record<string, number> = { "enqueue:queued": 35, "enqueue:duplicate": 18, "cancel:canceled": 32, "claim:preparing": 20, "renewal-prepare:prepared": 19, "dispatch:dispatching": 20, "accepted:accepted": 33 };
      const ceiling = ceilings[`${operation}:${result[0]}`]; assert.ok(Number.isSafeInteger(ceiling));
      console.log(JSON.stringify({ proof: "CX121-parent-integration-red", operation, result: result[0], observed: total, ceiling, calls }));
      assert.ok(total <= ceiling, `${operation}/${result[0]} observed ${total} commands, above the measured ${ceiling} ceiling`);
      profiles.push({ operation, result: String(result[0]), total, calls });
      answers.push(result);
    }
    return answers;
  };
  try {
    const first = await enqueueSingleDigitalRenewal(w.f.store, w.original, nonce(1000), w.runtime); assert.ok(first.ok);
    assert.deepEqual(await enqueueSingleDigitalRenewal(w.f.store, w.original, nonce(1001), w.runtime), first);
    const b = w.buyer(30), second = await enqueueSingleDigitalRenewal(w.f.store, b.capsule, nonce(1002), w.runtime); assert.ok(second.ok);
    assert.deepEqual(await w.run([["SCARD", w.pendingKey], ["HGET", `nl:ship:mail:pool:${w.f.store.statsId}`, "items"]]), [2, "2"]);
    assert.equal(await forgetOrderConfirmationMail(w.f.store.statsId, b.email, w.runtime), 1);
    assert.deepEqual(await w.run([["GET", w.pointer(b.capsule)], ["GET", w.pointer(w.original)], ["SCARD", w.pendingKey]]), [null, first.id, 1]);
    let posted = 0;
    await runOrderConfirmationMail(w.runtime.now!()+30_000, async (_message, barrier) => { assert.equal(await barrier(), true); posted++; return "accepted"; }, w.runtime);
    assert.equal(posted, 1); assert.equal(await readSingleDigitalRenewalOrigin(first.id, w.runtime), null);
    assert.deepEqual(await w.run([["GET", w.pointer(w.original)], ["SCARD", w.pendingKey], ["TYPE", `nl:ship:mail:pool:${w.f.store.statsId}`], ["HGET", "nl:ship:mail:pool", "items"]]), [null, 0, "none", "0"]);
    const c = w.buyer(31), last = await enqueueSingleDigitalRenewal(w.f.store, c.capsule, nonce(1003), w.runtime); assert.ok(last.ok);
    assert.equal(await forgetOrderConfirmationMail(w.f.store.statsId, c.email, w.runtime), 1);
    assert.deepEqual(await w.run([["GET", w.pointer(c.capsule)], ["SCARD", w.pendingKey], ["TYPE", `nl:ship:mail:pool:${w.f.store.statsId}`], ["HGET", "nl:ship:mail:pool", "items"], ["HGET", "nl:ship:mail:pool", "bytes"]]), [null, 0, "none", "0", "0"]);
    assert.deepEqual(profiles.map(({ operation, result }) => [operation, result]), [["enqueue", "queued"], ["enqueue", "duplicate"], ["enqueue", "queued"], ["cancel", "canceled"],
      ["claim", "preparing"], ["renewal-prepare", "prepared"], ["dispatch", "dispatching"], ["accepted", "accepted"], ["enqueue", "queued"], ["cancel", "canceled"]]);
    console.log(JSON.stringify({ proof: "synthetic-renewal-exact-lua-commandstats", method: "atomic MULTI/INFO/EVAL/INFO/EXEC; subtract one observer INFO", scriptSha256: digest(SHIPMENT_MAIL_SCRIPT), profiles, supplierInvoice: false, financialApproval: false }));
  } finally { await w.cleanup(); }
});
