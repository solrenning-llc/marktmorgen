/**
 * A package purchase whose writes stop half way (a lost Redis reply, a failed
 * token write, an answer that is neither "OK" nor null) must still end with a
 * working booking link and one confirmation email on the next call, or refuse.
 * Found by Claude 4 (proofs/c4-sweeps/stripehand/p2-package-partial.proof.ts)
 * and confirmed by Claude 5 and Claude 1 on #2617. Synthetic Redis and SES only.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { boughtByToken, readBought, recordPackage } from "@/lib/call-packages";
import { store as redis } from "@/tests/redis-stub";
import { installSesMailFixture } from "@/tests/ses-mail-fixture";
import type { Store } from "@/lib/store";
import type { Listing } from "@/lib/catalog";

const mail = installSesMailFixture({ fallback: () => new Response("{}", { status: 404 }) });
const store = { statsId: "pkg0stats0001", sid: "pkgsid0001", handle: "harbor", name: "Harbor", language: "en", email: "owner@example.com", currency: "usd" } as unknown as Store;
const product = { id: "prod00000002", title: "Three coaching calls", call: null } as unknown as Listing;
const session = (id: string) => ({
  id, status: "complete", payment_status: "paid", created: Math.floor(Date.now() / 1000), amount_total: 30000, currency: "usd",
  customer_details: { email: "buyer@example.com" }, metadata: { kind: "package", sessions: "3", days: "90", store: "harbor", product: product.id },
});
const input = (id: string) => ({ store, session: session(id) as Parameters<typeof recordPackage>[0]["session"], product, base: "https://example.com/@harbor", from: "Harbor <x@example.com>" });
const real = redis.pipeline.bind(redis);
const mentions = (c: (string | number)[][], text: string) => c.some((cmd) => cmd.some((x) => String(x).includes(text)));

beforeEach(async () => {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  mail.ses.length = 0;
});
afterEach(() => { redis.pipeline = real; });

test("control: a healthy purchase has a working link and one email", async () => {
  const bought = await recordPackage(input("cs_test_pkgpartial000000001"));
  assert.ok(bought);
  assert.ok(await boughtByToken(bought.token));
  assert.equal(mail.ses.length, 1);
});

test("the record's write lands but its reply is lost: the next call repairs the link and sends the email once", async () => {
  const id = "cs_test_pkgpartial000000002";
  redis.pipeline = (async (c: (string | number)[][]) => {
    const reply = await real(c);
    if (mentions(c, `nl:pkg:${id}`) && mentions(c, "NX")) throw new Error("Redis request timed out");
    return reply;
  }) as typeof redis.pipeline;
  await assert.rejects(recordPackage(input(id)), /timed out/);
  redis.pipeline = real;
  assert.ok(await readBought(id), "the record was kept");
  const again = await recordPackage(input(id));
  const sweep = await recordPackage(input(id));
  assert.ok(again && sweep);
  assert.deepEqual(sweep, again);
  assert.ok(await boughtByToken(again.token), "the booking link works");
  assert.equal(mail.ses.length, 1, "exactly one confirmation email");
});

test("the token's write fails after the record: the next call repairs the link and sends the email", async () => {
  const id = "cs_test_pkgpartial000000003";
  redis.pipeline = (async (c: (string | number)[][]) => {
    if (mentions(c, "nl:pkg:t:")) throw new Error("Redis request timed out");
    return real(c);
  }) as typeof redis.pipeline;
  await assert.rejects(recordPackage(input(id)));
  redis.pipeline = real;
  const again = await recordPackage(input(id));
  assert.ok(again);
  assert.ok(await boughtByToken(again.token), "the booking link works");
  assert.equal(mail.ses.length, 1, "exactly one confirmation email");
  assert.ok((await recordPackage(input(id)))?.token === again.token);
  assert.equal(mail.ses.length, 1, "a reload sends nothing more");
});

test("a record write answered with neither OK nor null is unknown: no link handed out, no email", async () => {
  const id = "cs_test_pkgpartial000000004";
  redis.pipeline = (async (c: (string | number)[][]) => {
    if (mentions(c, `nl:pkg:${id}`) && mentions(c, "NX")) return [[0, "QUEUED"]] as never;
    return real(c);
  }) as typeof redis.pipeline;
  await assert.rejects(recordPackage(input(id)), /package.*could not be confirmed/i);
  redis.pipeline = real;
  assert.equal(mail.ses.length, 0);
});
