/**
 * The Idempotency-Key header on POST /api/v1/access and POST /api/v1/leads (lib/api-idempotency.ts), through the real
 * routes, keys and store against the in-memory Redis and a stubbed email provider. Synthetic stores only. Each part
 * fails on the wrong behavior it names: a repeat that gives a product or sends its email again, a repeat that adds the
 * person again, the same key used for another request taken, a write run while another try holds the key, an unknown
 * record taken for "none", a refusal that holds its key, a key shared across stores, a record kept past 24 hours, and
 * a request without the header that behaves differently from before.
 */
import { createHash } from "node:crypto";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { makeKey } from "@/lib/api-keys";
import { importedFor } from "@/lib/imported-purchases";
import { POST as postLead } from "@/app/api/v1/leads/route";
import { POST as postAccess } from "@/app/api/v1/access/route";
import { IDEMPOTENCY_SECONDS } from "@/lib/api-idempotency-rules";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const emails: unknown[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: `email_${emails.length}` }));
  }
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${url}` } }), { status: 404 });
}) as typeof fetch;

type Call = { status: number; replayed: string | null; json: { error?: string; message?: string; data?: Record<string, unknown> } };
const call = async (handler: (r: Request) => Promise<Response>, key: string, body: unknown, idem?: string, raw?: string): Promise<Call> => {
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  if (idem !== undefined) headers["Idempotency-Key"] = idem;
  const response = await handler(new Request("https://marktmorgen.com/api/v1/x", { method: "POST", headers, body: raw ?? JSON.stringify(body) }));
  return { status: response.status, replayed: response.headers.get("Idempotent-Replayed"), json: await response.json() };
};
const records = () => [...redis.keys()].filter((k) => k.startsWith("nl:api:idem:"));

async function shop(owner: string, handle: string) {
  await claimHandle(owner, handle, "Synthetic Kitchen", "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, period: paidPeriod() });
  const guide = await addProduct(owner, "The Guide", "", "12", null);
  if (!guide.ok) throw new Error("no product");
  await setProductLink(owner, guide.product.id, "https://example.test/guide");
  const store = (await storeForEmail(owner))!;
  const writer = await makeKey(store.sid!, "Zapier", Date.now(), true);
  if (!writer.ok) throw new Error("no key");
  return { store, key: writer.key, product: guide.product.id };
}

async function main(): Promise<void> {
  process.env.RESEND_API_KEY = "re_test_api_write_only_a_stand_in";
  redis.clear();
  const a = await shop("idem-owner-a@example.test", "idemshopa");
  const give = { email: "buyer-one@example.test", product: a.product, notify: true };
  const KEY = "8e03978e-40d5-43e8-bc93-6894a57f9324";

  part("Without the header nothing changes");
  const plain1 = await call(postAccess, a.key, give);
  const plain2 = await call(postAccess, a.key, give);
  is("given, then already held, as before", [plain1.status, plain1.json.data?.status, plain2.json.data?.status, plain2.replayed], [200, "given", "already", null]);
  is("nothing kept for it", records().length, 0);
  const emailsBefore = emails.length;

  part("With a key: a repeat gives the first answer back and gives nothing again");
  const give2 = { email: "buyer-two@example.test", product: a.product, notify: true };
  const first = await call(postAccess, a.key, give2, `"${KEY}"`);
  const again = await call(postAccess, a.key, give2, KEY);
  is("the first is given, the repeat is the same answer, marked replayed", [first.status, first.json.data, again.status, again.json.data, again.replayed], [200, first.json.data, 200, first.json.data, "true"]);
  is("the first answer said given (not already)", first.json.data?.status, "given");
  is("one email only", emails.length - emailsBefore, 1);
  is("one grant only", (await importedFor((await storeForEmail("idem-owner-a@example.test"))!, "buyer-two@example.test")).filter((g) => g.productId === a.product).length, 1);
  is("the same JSON with other spacing is the same request", (await call(postAccess, a.key, null, KEY, ` { "email" : "buyer-two@example.test", "product": "${a.product}", "notify": true } `)).replayed, "true");
  // The store's id is in the name as in every other store key (nl:api:keys:<sid>): no store value is hashed, and the
  // key the client sent is only ever in it as a hash (CodeQL js/insufficient-password-hash on #3537).
  is("one record, its name saying the store and never the key", [records().length, records()[0].includes(KEY), records()[0] === `nl:api:idem:${a.store.sid}:${createHash("sha256").update(KEY).digest("hex")}`], [1, false, true]);

  part("The same key for another request: 422, nothing given");
  const other = await call(postAccess, a.key, { ...give2, email: "buyer-three@example.test" }, KEY);
  is("refused with the reason", [other.status, other.json.error, String(other.json.message).includes("different request")], [422, "idempotency_key", true]);
  is("the same key on the list endpoint is another request too", (await call(postLead, a.key, { email: "buyer-two@example.test", agreed: true }, KEY)).status, 422);
  is("nothing given to the third address", (await importedFor((await storeForEmail("idem-owner-a@example.test"))!, "buyer-three@example.test")).length, 0);

  part("A key held by a try still running: 409, nothing run");
  const held = "held-key-0001";
  await call(postAccess, a.key, { email: "buyer-four@example.test", product: a.product }, held);
  // The test makes the second key's record look as if its write were still under way.
  const pendingKey = `nl:api:idem:${a.store.sid}:${createHash("sha256").update(held).digest("hex")}`;
  is("its record is where the key says", records().includes(pendingKey), true);
  const raw = await redis.pipeline([["GET", pendingKey]]) as unknown[];
  const parsed = JSON.parse(String(raw[0])) as { fp: string; at: number };
  await redis.pipeline([["SET", pendingKey, JSON.stringify({ state: "pending", fp: parsed.fp, at: parsed.at }), "EX", 3600]]);
  const busy = await call(postAccess, a.key, { email: "buyer-four@example.test", product: a.product }, held);
  is("told it is still being processed", [busy.status, busy.json.error], [409, "idempotency_key"]);
  is("given once only", (await importedFor((await storeForEmail("idem-owner-a@example.test"))!, "buyer-four@example.test")).length, 1);

  part("An unknown record runs nothing");
  await redis.pipeline([["SET", pendingKey, "not a record", "EX", 3600]]);
  const unknown = await call(postAccess, a.key, { email: "buyer-four@example.test", product: a.product }, held);
  is("503, try again with the same key", [unknown.status, unknown.json.error], [503, "unavailable"]);

  part("A refusal changed nothing, so its key is let go");
  const lost = "refused-key-01";
  const refused = await call(postAccess, a.key, { email: "buyer-five@example.test", product: "no-such-product" }, lost);
  is("refused by the route's own check", refused.status >= 400 && refused.status < 500, true);
  const fixed = await call(postAccess, a.key, { email: "buyer-five@example.test", product: a.product }, lost);
  is("the same key then runs the fixed request", [fixed.status, fixed.json.data?.status, fixed.replayed], [200, "given", null]);

  part("A header that is not a key is refused before any work");
  const bad = await call(postAccess, a.key, { email: "buyer-six@example.test", product: a.product }, "k".repeat(256));
  is("400 with what a key must be", [bad.status, bad.json.error], [400, "idempotency_key"]);
  is("nothing given", (await importedFor((await storeForEmail("idem-owner-a@example.test"))!, "buyer-six@example.test")).length, 0);

  part("Two tries at once: one runs, the other runs nothing");
  const both = await Promise.all([1, 2].map(() => call(postAccess, a.key, { email: "buyer-seven@example.test", product: a.product, notify: true }, "same-time-key-1")));
  const ran = both.filter((r) => r.status === 200 && r.replayed === null).length;
  is("exactly one ran; the other was told 409 or got its answer", [ran, both.filter((r) => r.status === 409 || r.replayed === "true").length], [1, 1]);

  part("The list: a repeat adds nobody again");
  const lead = { email: "reader-one@example.test", name: "Reader", agreed: true };
  const l1 = await call(postLead, a.key, lead, "lead-key-0001");
  const l2 = await call(postLead, a.key, lead, "lead-key-0001");
  is("added once; the repeat is the same answer, replayed", [l1.json.data?.status, l2.json.data?.status, l2.replayed], ["added", "added", "true"]);

  part("Keys are the store's own");
  const b = await shop("idem-owner-b@example.test", "idemshopb");
  const bFirst = await call(postAccess, b.key, { email: "buyer-two@example.test", product: b.product }, KEY);
  is("another store's request under the same key string runs, as its own", [bFirst.status, bFirst.json.data?.status, bFirst.replayed], [200, "given", null]);

  part("Gone after 24 hours from when the write began");
  advance(IDEMPOTENCY_SECONDS * 1_000 + 1_000);
  const later = await call(postAccess, a.key, give2, KEY);
  is("the key is new again: the request runs (already held now), not replayed", [later.status, later.json.data?.status, later.replayed], [200, "already", null]);

  done();
}

void main();
