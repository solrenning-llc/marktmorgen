import { NextRequest } from "next/server";
import { mock } from "node:test";
import { GET, maxDuration } from "@/app/api/cron/mail-check/route";
import { control } from "./mail-check-route-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const oldFetch = globalThis.fetch;
const realNow = Date.now;
const oldPipeline = redis.pipeline;
const commands: (string | number)[][] = [];
const LAST = "nl:mail-check:last";
const LOCK = "nl:mail-check:lock";
let rejectSave = false;
let beforeLock: (() => Promise<void>) | null = null;
const request = () => new NextRequest("https://example.test/api/cron/mail-check");

function reset(previous?: string): void {
  redis.clear();
  commands.length = 0;
  control.allowed = true; control.sender = true; control.deliveryOk = true; control.throwLoop = false; control.throwAccount = false;
  control.calls.length = 0; control.notices.length = 0; control.deadlines.length = 0; control.cutoffRoom.length = 0;
  control.afterUsage = null; control.afterAccount = null;
  rejectSave = false;
  beforeLock = null;
  if (previous !== undefined) redis.run(["SET", LAST, previous]);
}

async function main(): Promise<void> {
  globalThis.fetch = async () => { throw new Error("No real network request belongs in a route orchestration test"); };
  redis.pipeline = async (batch) => {
    commands.push(...batch.map(command => [...command]));
    if (batch.some(command => command[0] === "SET" && command[1] === LOCK)) await beforeLock?.();
    if (rejectSave && batch.some(command => command[0] === "SET" && command[1] === LAST)) {
      throw new Error("synthetic result persistence failure");
    }
    return oldPipeline(batch);
  };

  part("Missing usage evidence is persisted without changing delivery status or sending a notice");
  reset(JSON.stringify({ ok: true, usage: { ses: { ok: false, reason: "provider" } } }));
  const response = await GET(request());
  const body = await response.json();
  is("the existing delivery checks still pass", [response.status, body.ok, body.checks.every((check: { ok: boolean }) => check.ok)], [200, true, true]);
  is("provider observations remain a separate response field", body.usage, control.usage);
  is("usage failures never add a delivery check or notice",
    [body.checks.length, control.notices.length, control.calls.filter(call => call === "loop").length], [3, 0, 1]);
  const saved = JSON.parse(String(redis.run(["GET", LAST])));
  is("the same last-result record retains the report and top-level delivery result", [saved.ok, saved.usage], [true, control.usage]);
  is("the existing retention remains 30 days",
    commands.some(command => command[0] === "SET" && command[1] === LAST && command[3] === "EX" && command[4] === 30 * 86_400), true);
  is("the lock is released after success", redis.run(["GET", LOCK]), null);
  is("the response cannot be cached", response.headers.get("cache-control"), "no-store");

  part("Only a strict top-level historical false triggers the existing recovery notice");
  for (const previous of [
    "{broken", JSON.stringify([{ ok: false }]), JSON.stringify({ ok: "false" }),
    JSON.stringify({ usage: { ok: false } }), JSON.stringify({ ok: true, detail: 'a string containing "ok":false' }),
  ]) {
    reset(previous);
    const got = await GET(request());
    is("nested, malformed or non-boolean history is not an earlier delivery failure", [got.status, control.notices.length], [200, 0]);
  }
  reset(JSON.stringify({ ok: false, usage: control.usage }));
  await GET(request());
  is("a real earlier delivery failure sends exactly the existing recovery notice",
    control.notices.map(notice => notice.subject), ["Mail check: all passing again"]);
  is("the recovery notice contains delivery checks and no new usage alert",
    control.notices[0].text.includes("provider_reported_counters"), false);
  reset(JSON.stringify({ ok: true }));
  control.deliveryOk = false;
  const failed = await GET(request());
  is("an actual delivery failure still fails and sends its existing notice",
    [(await failed.json()).ok, control.notices.length, control.notices[0].subject.startsWith("Mail check failed:")], [false, 1, true]);
  reset();
  control.throwLoop = true;
  const thrown = await GET(request());
  is("an orchestration error remains a delivery failure and releases its lock",
    [(await thrown.json()).ok, redis.run(["GET", LOCK])], [false, null]);

  part("Account readiness precedes parallel collection and the full delivery window");
  reset();
  const anchor = realNow();
  let passed = 0;
  let loopStartedBeforeUsageFinished = false;
  Date.now = () => anchor + passed;
  control.afterAccount = () => { passed = 10_000; };
  control.afterUsage = () => {
    loopStartedBeforeUsageFinished = control.deadlines.length === 1;
    passed += 30_000;
  };
  const budgeted = await GET(request());
  is("the platform allowance remains 180 seconds", maxDuration, 180);
  is("a slow account check still leaves the loop its full 100 seconds",
    [budgeted.status, control.deadlines, control.cutoffRoom],
    [200, [anchor + 110_000], [150_000]]);
  is("the 30-second collector finishes after the loop has already started", loopStartedBeforeUsageFinished, true);
  is("account readiness warms credentials before one collection and one existing delivery run",
    control.calls.filter(call => ["account", "usage", "loop"].includes(call)), ["account", "usage", "loop"]);
  Date.now = realNow;

  part("A bounded cold account sequence keeps the full delivery window after a slow lock");
  reset();
  const coldAnchor = realNow();
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: coldAnchor });
  let lockReached!: () => void;
  let coldAccountReached!: () => void;
  const lockStarted = new Promise<void>(resolve => { lockReached = resolve; });
  const coldAccountStarted = new Promise<void>(resolve => { coldAccountReached = resolve; });
  beforeLock = async () => { lockReached(); await new Promise<void>(resolve => setTimeout(resolve, 5_000)); };
  control.afterAccount = async () => {
    coldAccountReached();
    // Redis read/write and the two AWS requests can take 26 seconds in total.
    await new Promise<void>(resolve => setTimeout(resolve, 26_000));
  };
  const coldRun = GET(request());
  await lockStarted;
  mock.timers.tick(5_000);
  await coldAccountStarted;
  mock.timers.tick(26_000);
  const coldResponse = await coldRun;
  is("an account sequence within its own service limits does not create a false failure",
    [coldResponse.status, (await coldResponse.json()).ok, control.notices.length], [200, true, 0]);
  is("five seconds for the lock and 26 for the account still leave 100 seconds for delivery",
    [control.deadlines, control.cutoffRoom], [[coldAnchor + 131_000], [129_000]]);
  mock.timers.reset();

  part("Account and usage barriers prove parallel work and complete result persistence");
  const previousResult = JSON.stringify({ ok: true, at: 1 });
  reset(previousResult);
  let accountReached!: () => void;
  let releaseAccount!: () => void;
  let usageReached!: () => void;
  let releaseUsage!: () => void;
  const accountStarted = new Promise<void>(resolve => { accountReached = resolve; });
  const accountWait = new Promise<void>(resolve => { releaseAccount = resolve; });
  const usageStarted = new Promise<void>(resolve => { usageReached = resolve; });
  const usageWait = new Promise<void>(resolve => { releaseUsage = resolve; });
  control.afterAccount = async () => { accountReached(); await accountWait; };
  control.afterUsage = async () => { usageReached(); await usageWait; };
  const pending = GET(request());
  await accountStarted;
  is("usage and delivery wait for account verification to finish", control.calls, ["authorize", "token", "account"]);
  releaseAccount();
  await usageStarted;
  is("delivery starts while the independent collector is still pending",
    control.calls.filter(call => ["account", "usage", "loop"].includes(call)), ["account", "usage", "loop"]);
  is("an unfinished observation does not replace the earlier result", redis.run(["GET", LAST]), previousResult);
  releaseUsage();
  const complete = await pending;
  const completeBody = await complete.json();
  const completeSaved = JSON.parse(String(redis.run(["GET", LAST])));
  is("response and saved delivery checks and usage are identical after both finish",
    [completeSaved.ok, completeSaved.checks, completeSaved.usage],
    [completeBody.ok, completeBody.checks, completeBody.usage]);

  part("A failed save never claims a recorded proof or sends a recovery notice");
  const failedHistory = JSON.stringify({ ok: false, at: 2 });
  reset(failedHistory);
  rejectSave = true;
  const unsaved = await GET(request());
  is("the unavailable save fails the route instead of claiming success",
    [unsaved.status, await unsaved.json(), unsaved.headers.get("cache-control")],
    [503, { ok: false, error: "unavailable" }, "no-store"]);
  is("failed persistence preserves history, sends no notice and releases the lock",
    [redis.run(["GET", LAST]), control.notices.length, redis.run(["GET", LOCK])],
    [failedHistory, 0, null]);

  part("An account-check exception still collects independent usage without pretending delivery passed");
  reset();
  control.throwAccount = true;
  const failedAccount = await GET(request());
  const failedAccountBody = await failedAccount.json();
  is("the account exception retains the failed delivery result and independent observations",
    [failedAccountBody.ok, failedAccountBody.usage, failedAccountBody.checks.map((check: { check: string; ok: boolean }) => [check.check, check.ok])],
    [false, control.usage, [["the run itself", false]]]);
  is("usage is collected once after an account exception, without starting an extra probe loop",
    control.calls.filter(call => ["account", "usage", "loop"].includes(call)), ["account", "usage"]);
  is("the existing failure notice and lock cleanup remain intact",
    [control.notices.length, redis.run(["GET", LOCK])], [1, null]);

  part("Authorization and the existing lock still prevent work");
  reset();
  control.allowed = false;
  const denied = await GET(request());
  is("an unauthorized request invokes no collector or delivery work", [denied.status, control.calls], [401, ["authorize"]]);
  reset();
  redis.run(["SET", LOCK, "other-run", "EX", 170]);
  const busy = await GET(request());
  is("a busy run does not collect, probe, notify or release the other lock",
    [await busy.json(), control.calls, redis.run(["GET", LOCK])], [{ ok: true, busy: true }, ["authorize"], "other-run"]);

  globalThis.fetch = oldFetch;
  redis.pipeline = oldPipeline;
  Date.now = realNow;
  done();
}
main().catch(error => {
  mock.timers.reset();
  globalThis.fetch = oldFetch; redis.pipeline = oldPipeline; Date.now = realNow;
  console.error(error); process.exit(1);
});
