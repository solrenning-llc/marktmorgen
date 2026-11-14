/**
 * #3542 (Codex X5, MÉDIO; the coordinator's decision of 13/11/2026 14h09 for a deployment without the secret): the
 * person's index of kept API answers is named only by a keyed HMAC (lib/api-idempotency.ts personIndexName). Without
 * the server's secret (no NIMBUS_DATA_KEY and no Stripe key to derive one from), it is never written, not even under
 * an unkeyed hash, and no answer about a person is kept, so a person's erasure has nothing left to find and is never
 * held up: forgetIdempotentPerson and idempotentLines answer 0 without a read. An answer about nobody is kept as
 * always. The in-memory Redis only.
 */
import { createHash } from "node:crypto";
import { forgetIdempotentPerson, idempotentLines, onceForKey, personIndexName } from "@/lib/api-idempotency";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const SID = "a".repeat(32);
const ADA = "ada.nokey@example.test";

const write = (key: string, person?: string) =>
  onceForKey(
    new Request("https://marktmorgen.com/api/v1/leads", { method: "POST", headers: { "Idempotency-Key": key } }),
    SID,
    "/api/v1/leads",
    { email: person ?? "" },
    2_000,
    async () => ({ response: Response.json({ ok: true }), effect: "done" }),
    person,
  );
const records = () => redis.keys().filter((k) => k.startsWith("nl:api:idem:") && !k.startsWith("nl:api:idem:p:"));
const indexes = () => redis.keys().filter((k) => k.startsWith("nl:api:idem:p:"));

async function main(): Promise<void> {
  redis.clear();
  delete process.env.NIMBUS_DATA_KEY;
  delete process.env.STRIPE_SECRET_KEY;

  part("Without the server's secret");
  is("the person's index has no name", personIndexName(SID, ADA), null);
  const first = await write("k-ada-1", ADA);
  is("the write itself answers", first.status, 200);
  is("no index is written, keyed or not", indexes(), []);
  is("no unkeyed hash of the address names anything", redis.keys().some((k) => k.endsWith(createHash("sha256").update(ADA).digest("hex"))), false);
  const repeat = await write("k-ada-1", ADA);
  is("the answer about her is not kept, so no erasure can miss it: a repeat is never given it back", repeat.headers.get("Idempotent-Replayed"), null);
  const kept = await redis.pipeline(records().map((k) => ["GET", k]));
  is("nothing kept holds her answer to give back", kept.every((v) => typeof v !== "string" || !v.includes('"ok":true')), true);
  let commands = 0;
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (c: (string | number)[][]) => { commands += c.length; return real(c); }) as typeof redis.pipeline;
  is("her erasure has nothing to delete and is never held up", [await forgetIdempotentPerson(SID, ADA), await idempotentLines(SID, ADA)], [0, 0]);
  is("and reads nothing to say so", commands, 0);
  redis.pipeline = real as typeof redis.pipeline;

  part("An answer about nobody is kept as always (control)");
  is("the write answers", (await write("k-nobody-1")).status, 200);
  const again = await write("k-nobody-1");
  is("the repeat is given the kept answer, marked replayed", [again.status, again.headers.get("Idempotent-Replayed")], [200, "true"]);

  part("With the secret, her index is named by a keyed HMAC (control)");
  process.env.NIMBUS_DATA_KEY = "tests-only-not-a-real-deployment-secret";
  const name = personIndexName(SID, ADA);
  is("named, never by the plain hash of her address", [typeof name, name?.endsWith(createHash("sha256").update(ADA).digest("hex"))], ["string", false]);
  done();
}

void main();
