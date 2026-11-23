/**
 * Issue #4147: the daily mail and Stripe checks answered HTTP 200 when a
 * required check failed, so a monitor that reads the status saw a failed
 * health check as a good run. A failed check keeps every side effect (the
 * saved result, the owner's notice, the status page's run, the lock let go)
 * and then answers a non-2xx status that names the failed checks. A passing
 * run still answers 200.
 * Synthetic data only; the senders and Stripe are stood in for
 * (tests/cron-checks-exact-world.ts).
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { GET as mailCheck } from "@/app/api/cron/mail-check/route";
import { GET as stripeCheck } from "@/app/api/cron/stripe-check/route";
import { STATUS_CHECKS } from "@/lib/status-page";
import { failedNames } from "@/lib/health-check-status";
import { world } from "./cron-checks-exact-world";
import { store as redis } from "./redis-stub";

delete process.env.CRON_SECRET;
process.env.STRIPE_DEMO_SECRET_KEY = "sk_test_synthetic_health_checks";
globalThis.fetch = async () => { throw new Error("no real network request belongs in this test"); };
for (const level of ["log", "error"] as const) console[level] = () => {};

function reset(): void {
  redis.clear();
  world.fakeLoop = true; world.checksOk = true;
  world.ran.length = 0; world.notices.length = 0;
}

const routes = [
  { name: "mail-check", run: mailCheck, lock: "nl:mail-check:lock", last: "nl:mail-check:last", status: STATUS_CHECKS[0].key },
  { name: "stripe-check", run: stripeCheck, lock: "nl:stripe-check:lock", last: "nl:stripe-check:last", status: STATUS_CHECKS[1].key },
] as const;
const request = (name: string) => new NextRequest(`https://example.test/api/cron/${name}`);
const statusRuns = (key: string) => (redis.run(["LRANGE", key, 0, -1]) as string[] | null) ?? [];

for (const route of routes) {
  test(`${route.name}: a failed required check answers a non-2xx status naming it, after every side effect`, async () => {
    reset();
    world.checksOk = false;
    const response = await route.run(request(route.name));
    const body = await response.json();
    assert.ok(response.status >= 500 && response.status < 600, `status ${response.status} is an error`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(body.ok, false);
    assert.ok(Array.isArray(body.checks) && body.checks.length > 0, "the individual checks are still in the answer");
    assert.ok(Array.isArray(body.failed) && body.failed.length > 0, "the failed checks are named");
    assert.deepEqual(body.failed, body.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { check: string }) => c.check));
    assert.equal(JSON.parse(String(redis.run(["GET", route.last]))).ok, false, "the result is still saved");
    assert.equal(world.notices.length, 1, "the owner's notice is still sent");
    assert.equal(JSON.parse(String(statusRuns(route.status)[0])).ok, false, "the status page's run is still kept, as failed");
    assert.equal(redis.run(["GET", route.lock]), null, "the lock is let go");
  });

  test(`${route.name}: a passing run still answers 200 with no failed list`, async () => {
    reset();
    const response = await route.run(request(route.name));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.failed, undefined);
  });

  test(`${route.name}: a busy run (another holds the lock) is still 200, not a failed check`, async () => {
    reset();
    redis.run(["SET", route.lock, "theirs"]);
    const response = await route.run(request(route.name));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, busy: true });
  });
}

// Claude 3 wtXk's NIT on #5472: the names said beside the error status, for a mixed run and for a run with no check.
test("failedNames names only the checks that failed, in order", () => {
  assert.deepEqual(failedNames([{ check: "a", ok: true }, { check: "b", ok: false }, { check: "c", ok: true }, { check: "d", ok: false }]), ["b", "d"]);
});
test("a run with no check at all is named as such, never an empty list beside the error", () => {
  assert.deepEqual(failedNames([]), ["no check ran"]);
});
