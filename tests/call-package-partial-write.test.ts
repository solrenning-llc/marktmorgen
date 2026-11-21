/**
 * A package purchase whose writes stop half way (a lost Redis reply, a failed
 * token write, an answer that is neither "OK" nor null) must still end with a
 * working booking link and one confirmation email on the next call, or refuse.
 * Found by Claude 4 (proofs/c4-sweeps/stripehand/p2-package-partial.proof.ts)
 * and confirmed by Claude 5 and Claude 1 on #2617. Synthetic Redis and SES only.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { boughtByToken, packageKeys, readBought, recordPackage } from "@/lib/call-packages";
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
  await assert.rejects(recordPackage(input(id)), (error: unknown) => error instanceof Error && (
    /package.*could not be confirmed/i.test(error.message) ||
    (error.name === "UnknownReplyError" && error.message === "Redis answered an order's write: a command's reply in an unknown shape")
  ));
  redis.pipeline = real;
  assert.equal(await readBought(id), null, "an unknown reply does not certify a purchase record");
  assert.equal(mail.ses.length, 0);
});

test("two repairs of one recorded package share the token claim and send one confirmation", async () => {
  const id = "cs_test_pkgpartial000000005";
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const reply = await real(commands);
    if (mentions(commands, `nl:pkg:${id}`) && mentions(commands, "NX")) throw new Error("synthetic: record acknowledgement lost");
    return reply;
  }) as typeof redis.pipeline;
  await assert.rejects(recordPackage(input(id)), /acknowledgement lost/);
  redis.pipeline = real;
  const [first, second] = await Promise.all([recordPackage(input(id)), recordPackage(input(id))]);
  assert.ok(first && second);
  assert.equal(first.token, second.token);
  assert.equal((await boughtByToken(first.token))?.checkout, id);
  assert.equal(mail.ses.length, 1);
});

test("a token pointing to another checkout is unknown, never a completed purchase repair", async () => {
  const id = "cs_test_pkgpartial000000006";
  const bought = await recordPackage(input(id));
  assert.ok(bought);
  const key = packageKeys(id, bought.token)[2];
  const other = "cs_test_pkgpartial000000007";
  await real([["SET", key, other]]);
  await assert.rejects(recordPackage(input(id)), /package.*could not be confirmed/i);
  assert.equal(redis.run(["GET", key]), other, "an inconsistent token is not overwritten");
  assert.equal(mail.ses.length, 1, "no extra confirmation is sent");
});

// Codex X6's LOWs on #2617 (7052207176): the token marks the link stored, and the email has its own durable mark.
test("the token's write lands but its reply is lost: the next call still sends the one confirmation", async () => {
  const id = "cs_test_pkgpartial000000008";
  let lose = true;
  redis.pipeline = (async (c: (string | number)[][]) => {
    const reply = await real(c);
    if (lose && mentions(c, "nl:pkg:t:") && mentions(c, "NX")) { lose = false; throw new Error("synthetic: token acknowledgement lost"); }
    return reply;
  }) as typeof redis.pipeline;
  await assert.rejects(recordPackage(input(id)), /acknowledgement lost/);
  redis.pipeline = real;
  assert.equal(mail.ses.length, 0, "nothing sent before the token was confirmed");
  const again = await recordPackage(input(id));
  assert.ok(again && await boughtByToken(again.token), "the booking link works");
  assert.equal(mail.ses.length, 1, "the buyer gets the confirmation");
});

test("no retry, reload or sweep after the provider's idempotency window sends it or charges the allowance again", async () => {
  const id = "cs_test_pkgpartial000000009";
  const bought = await recordPackage(input(id));
  assert.ok(bought);
  assert.equal(mail.ses.length, 1);
  // The token's record lost (as after a repair), and a day and more later: the provider no longer dedupes the key.
  await real([["DEL", packageKeys(id, bought.token)[2]]]);
  const reserved: (string | number)[][] = [];
  redis.pipeline = (async (c: (string | number)[][]) => {
    for (const command of c) if (command.some((part) => /^nl:mail:/.test(String(part)))) reserved.push(command);
    return real(c);
  }) as typeof redis.pipeline;
  const realNow = Date.now;
  Date.now = () => realNow() + 26 * 3_600_000;
  try {
    for (let i = 0; i < 3; i += 1) assert.ok(await recordPackage(input(id)));
  } finally { Date.now = realNow; redis.pipeline = real; }
  assert.equal(mail.ses.length, 1, "still exactly one email");
  assert.deepEqual(reserved.filter((c) => /^(INCRBY|INCR|EVAL)$/.test(String(c[0]))), [], "no email allowance taken again");
});

test("a claim of the email answered in another shape sends nothing; the next call reads the mark again", async () => {
  const id = "cs_test_pkgpartial000000010";
  let odd = true;
  redis.pipeline = (async (c: (string | number)[][]) => {
    if (odd && mentions(c, `nl:pkg:${id}:sent`)) { odd = false; return [[0, "QUEUED"]] as never; }
    return real(c);
  }) as typeof redis.pipeline;
  await assert.rejects(recordPackage(input(id)));
  redis.pipeline = real;
  assert.equal(mail.ses.length, 0, "an unknown claim sends nothing");
  assert.ok(await recordPackage(input(id)));
  assert.equal(mail.ses.length, 1, "the next call claims and sends once");
});
