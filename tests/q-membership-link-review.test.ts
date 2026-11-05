/** Independent controls for the small #2530 copy change and its actual state gate. */
import assert from "node:assert/strict";
import test from "node:test";
import { membershipBeginnerQuestions } from "@/lib/membership-faq";
import { isLiveSub, membershipStatus } from "@/lib/membership-access";
import type { Store } from "@/lib/store";

test("the FAQ names who controls an outside link in either sale state", () => {
  for (const onSale of [false, true]) {
    const answer = membershipBeginnerQuestions(onSale).find(x => x.q === "What is a membership here?")!.a;
    assert.match(answer, /For a link to a file or page on another service, you manage access on that service\./);
    assert.match(answer, /The member cancels on their own/);
    assert.match(answer, /Access to files and courses hosted here follows the membership/);
  }
});
test("unknown membership responses do not open a hosted membership", () => {
  for (const sub of [null, undefined, {}, { status: 0 }, { status: "unknown" }, { status: "canceled" }, { status: "unpaid" }, { status: "incomplete" }]) assert.equal(isLiveSub(sub), false);
});
test("a current member pause closes access while ordinary retry grace stays open", async () => {
  const now = Math.floor(Date.now() / 1000);
  const paused = { status: "active", pause_collection: { behavior: "void", resumes_at: now + 3600 }, metadata: { pause_from: String(now - 3600) } };
  assert.equal(isLiveSub(paused), false);
  assert.equal(isLiveSub({ status: "past_due" }), true);
  assert.equal(await membershipStatus({} as Store, paused), "paused", "the actual expanded-subscription reader observes the same pause");
});
