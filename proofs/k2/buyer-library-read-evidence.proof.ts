import assert from "node:assert/strict";
import test from "node:test";
import {storesBoughtFrom, storesKnownFor} from "@/lib/buyer-library";
import {store as redis} from "../../tests/redis-stub";

// Read-only proof against the real public library readers. No mail, write,
// store lookup, provider or personal-data operation is performed.
const sid = "a".repeat(32);
const readers = {storesBoughtFrom, storesKnownFor};
const pipeline = redis.pipeline.bind(redis);
let response: unknown;
let commands: (string | number)[][] = [];
redis.pipeline = (async (input: (string | number)[][]) => {
  commands = input;
  assert.equal(input.length, 1);
  assert.equal(input[0][0], "SUNION");
  return response;
}) as typeof redis.pipeline;
globalThis.fetch = (async () => {throw new Error("No network allowed in this proof");}) as typeof fetch;

const malformed: [string, unknown][] = [
  ["missing command reply", []],
  ["null set reply", [null]],
  ["object set reply", [{}]],
  ["one invalid member", [["not-a-store-id"]]],
  ["valid member followed by invalid member", [[sid, "not-a-store-id"]]],
  ["extra command reply", [[sid], "unexpected"]],
];

for (const [name, read] of Object.entries(readers)) {
  for (const [label, value] of malformed) {
    test(`${name}: ${label} is unknown, never a complete library`, async () => {
      response = value;
      await assert.rejects(() => read("buyer@example.com"));
    });
  }
  test(`${name}: exact empty set is known empty`, async () => {
    response = [[]];
    assert.deepEqual(await read("buyer@example.com"), []);
    assert.equal(commands.length, 1);
  });
  test(`${name}: exact valid set preserves the store`, async () => {
    response = [[sid]];
    assert.deepEqual(await read("buyer@example.com"), [sid]);
    assert.equal(commands.length, 1);
  });
}
test.after(() => {redis.pipeline = pipeline;});
