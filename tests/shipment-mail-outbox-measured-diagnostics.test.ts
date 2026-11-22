/**
 * The real-Redis shipment dispatch check (scripts/test_shipment_mail_outbox_redis.py, the form-opportunity-redis job)
 * bills a script step by the difference of two INFO COMMANDSTATS readings. That counter is the server's, for every
 * client and for the redis.call()s inside the EVAL. On 22 November 2026 the dispatch step counted 17 against its
 * ceiling of 16 once, in the merge-queue run of #5076, with no diff of the script and a green rerun: the two readings
 * were separate round trips, so another client's command could land between them (#5114 made the failure name the
 * commands and the clients). Now the two readings and the EVAL go in one MULTI/EXEC, so they execute as one block and
 * nothing from another client can be billed to the step, as the script's other measurement already did; the script
 * checks that itself, with a second connection sending five PINGs while the first reading is queued. The ceilings
 * (27, 16, 16, 27) do not change, and a failure still names the per-command difference and CLIENT LIST.
 *
 * The test reads the script's source: no Redis, no network.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("scripts/test_shipment_mail_outbox_redis.py", "utf8");
const measured = source.slice(source.indexOf("    def measured(args, ceiling, between=None, delta_out=None):"), source.indexOf("        return result, count"));

test("the two readings and the EVAL execute as one block: MULTI, INFO, EVAL, INFO, EXEC, on this connection", () => {
  assert.ok(measured.length > 0, "measured(args, ceiling, between=None, delta_out=None) is defined");
  const order = ['redis.command("MULTI")', 'redis.command("INFO", "COMMANDSTATS")', "redis.command(\"EVAL\", *args)", 'redis.command("INFO", "COMMANDSTATS")', 'before_text, result, after_text = redis.command("EXEC")'];
  let at = 0;
  for (const step of order) {
    const found = measured.indexOf(step, at);
    assert.ok(found > at || (found === at && at === 0), `${step} comes in order`);
    at = found + step.length;
  }
  assert.doesNotMatch(measured, /before = stats\(\)/);
  assert.doesNotMatch(measured, /result = fn\(\)/);
});

test("the hook for the isolation check runs once the first reading is queued and before the EVAL", () => {
  const hook = measured.indexOf("if between is not None:\n            between()");
  const first = measured.indexOf('redis.command("INFO", "COMMANDSTATS")');
  const evalAt = measured.indexOf("redis.command(\"EVAL\", *args)");
  assert.ok(first > 0 && hook > first && evalAt > hook, "first INFO, then the hook, then the EVAL");
});

test("the script checks the isolation itself: five PINGs from another connection are never billed to the step", () => {
  assert.match(source, /other = LocalRedis\(\)/);
  assert.match(source, /between=lambda: \[other\.command\("PING"\) for _ in range\(5\)\], delta_out=billed/);
  assert.match(source, /assert "ping" not in billed/);
  assert.match(source, /iso = prefix \+ "isolation:"/);
});

test("the measured step keeps the difference of every command that moved, not only the sum", () => {
  assert.match(measured, /delta = \{cmd: n - before\.get\(cmd, 0\) for cmd, n in after\.items\(\) if n != before\.get\(cmd, 0\)\}/);
  assert.match(measured, /count = sum\(delta\.values\(\)\)/);
});

test("a count above the ceiling fails with the per-command difference and the server's client list", () => {
  assert.match(measured, /if count > ceiling:/);
  assert.match(measured, /clients = redis\.command\("CLIENT", "LIST"\)/);
  assert.match(measured, /raise AssertionError\(/);
  assert.match(measured, /per command \{json\.dumps\(delta, sort_keys=True\)\}/);
  assert.match(measured, /clients on the server: \{clients!r\}/);
  assert.match(measured, /reply \{result!r\}/);
  assert.doesNotMatch(measured, /assert count <= ceiling, \(count, ceiling, result\)/);
});

test("the ceilings of the four measured steps are unchanged", () => {
  const ceilings = [...source.matchAll(/measured\(eval_args\("(\w+)"[^\n]*\), (\d+)[,)]/g)].map((m) => [m[1], Number(m[2])]);
  assert.deepEqual(ceilings, [["enqueue", 27], ["enqueue", 27], ["claim", 16], ["dispatch", 16], ["accepted", 27]], "the isolation check's enqueue and the four steps");
  assert.doesNotMatch(source, /measured\(lambda/);
});

test("a count within the ceiling still returns the reply and the count, as before", () => {
  assert.match(source, /        return result, count\n/);
});
