/**
 * The real-Redis shipment dispatch check (scripts/test_shipment_mail_outbox_redis.py, the form-opportunity-redis job)
 * bills a script step by the difference of two INFO COMMANDSTATS readings. That counter is the server's, for every
 * client and for the redis.call()s inside the EVAL, so a count above the ceiling can be a command added to the script
 * or another client's traffic between the two readings. On 22 November 2026 the dispatch step counted 17 against its
 * ceiling of 16 once, in the merge-queue run of #5076, with no diff of the script and a green rerun; the message then
 * said only (17, 16, reply), and nobody could tell which. A failure now names each command that moved and the server's
 * CLIENT LIST, so the next log tells the two apart. The ceilings (27, 16, 16, 27) do not change.
 *
 * The test reads the script's source: no Redis, no network.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("scripts/test_shipment_mail_outbox_redis.py", "utf8");
const measured = source.slice(source.indexOf("    def measured(fn, ceiling):"), source.indexOf("        return result, count"));

test("the measured step keeps the difference of every command that moved, not only the sum", () => {
  assert.ok(measured.length > 0, "measured(fn, ceiling) is defined");
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
  const ceilings = [...source.matchAll(/measured\(lambda: run\("(\w+)"[^\n]*\), (\d+)\)/g)].map((m) => [m[1], Number(m[2])]);
  assert.deepEqual(ceilings, [["enqueue", 27], ["claim", 16], ["dispatch", 16], ["accepted", 27]]);
});

test("a count within the ceiling still returns the reply and the count, as before", () => {
  assert.match(source, /        return result, count\n/);
});
