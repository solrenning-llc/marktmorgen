/** Real checkout/preintent/cipher orchestration with synthetic ACK boundaries.
 * The separate Python proof executes both exact Lua scripts on real Redis.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { seal } from "@/lib/secret-box";
import { test } from "node:test";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductShipping, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { createCheckout } from "@/lib/store-checkout";
import { bindOrderConfirmationPreintent } from "@/lib/orders";
import { CONFIRMATION_ORIGIN_SCRIPT, bindConfirmationOrigin, confirmationOriginRowKey, runOrderConfirmationMail, openConfirmationOrigin, readConfirmationOrigin, reserveConfirmationOrigin, type ConfirmationOriginRuntime } from "@/lib/order-confirmation-outbox";
import { physicalPaidFixture } from "./order-confirmation-paid-fixture";
import { shipmentMailId } from "@/lib/shipment-mail-outbox";
import { store as redis } from "./redis-stub";
import { shipmentOutboxFixture, shipmentPolicy } from "./shipment-mail-outbox-fixture";

process.env.NIMBUS_DATA_KEY = "SYNTHETIC_ONLY_CONFIRMATION_ORIGIN_KEY_2026";
globalThis.fetch = async () => { throw Error("No external service is allowed in this proof"); };
async function fixture() {
  redis.clear();
  const owner = "physical-origin@example.test";
  await claimHandle(owner, "physical-origin", "Original printed store", "");
  await ensureStatsId(owner); await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_TestOrigin01", true);
  const created = Date.now();
  await setSubscription(owner, { customerId: "cus_SyntheticPhysicalOrigin", subscriptionId: "sub_SyntheticPhysicalOrigin", active: true, tier: "creator", period: { start: Math.floor(created / 1000) - 86_400, end: Math.floor(created / 1000) + 20 * 86_400, renews: true } });
  const added = await addProduct(owner, "Original printed book", "The purchased version", "35", null);
  assert.ok(added.ok);
  await setProductShipping(owner, added.product.id, { cents: 500, region: "us", countries: ["US"], note: "Original shipping note" });
  const store = (await storeForEmail(owner))!, product = (await readProduct(store, added.product.id))!;
  let clock = created, lose: string | null = null, sequence = 0;
  const now = () => clock + Date.now() - created;
  const ack = shipmentOutboxFixture(), sessions = new Map<string, Record<string, unknown>>();
  const calls: { method: string; account: string; body?: string; key?: string; path: string }[] = [];
  const runtime: ConfirmationOriginRuntime = {
    lifecycle: "active", policy: shipmentPolicy(created), now,
    pipeline: async commands => {
      const answers: unknown[] = [];
      for (const c of commands) {
        if (c[0] === "TIME") { answers.push([String(Math.floor(now() / 1000)), String(now() % 1000 * 1000)]); continue; }
        if (c[0] !== "EVAL" || c[1] !== CONFIRMATION_ORIGIN_SCRIPT) { answers.push(...await ack.pipeline([c])); continue; }
        const k = c.slice(3, 13).map(String), op = String(c[13]), expected = String(c[14]);
        const raw = redis.run(["GET", k[0]]) as string | null;
        let answer: unknown = ["unknown"];
        if (raw !== expected) answer = ["changed"];
        else if (raw) {
          const r = JSON.parse(raw);
          if (op === "create" && !r.session && r.leaseUntil <= now() && now() < r.created + 23 * 3_600_000) {
            r.phase = "creating"; r.owner = String(c[17]); r.leaseUntil = now() + 120_000; r.createAttempts++;
            const next = JSON.stringify(r); redis.run(["SET", k[0], next]);
            answer = ["creating", next, String(now()), String(r.created + 23 * 3_600_000)];
          } else if (op === "bind") {
            if (r.session) answer = ["bound", raw];
            else { const next = String(c[15]), n = JSON.parse(next); redis.run(["SET", k[0], next]); redis.run(["SET", k[1], n.sourceValue]); answer = ["bound", next]; }
          } else if (op === "cursor") answer = ["cursor", raw];
          else if (op === "url" && r.session && r.phase === "awaiting_payment" && ["queued", "preparing"].includes(r.state) &&
              redis.run(["GET", k[1]]) === r.sourceValue && redis.run(["EXISTS", k[8]]) === 0 && redis.run(["EXISTS", k[9]]) === 0) {
            const serverNow = now();
            answer = ["url", r.id, r.session, r.bindingFingerprint, String(serverNow), String(Math.min(serverNow + 1000, r.expiresAt))];
          }
        }
        if (lose === op) { lose = null; throw Error("Synthetic lost ACK after durable source mutation"); }
        answers.push(answer);
      }
      return answers;
    },
    provider: async (method, account, path, body, _version, key) => {
      calls.push({ method, account, path, ...(body ? { body: body.toString() } : {}), ...(key ? { key } : {}) });
      if (method === "POST") {
        assert.equal(account, store.stripeAccountId);
        const protectedRows = [...redis.keys()].filter(k => k.startsWith("nl:order-confirmation:row:"));
        assert.equal(protectedRows.length, 1, "a protected source and its admission precede Stripe");
        const r = JSON.parse(String(redis.run(["GET", protectedRows[0]])));
        assert.equal(r.phase, "creating", "POST requires the acknowledged creation checkpoint");
        const metadata = Object.fromEntries([...body!].flatMap(([k, v]) => /^metadata\[/.test(k) ? [[k.slice(9, -1), v]] : []));
        const id = `cs_test_physicalorigin${++sequence}00000001`;
        const session = { object: "checkout.session", id, mode: "payment", status: "open", currency: "usd", created: Math.floor(now() / 1000),
          url: `https://checkout.stripe.com/c/pay/${id}`, metadata,
          line_items: { object: "list", has_more: false, data: [{ quantity: 1, price: { unit_amount: 3500, currency: "usd" } }] } };
        sessions.set(id, session); return session;
      }
      const pathOnly = path.split("?")[0];
      if (pathOnly === "/checkout/sessions") return { object: "list", has_more: false, data: [...sessions.values()] };
      return sessions.get(pathOnly.split("/").at(-1)!) ?? {};
    },
  };
  return { store, product, runtime, calls, sessions, created, advance: (ms: number) => { clock = created + ms; }, loseNext: (op: string) => { lose = op; } };
}
function originId() {
  const key = [...redis.keys()].find(k => k.startsWith("nl:order-confirmation:row:"));
  assert.ok(key); return key.slice("nl:order-confirmation:row:".length);
}

test("the real physical checkout reserves a protected source and returns only its CAS winner", async () => {
  const f = await fixture();
  const checkout = await createCheckout(f.store, f.product, "https://example.test", undefined, {}, f.runtime);
  const id = originId(), found = await readConfirmationOrigin(id, f.runtime); assert.ok(found);
  assert.equal(checkout.id, found.row.session); assert.equal(found.row.phase, "awaiting_payment");
  assert.match(found.row.bindingFingerprint, /^[a-f0-9]{64}$/);
  assert.notEqual(id, shipmentMailId(f.store.statsId!, checkout.id));
  assert.equal(redis.run(["TTL", confirmationOriginRowKey(id)]), -1);
  assert.equal(found.raw.includes(f.store.email), false); assert.equal(found.raw.includes(f.product.title), false);
  assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
  const second = await bindOrderConfirmationPreintent(f.store, found.payload.preintentToken, { sessionId: "cs_test_competingPhysicalSession01", nonce: found.row.nonce, accountId: found.row.accountId, bodyDigest: found.row.bodyDigest });
  assert.ok(second);
  const winner = await bindConfirmationOrigin(id, second, f.runtime); assert.ok(winner);
  assert.equal(winner.sessionId, checkout.id); assert.equal(winner.settlementToken, found.payload.settlementToken);
  assert.equal(winner.bindingFingerprint, found.row.bindingFingerprint);
});

test("missing funding or unacknowledged creation cannot create a payment URL", async () => {
  const f = await fixture();
  await assert.rejects(createCheckout(f.store, f.product, "https://example.test", undefined, {}, { ...f.runtime, policy: null }));
  assert.equal(f.calls.length, 0); assert.equal([...redis.keys()].some(k => k.startsWith("nl:order-confirmation:")), false);
  f.loseNext("create");
  await assert.rejects(createCheckout(f.store, f.product, "https://example.test", undefined, {}, f.runtime));
  assert.equal(f.calls.filter(c => c.method === "POST").length, 0);
  assert.ok(await readConfirmationOrigin(originId(), f.runtime));
});

test("after24h recovery uses original account and paginated reads, never another creation POST", async () => {
  const f = await fixture();
  const checkout = await createCheckout(f.store, f.product, "https://example.test", undefined, {}, f.runtime);
  const id = originId(), found = await readConfirmationOrigin(id, f.runtime); assert.ok(found);
  // Simulate a crash before binding became readable, retaining original proof.
  const unbound = { ...found.row, session: "", bindingFingerprint: "", phase: "creating", owner: "", leaseUntil: 0, sourceValue: JSON.stringify({ kind: "confirmation", nonce: found.row.nonce, accountId: found.row.accountId, bodyDigest: found.row.bodyDigest, session: "" }) };
  redis.run(["SET", confirmationOriginRowKey(id), JSON.stringify(unbound)]);
  redis.run(["SET", `nl:order-confirmation:source:${id}`, unbound.sourceValue]);
  const payload = { ...found.payload }; delete payload.settlementToken;
  const original = JSON.stringify(payload);
  unbound.sealed = seal(original, `order-confirmation-origin|${id}`);
  unbound.fingerprint = createHash("sha256").update(original).digest("hex");
  redis.run(["SET", confirmationOriginRowKey(id), JSON.stringify(unbound)]);
  f.sessions.get(checkout.id)!.status = "complete";
  f.sessions.get(checkout.id)!.payment_status = "paid";
  f.sessions.get(checkout.id)!.amount_total = 4000;
  f.advance(25 * 3_600_000);
  const resumed = await openConfirmationOrigin(id, f.runtime);
  assert.equal(resumed, null, "a completed hosted session cannot open another payment URL");
  assert.equal((await readConfirmationOrigin(id, f.runtime))?.row.session, checkout.id);
  assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
  assert.ok(f.calls.some(c => c.method === "GET" && c.path.startsWith("/checkout/sessions?")));
  assert.ok(f.calls.every(c => c.account === found.row.accountId));
});

test("a lost binding ACK reconciles its stored winner; a partial source does not authorize URL", async () => {
  const f = await fixture(); f.loseNext("bind");
  const checkout = await createCheckout(f.store, f.product, "https://example.test", undefined, {}, f.runtime);
  const id = originId(), saved = await readConfirmationOrigin(id, f.runtime); assert.ok(saved);
  assert.equal(checkout.id, saved.row.session);
  assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
  redis.run(["SET", `nl:order-confirmation:source:${id}`, "a partial or corrupted source"]);
  assert.equal(await readConfirmationOrigin(id, f.runtime), null);
  assert.equal(await openConfirmationOrigin(id, f.runtime), null);
  assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
});


test("a caller-supplied token hash is not an acknowledged original admission", async () => {
  const f = await fixture();
  await createCheckout(f.store, f.product, "https://example.test", undefined, {}, f.runtime);
  const found = await readConfirmationOrigin(originId(), f.runtime); assert.ok(found);
  const fake = "s1.not-an-authenticated-admission";
  let commands = 0;
  const result = await reserveConfirmationOrigin({ statsId: found.row.statsId, nonce: found.row.nonce, accountId: found.row.accountId,
    body: found.payload.body, preintent: { token: fake, intentFingerprint: createHash("sha256").update(fake).digest("hex"), expiresAtMs: found.row.expiresAt }, snapshot: found.payload.snapshot },
    { ...f.runtime, pipeline: async () => { commands++; throw Error("Invalid proof must not reach Redis"); } });
  assert.deepEqual(result, { ok: false }); assert.equal(commands, 0);
});


test("the real creation caller checks its monotonic permission after the claim helper", async () => {
  const f = await fixture(), prior = Object.getOwnPropertyDescriptor(performance, "now");
  let reads = 0;
  const samples = [100, 101, 23 * 3_600_000 + 1000];
  try {
    Object.defineProperty(performance, "now", { configurable: true, value: () => samples[Math.min(reads++, samples.length - 1)] });
    await assert.rejects(createCheckout(f.store, f.product, "https://example.test", undefined, {}, f.runtime));
    assert.equal(reads, 3); assert.equal(f.calls.length, 0);
    assert.ok(await readConfirmationOrigin(originId(), f.runtime));
  } finally {
    if (prior) Object.defineProperty(performance, "now", prior);
    else Reflect.deleteProperty(performance, "now");
  }
});


test("a final source gate denies URLs when closure or erasure precedes exposure", async () => {
  for (const kind of ["store", "person", "during-provider-read"] as const) {
    const f = await fixture();
    const checkout = await createCheckout(f.store, f.product, "https://example.test", undefined, {}, f.runtime);
    const id = originId(), found = await readConfirmationOrigin(id, f.runtime); assert.ok(found);
    const fence = kind === "person" ? `nl:order-confirmation:erased:${found.row.statsId}:${found.row.person}` : `nl:order-confirmation:closed:${found.row.statsId}`;
    const provider = f.runtime.provider!;
    if (kind === "during-provider-read") f.runtime.provider = async (...args) => {
      const result = await provider(...args); redis.run(["SET", fence, "closed before final source gate"]); return result;
    };
    else redis.run(["SET", fence, "closed before open"]);
    assert.equal(await openConfirmationOrigin(id, f.runtime), null, kind);
    assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
    assert.equal((await readConfirmationOrigin(id, f.runtime))?.row.session, checkout.id);
    assert.equal(redis.run(["TTL", confirmationOriginRowKey(id)]), -1);
  }
});

test("the final gate refuses replaced or removed source evidence after the exact provider read", async () => {
  for (const kind of ["source", "winner", "row-missing", "phase"] as const) {
    const f = await fixture();
    await createCheckout(f.store, f.product, "https://example.test", undefined, {}, f.runtime);
    const id = originId(), found = await readConfirmationOrigin(id, f.runtime); assert.ok(found);
    const provider = f.runtime.provider!;
    f.runtime.provider = async (...args) => {
      const result = await provider(...args);
      if (kind === "source") redis.run(["SET", `nl:order-confirmation:source:${id}`, "changed source"]);
      else if (kind === "row-missing") redis.run(["DEL", confirmationOriginRowKey(id)]);
      else redis.run(["SET", confirmationOriginRowKey(id), JSON.stringify({ ...found.row, ...(kind === "winner" ? { session: "cs_test_otherWinningSession01" } : { phase: "refused" }) })]);
      return result;
    };
    assert.equal(await openConfirmationOrigin(id, f.runtime), null, kind);
    assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
  }
});

test("only exact timely final-gate acknowledgements expose the already verified winning URL", async () => {
  for (const kind of ["lost", "malformed", "wrong-session", "wrong-deadline", "stale", "nested-getter"] as const) {
    const f = await fixture();
    const checkout = await createCheckout(f.store, f.product, "https://example.test", undefined, {}, f.runtime);
    const id = originId(), before = await readConfirmationOrigin(id, f.runtime); assert.ok(before);
    const pipeline = f.runtime.pipeline!; let getters = 0;
    f.runtime.pipeline = async commands => {
      const answer = await pipeline(commands);
      if (commands[0]?.[0] !== "EVAL" || commands[0]?.[13] !== "url") return answer;
      if (kind === "lost") throw Error("Synthetic read-only permission ACK lost");
      if (kind === "malformed") return [["url", id, checkout.id]];
      if (kind === "wrong-session") return [["url", id, "cs_test_foreignSession00001", before.row.bindingFingerprint, String(Date.now()), String(Date.now()+1000)]];
      if (kind === "wrong-deadline") return [["url", id, checkout.id, before.row.bindingFingerprint, String(Date.now()), String(Date.now()+2000)]];
      if (kind === "stale") { f.advance(2000); return answer; }
      const nested = ["url", id, checkout.id, before.row.bindingFingerprint, String(Date.now()), String(Date.now()+1000)];
      Object.defineProperty(nested, "2", { get() { getters++; return checkout.id; } });
      return [nested];
    };
    assert.equal(await openConfirmationOrigin(id, f.runtime), null, kind);
    assert.equal(getters, 0);
    assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
    const after = await readConfirmationOrigin(id, f.runtime); assert.ok(after);
    assert.equal(after.raw, before.raw, "read-only permission cannot renew or release source capacity");
  }
  const f = await fixture();
  const checkout = await createCheckout(f.store, f.product, "https://example.test", undefined, {}, f.runtime);
  const before = await readConfirmationOrigin(originId(), f.runtime); assert.ok(before);
  assert.deepEqual(await openConfirmationOrigin(originId(), f.runtime), checkout);
  assert.equal((await readConfirmationOrigin(originId(), f.runtime))?.raw, before.raw);
  assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
});


test("final URL acknowledgement timestamps must be plausible under the existing Redis clock tolerance", async () => {
  for (const [offset, allowed] of [[86_400_000, false], [-86_400_000, false], [59_000, true], [-100, true]] as const) {
    const f = await fixture();
    const checkout = await createCheckout(f.store, f.product, "https://example.test", undefined, {}, f.runtime);
    const id = originId(), found = await readConfirmationOrigin(id, f.runtime); assert.ok(found);
    const pipeline = f.runtime.pipeline!;
    f.runtime.pipeline = async commands => {
      const original = await pipeline(commands);
      if (commands[0]?.[0] !== "EVAL" || commands[0]?.[13] !== "url") return original;
      const server = f.runtime.now!() + offset;
      return [["url", id, checkout.id, found.row.bindingFingerprint, String(server), String(Math.min(found.row.expiresAt, server + 1000))]];
    };
    const opened = await openConfirmationOrigin(id, f.runtime);
    assert.equal(Boolean(opened), allowed, `synthetic ACK offset ${offset}; impossible ACK is not produced by honest Lua`);
    assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
    assert.equal((await readConfirmationOrigin(id, f.runtime))?.raw, found.raw);
  }
});


test("an unpaid winner remains viewable while the real worker prepares it, unless a fence wins", async () => {
  for (const closed of [false, true]) {
    const f = await physicalPaidFixture();
    const checkout = await createCheckout(f.store, f.product, "https://example.test", undefined, {}, f.runtime);
    const id = originId(); f.advance(61_000);
    const provider = f.runtime.provider!;
    let announce!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { announce = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    f.runtime.provider = async (...args) => {
      if (args[0] === "GET" && args[2].includes("payment_intent")) { announce(); await held; }
      return provider(...args);
    };
    const worker = runOrderConfirmationMail(f.runtime.now!() + 5000, async () => { throw Error("An unpaid source cannot dispatch email"); }, f.runtime, id);
    try {
      await Promise.race([entered, worker.then(() => { throw Error("Worker did not enter its exact paid-session read"); })]);
      const preparing = await readConfirmationOrigin(id, f.runtime); assert.ok(preparing);
      assert.equal(preparing.row.state, "preparing"); assert.equal(preparing.row.phase, "awaiting_payment");
      if (closed) redis.run(["SET", `nl:order-confirmation:closed:${f.store.statsId}`, "closure before URL gate"]);
      const opened = await openConfirmationOrigin(id, f.runtime);
      assert.deepEqual(opened, closed ? null : checkout);
      assert.equal((await readConfirmationOrigin(id, f.runtime))?.raw, preparing.raw, "URL view never steals worker owner or renews its lease");
      assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
    } finally { release(); await worker; }
  }
});


for (const [name, make] of [["checkout fixture", fixture], ["paid worker fixture", physicalPaidFixture]] as const) {
  test(`${name} captures one URL acknowledgement timestamp even when every clock read advances1ms`, async () => {
    const original = Object.getOwnPropertyDescriptor(Date, "now")!;
    const epoch = Math.floor(Date.now() / 1000) * 1000 + 100;
    let reads = 0;
    try {
      Object.defineProperty(Date, "now", { configurable: true, value: () => epoch + reads++ });
      const f = await make();
      const acknowledgements: string[][] = [], pipeline = f.runtime.pipeline!;
      f.runtime.pipeline = async commands => {
        const answer = await pipeline(commands);
        if (commands[0]?.[0] === "EVAL" && commands[0]?.[13] === "url") {
          acknowledgements.push((answer as string[][])[0]);
        }
        return answer;
      };
      let checkout: { id: string; url: string } | null = null;
      await assert.doesNotReject(async () => { checkout = await createCheckout(f.store, f.product, "https://example.test", undefined, {}, f.runtime); });
      assert.ok(checkout);
      assert.deepEqual(await openConfirmationOrigin(originId(), f.runtime), checkout);
      assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
      assert.equal(acknowledgements.length, 2);
      for (const ack of acknowledgements) assert.equal(Number(ack[5]) - Number(ack[4]), 1000, "the fake must capture one Redis TIME equivalent, just like the actual Lua");
      assert.ok(reads > 1);
    } finally {
      Object.defineProperty(Date, "now", original);
    }
  });
}
