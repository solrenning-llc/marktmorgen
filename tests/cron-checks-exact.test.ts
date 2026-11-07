/**
 * The daily mail and Stripe checks read Redis only in its exact shape (rule 24).
 *
 *   - Amazon set up, but its state read back in an unknown shape, is a failed
 *     check, never "Amazon is not set up" passing (lib/verify-mail.ts).
 *   - The run locks themselves are #2986's (claimMark/releaseMark in every
 *     cron); only the busy and healthy controls are kept here, and they hold
 *     on either shape of the lock.
 *   - A previous result read back in an unknown shape is not an earlier pass:
 *     no "passing again" is claimed, and the run says in its log that it
 *     could not tell.
 * Synthetic data only; the senders and Stripe are stood in for
 * (tests/cron-checks-exact-world.ts).
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { GET as mailCheck } from "@/app/api/cron/mail-check/route";
import { GET as stripeCheck } from "@/app/api/cron/stripe-check/route";
import { verifyMailLoop } from "@/lib/verify-mail";
import { world } from "./cron-checks-exact-world";
import { store as redis } from "./redis-stub";

delete process.env.CRON_SECRET;
process.env.STRIPE_DEMO_SECRET_KEY = "sk_test_synthetic_cron_checks";
globalThis.fetch = async () => { throw new Error("no real network request belongs in this test"); };

const original = redis.pipeline;
const commands: (string | number)[][] = [];
/** Replaces the whole pipeline reply for a batch whose first command matches. */
let tamper: ((command: (string | number)[]) => unknown) | null = null;
redis.pipeline = async (batch) => {
  commands.push(...batch.map((command) => [...command]));
  const replaced = tamper?.(batch[0]);
  if (replaced !== undefined) return replaced as unknown[];
  return original(batch);
};

const logged: string[] = [];
for (const level of ["log", "error"] as const) {
  console[level] = (...parts: unknown[]) => { logged.push(parts.map(String).join(" ")); };
}

function reset(): void {
  redis.clear();
  commands.length = 0;
  logged.length = 0;
  tamper = null;
  world.fakeLoop = true; world.checksOk = true;
  world.ran.length = 0; world.notices.length = 0;
}

const routes = [
  { name: "mail-check", run: mailCheck, lock: "nl:mail-check:lock", last: "nl:mail-check:last", again: "Mail check: all passing again" },
  { name: "stripe-check", run: stripeCheck, lock: "nl:stripe-check:lock", last: "nl:stripe-check:last", again: "Stripe check: all passing again" },
] as const;
const request = (name: string) => new NextRequest(`https://example.test/api/cron/${name}`);
const MALFORMED: [string, unknown][] = [
  ["no reply", []], ["an undefined slot", [undefined]], ["a number", [1]], ["another word", ["QUEUED"]],
  ["two replies", ["OK", "OK"]], ["a bare string", "OK"], ["not a list", { 0: "OK" }],
];

for (const route of routes) {
  test(`${route.name}: a lock another run holds (SET NX null) is busy, and stays theirs`, async () => {
    reset();
    redis.run(["SET", route.lock, "theirs"]);
    const response = await route.run(request(route.name));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, busy: true });
    assert.deepEqual(world.ran, []);
    assert.equal(redis.run(["GET", route.lock]), "theirs");
  });

  test(`${route.name}: an exact OK runs the checks and lets the lock go`, async () => {
    reset();
    const response = await route.run(request(route.name));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    assert.ok(world.ran.length > 0);
    assert.equal(redis.run(["GET", route.lock]), null);
    assert.deepEqual(world.notices, []);
  });

  for (const [label, reply] of MALFORMED.filter(([, r]) => !(Array.isArray(r) && r.length === 1 && typeof r[0] === "string"))) {
    test(`${route.name}: a previous result answered with ${label} is unknown — no "passing again", and it is logged`, async () => {
      reset();
      redis.run(["SET", route.last, JSON.stringify({ ok: false })]);
      tamper = (command) => (command[0] === "GET" && command[1] === route.last ? reply : undefined);
      const response = await route.run(request(route.name));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).ok, true);
      assert.deepEqual(world.notices, [], "no recovery is claimed on unknown history");
      assert.ok(logged.some((line) => line.includes(route.name) && line.includes("previous result could not be read")), "the possible recovery is not dropped silently");
      assert.equal(JSON.parse(String(redis.run(["GET", route.last]))).ok, true, "today's result is still kept");
    });

    test(`${route.name}: a failure is still reported when the previous result (${label}) is unknown`, async () => {
      reset();
      world.checksOk = false;
      tamper = (command) => (command[0] === "GET" && command[1] === route.last ? reply : undefined);
      const response = await route.run(request(route.name));
      assert.equal((await response.json()).ok, false);
      assert.equal(world.notices.length, 1);
      assert.notEqual(world.notices[0], route.again);
    });
  }

  test(`${route.name}: a readable earlier failure still sends "passing again"`, async () => {
    reset();
    redis.run(["SET", route.last, JSON.stringify({ ok: false })]);
    await route.run(request(route.name));
    assert.deepEqual(world.notices, [route.again]);
    assert.equal(logged.some((line) => line.includes("previous result could not be read")), false);
  });

  test(`${route.name}: no previous result (GET null) is a first run: nothing sent, nothing unknown`, async () => {
    reset();
    await route.run(request(route.name));
    assert.deepEqual(world.notices, []);
    assert.equal(logged.some((line) => line.includes("previous result could not be read")), false);
  });
}

const SES_ENV = {
  AWS_SES_ROLE_ARN: "arn:aws:iam::123456789012:role/synthetic-cron-checks",
  AWS_SES_REGION: "us-east-1",
  AWS_SES_CONFIGURATION_SET: "marktmorgen",
  AWS_SES_TOPIC_ARN: "arn:aws:sns:us-east-1:123456789012:synthetic-cron-checks",
};
const amazonLoop = async () => (await verifyMailLoop(Date.now() + 1_000)).find((check) => check.check === "Amazon SES's loop");

for (const [label, reply] of [["no reply", []], ["two replies", [null, null]], ["not a list", "x"], ["a hole", [, ]]] as [string, unknown][]) {
  test(`verifyMailLoop: Amazon set up but its state answered with ${label} fails, never "not set up"`, async () => {
    reset();
    world.fakeLoop = false;
    Object.assign(process.env, SES_ENV);
    tamper = (command) => (command[0] === "GET" && command[1] === "nl:ses:state" ? reply : undefined);
    try {
      const amazon = await amazonLoop();
      assert.equal(amazon?.ok, false);
      assert.doesNotMatch(amazon?.detail ?? "", /not set up/);
    } finally {
      for (const name of Object.keys(SES_ENV)) delete process.env[name];
    }
  });
}

test("verifyMailLoop: Amazon not set up is still not checked, and not failed", async () => {
  reset();
  world.fakeLoop = false;
  const amazon = await amazonLoop();
  assert.deepEqual(amazon, { check: "Amazon SES's loop", ok: true, detail: "not checked: Amazon is not set up" });
});

test("verifyMailLoop: Amazon set up and read, but not sending yet, is still not checked", async () => {
  reset();
  world.fakeLoop = false;
  Object.assign(process.env, SES_ENV);
  try {
    const amazon = await amazonLoop();
    assert.equal(amazon?.ok, true);
    assert.match(amazon?.detail ?? "", /^not checked: Amazon is not sending yet/);
  } finally {
    for (const name of Object.keys(SES_ENV)) delete process.env[name];
  }
});
