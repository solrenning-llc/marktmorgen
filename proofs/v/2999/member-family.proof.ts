/** Independent, synthetic registry controls; no provider or destructive walk is run. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CLOSING, ELSEWHERE_FAMILIES, closingFamilyOf, countedInRoom } from "@/lib/data-families";
import { ownerOfKey } from "@/lib/closed-store-data";
import { MEMBER_PERCENT_CHOICES } from "@/lib/member-price-rules";

const account = "acct_test";
const owner = "synthetic@example.test";
const owners = { byMark: new Map([[account, owner]]), byHandle: new Map<string,string>(), byRef: new Map<string,string>() };

test("the member-coupon family has the existing fair-coupon disposition", () => {
  assert.equal(ELSEWHERE_FAMILIES.filter(prefix => prefix === "nl:member:c:").length, 1);
  assert.deepEqual(CLOSING["nl:member:c:"], CLOSING["nl:fair:c:"]);
  assert.deepEqual(CLOSING["nl:member:c:"], { how: "erase" });
});

test("every offered member-coupon key belongs only to its closing account", () => {
  for (const percent of MEMBER_PERCENT_CHOICES) {
    const key = `nl:member:c:${account}:${percent}`;
    assert.equal(closingFamilyOf(key), "nl:member:c:");
    assert.equal(countedInRoom(key), false);
    assert.equal(ownerOfKey(key, CLOSING["nl:member:c:"], owners), owner);
    assert.equal(ownerOfKey(`nl:member:c:acct_other:${percent}`, CLOSING["nl:member:c:"], owners), null);
  }
});

test("an account omitted from closing marks is not adopted through a handle or ref", () => {
  const key = `nl:member:c:${account}:20`;
  assert.equal(ownerOfKey(key, CLOSING["nl:member:c:"], { byMark:new Map(), byHandle:new Map([[account,owner]]), byRef:new Map() }),null);
});
