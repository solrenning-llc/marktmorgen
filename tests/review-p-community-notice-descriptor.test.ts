import assert from "node:assert/strict";
import test from "node:test";
import { forgetNoticesPerson } from "@/lib/community-notify";
import { store } from "./redis-stub";

const COMMUNITY = "notice-descriptor-proof";
const MEMBER = "c3c3c3c3c3c3";

test("an accessor reply cannot borrow a deletion count from its descriptor prototype", async () => {
  const original = store.pipeline.bind(store);
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, "value");
  assert.equal(previous, undefined);
  let getterReads = 0;
  const reply: unknown[] = [];
  Object.defineProperty(reply, "0", { get() { getterReads++; return 2; } });
  Object.defineProperty(Object.prototype, "value", { value: 2, configurable: true });
  store.pipeline = async () => reply;
  try {
    await assert.rejects(forgetNoticesPerson(COMMUNITY, MEMBER));
  } finally {
    Reflect.deleteProperty(Object.prototype, "value");
    store.pipeline = original;
  }
  assert.equal(getterReads, 0);
});

test("an exact own numeric deletion count remains accepted", async () => {
  const original = store.pipeline.bind(store);
  store.pipeline = async () => [2];
  try {
    assert.equal(await forgetNoticesPerson(COMMUNITY, MEMBER), 2);
  } finally {
    store.pipeline = original;
  }
});
