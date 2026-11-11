/**
 * Idempotency-Key, unit 3: deleting a person from a store deletes at once every API answer kept about their address
 * (lib/api-idempotency.ts, forgetIdempotentPerson, through lib/person-erasure.ts). Synthetic stores only. Each part
 * fails on the wrong behavior it names: an answer about the deleted person left until it expires, another person's
 * answer deleted, another store's answer deleted, an unknown read taken as "nothing kept", and an answer kept where
 * an erasure could not find it.
 */
import { createHash } from "node:crypto";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { makeKey } from "@/lib/api-keys";
import { POST as postLead } from "@/app/api/v1/leads/route";
import { POST as postAccess } from "@/app/api/v1/access/route";
import { erasePerson } from "@/lib/person-erasure";
import { forgetIdempotentPerson } from "@/lib/api-idempotency";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }));
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${url}` } }), { status: 404 });
}) as typeof fetch;

const call = async (handler: (r: Request) => Promise<Response>, key: string, body: unknown, idem: string) => {
  const response = await handler(new Request("https://marktmorgen.com/api/v1/x", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": idem }, body: JSON.stringify(body) }));
  return { status: response.status, replayed: response.headers.get("Idempotent-Replayed") };
};
const record = (sid: string, key: string) => `nl:api:idem:${sid}:${createHash("sha256").update(key).digest("hex")}`;
const has = (key: string) => redis.keys().includes(key);

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
  return { owner, sid: store.sid!, key: writer.key, product: guide.product.id };
}

async function main(): Promise<void> {
  process.env.RESEND_API_KEY = "re_test_api_write_only_a_stand_in";
  redis.clear();
  const a = await shop("erase-owner-a@example.test", "eraseshopa");
  const b = await shop("erase-owner-b@example.test", "eraseshopb");
  const ADA = "ada-erase@example.test";
  const BO = "bo-erase@example.test";

  part("Keyed answers about two people, in two stores");
  is("all taken", [
    (await call(postAccess, a.key, { email: ADA, product: a.product }, "a-ada-access")).status,
    (await call(postLead, a.key, { email: "Ada-Erase@Example.test", agreed: true }, "a-ada-lead")).status,
    (await call(postAccess, a.key, { email: BO, product: a.product }, "a-bo-access")).status,
    (await call(postAccess, b.key, { email: ADA, product: b.product }, "b-ada-access")).status,
  ], [200, 200, 200, 200]);
  const kept = [record(a.sid, "a-ada-access"), record(a.sid, "a-ada-lead"), record(a.sid, "a-bo-access"), record(b.sid, "b-ada-access")];
  is("four answers kept", kept.map(has), [true, true, true, true]);

  part("Deleting the person from store A deletes their answers there at once, and nothing else");
  const storeA = (await storeForEmail(a.owner))!;
  const erased = await erasePerson(storeA, ADA, { kind: "person" });
  is("the erasure finished", erased.ok, true);
  is("Ada's two answers in store A are gone, an address written in other case included", [has(kept[0]), has(kept[1])], [false, false]);
  is("Bo's answer in store A stays", has(kept[2]), true);
  is("Ada's answer in store B stays: another store's", has(kept[3]), true);
  is("pressed again, nothing more is found", await forgetIdempotentPerson(a.sid, ADA), 0);
  is("a repeat of Ada's request now runs again, never replays her old answer", (await call(postAccess, a.key, { email: ADA, product: a.product }, "a-ada-access")).replayed, null);

  part("An unknown read is never 'nothing kept'");
  const real = redis.pipeline.bind(redis);
  const shapes: unknown[] = [[{ weird: true }], [["ok", 7]], null, []];
  const thrown: boolean[] = [];
  for (const reply of shapes) {
    (redis as unknown as { pipeline: typeof real }).pipeline = async (commands) => (commands[0]?.[0] === "SMEMBERS" ? (reply as unknown[]) : real(commands));
    thrown.push(await forgetIdempotentPerson(a.sid, BO).then(() => false, () => true));
  }
  (redis as unknown as { pipeline: typeof real }).pipeline = real;
  is("each reply of another shape throws, so the erasure is pressed again rather than said done", thrown, [true, true, true, true]);
  is("and Bo's answer was not touched by any of them", has(kept[2]), true);

  part("An answer is kept only where an erasure can find it");
  const original = redis.pipeline.bind(redis);
  // The person's index cannot be written: the answer must not be kept (the claim stays, a repeat is told 409).
  (redis as unknown as { pipeline: typeof original }).pipeline = async (commands) => commands.some((c) => c[0] === "SADD") ? [null, null] : original(commands);
  const noIndex = await call(postAccess, a.key, { email: "cy-erase@example.test", product: a.product }, "a-cy-access");
  (redis as unknown as { pipeline: typeof original }).pipeline = original;
  const again = await call(postAccess, a.key, { email: "cy-erase@example.test", product: a.product }, "a-cy-access");
  is("the write ran once; its answer was not kept, and the repeat is told 409, not run again", [noIndex.status, again.status, again.replayed], [200, 409, null]);

  done();
}

void main();
