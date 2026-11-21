/**
 * Idempotency-Key: a claim that is held (never kept as an answer) names nothing about the person (Claude 7's MÉDIO on
 * #3542, restated by Claude 4 in 6938014656 and by Codex N4 and X6). A held claim stays 24 hours as
 * {"state":"pending","fp":…} and is never listed in the person's index, so an erasure cannot find it; its fingerprint
 * must therefore be a keyed HMAC, never a plain SHA-256 of the method, the path and a body that says the address.
 * Synthetic store only. Fails on: a held claim whose fingerprint is the plain SHA-256 of the request, and a keyed
 * fingerprint that no longer tells the same request (409) from another body under the same key (422).
 */
import { createHash } from "node:crypto";
import { requestFingerprint } from "@/lib/api-idempotency-rules";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { makeKey } from "@/lib/api-keys";
import { POST as postAccess } from "@/app/api/v1/access/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }));
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${url}` } }), { status: 404 });
}) as typeof fetch;

const call = async (key: string, body: unknown, idem: string) => {
  const response = await postAccess(new Request("https://marktmorgen.com/api/v1/access", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": idem }, body: JSON.stringify(body) }));
  return response.status;
};
const record = (sid: string, key: string) => `nl:api:idem:${sid}:${createHash("sha256").update(key).digest("hex")}`;

async function main(): Promise<void> {
  process.env.RESEND_API_KEY = "re_test_api_write_only_a_stand_in";
  redis.clear();
  const owner = "held-claim-owner@example.test";
  await claimHandle(owner, "heldclaimshop", "Synthetic Kitchen", "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_heldclaim", subscriptionId: "sub_heldclaim", active: true, period: paidPeriod() });
  const guide = await addProduct(owner, "The Guide", "", "12", null);
  if (!guide.ok) throw new Error("no product");
  await setProductLink(owner, guide.product.id, "https://example.test/guide");
  const store = (await storeForEmail(owner))!;
  const writer = await makeKey(store.sid!, "Zapier", Date.now(), true);
  if (!writer.ok) throw new Error("no key");
  const sid = store.sid!;
  const ADA = "ada-held@example.test";
  const body = { email: ADA, product: guide.product.id };

  part("A claim held because the person's index could not be written");
  const original = redis.pipeline.bind(redis);
  (redis as unknown as { pipeline: typeof original }).pipeline = async (commands) => commands.some((c) => c[0] === "ZADD" && String(c[1]).startsWith("nl:api:idem:p:")) ? [null, null, null, null] : original(commands);
  try {
    is("the write itself is answered", await call(writer.key, body, "held-ada"), 200);
  } finally {
    (redis as unknown as { pipeline: typeof original }).pipeline = original;
  }
  const raw = (await redis.pipeline([["GET", record(sid, "held-ada")]]))[0];
  const held = JSON.parse(String(raw)) as { state: string; fp: string };
  is("the claim is held, not kept as an answer", held.state, "pending");
  const plain = requestFingerprint("POST", "/api/v1/access", JSON.stringify(body));
  is("its fingerprint is not the plain SHA-256 of a request that says her address: it could be matched offline", held.fp === plain, false);
  is("it is still a 64-hex fingerprint the record's reader accepts", /^[0-9a-f]{64}$/.test(held.fp), true);
  is("the held claim says no address", String(raw).includes("@"), false);

  part("The keyed fingerprint still tells the same request from another body");
  is("the same request with the same key is told it is being processed", await call(writer.key, body, "held-ada"), 409);
  is("another body with the same key is told it does not match", await call(writer.key, { email: "bo-held@example.test", product: guide.product.id }, "held-ada"), 422);

  done();
}

void main();
