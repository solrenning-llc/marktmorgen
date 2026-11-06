import test from "node:test";
import assert from "node:assert/strict";
import { parseStoreWaitlistGrant } from "@/lib/waitlist-tokens";

const grant = { s: "synthetic", h: "harbor-kitchen", p: "fictional", e: "reader@example.invalid", k: "leave" };
for (const field of ["s", "h", "p", "e", "k"] as const) {
  test(`conflicting duplicate ${field} is unknown`, () => {
    const first = field === "k" ? "confirm" : "different";
    const raw = `{${JSON.stringify(field)}:${JSON.stringify(first)},${JSON.stringify(grant).slice(1)}`;
    assert.equal(parseStoreWaitlistGrant(raw), null);
  });
}
test("escaped duplicate email member is also unknown", () => {
  const raw = '{"\\u0065":"other@example.invalid",' + JSON.stringify(grant).slice(1);
  assert.equal(parseStoreWaitlistGrant(raw), null);
});
test("exact legacy confirm and leave grants survive", () => {
  for (const k of ["confirm", "leave"] as const) assert.deepEqual(parseStoreWaitlistGrant(JSON.stringify({ ...grant, k })), { ...grant, k });
});
test("inert extra claims are discarded", () => {
  assert.deepEqual(parseStoreWaitlistGrant(JSON.stringify({ ...grant, paid: true, consent: true })), grant);
});
test("null, array and malformed evidence are refused", () => {
  for (const raw of [null, "null", "[]", "{broken", "42"]) assert.equal(parseStoreWaitlistGrant(raw), null);
});
