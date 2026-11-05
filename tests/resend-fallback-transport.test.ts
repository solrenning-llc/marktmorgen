import { test } from "node:test";
import assert from "node:assert/strict";
import { guardedResendPost } from "../lib/resend-fallback-transport";
import { prepareResendFallbackFixture } from "./resend-fallback-fixture";

test("a denied dispatch releases only the still-reserved claim without POST", async () => {
  const fixture = prepareResendFallbackFixture({ credential: "re_test_check_only_a_stand_in" });
  await fixture.ready;
  const original = fixture.runtime.pipeline!;
  fixture.runtime.pipeline = async (batch) => batch[0][5] === "dispatch"
    ? [["denied", "expired"]]
    : original(batch);
  const result = await guardedResendPost({ base: "https://api.resend.com", path: "/emails", credential: "re_test_check_only_a_stand_in", usageCredential: "re_test_check_only_a_stand_in", recipients: 1,
    body: JSON.stringify({ from: "sender@example.test", to: ["buyer@example.test"], subject: "Synthetic", text: "Synthetic only" }), idempotencyKey: "synthetic:denied-dispatch" }, fixture.runtime);
  assert.equal(result.kind, "unknown");
  assert.equal(fixture.requests.filter((r) => r.method === "POST").length, 0);
  assert.equal(fixture.held(), 0);
});

test("a lost dispatch ACK is reconciled by this invocation's token without POST", async () => {
  const fixture = prepareResendFallbackFixture({ credential: "re_test_check_only_a_stand_in" });
  await fixture.ready;
  fixture.loseNext("dispatch");
  const result = await guardedResendPost({ base: "https://api.resend.com", path: "/emails", credential: "re_test_check_only_a_stand_in", usageCredential: "re_test_check_only_a_stand_in", recipients: 1,
    body: JSON.stringify({ from: "sender@example.test", to: ["buyer@example.test"], subject: "Synthetic", text: "Synthetic only" }), idempotencyKey: "synthetic:lost-dispatch" }, fixture.runtime);
  assert.equal(result.kind, "unknown");
  assert.equal(fixture.requests.filter((r) => r.method === "POST").length, 0);
  assert.equal(fixture.held(), 0);
  assert.equal([...fixture.claims.values()][0]?.state, "confirmed_not_accepted");
});
