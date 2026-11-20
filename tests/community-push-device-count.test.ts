/**
 * Codex V-20261116-1249 (MEDIUM, erasure): forgetting one push device is a single
 * HDEL of one field, which can only answer 0 or 1. An impossible 2 used to be
 * accepted, so "turn this off" was confirmed while the device might still be kept.
 * Synthetic Redis only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { forgetDevice } from "@/lib/community-push";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store } from "./redis-stub";

const COMMUNITY = "v-push-device-count";
const MEMBER = "v".repeat(32);
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/v-device-count";

test("forgetting one push device accepts only the two possible HDEL counts", async () => {
  const original: typeof store.pipeline = store.pipeline.bind(store);
  try {
    for (const count of [0, 1]) {
      const commands: (string | number)[][] = [];
      store.pipeline = async (batch) => { commands.push(...batch); return [count]; };
      await assert.doesNotReject(forgetDevice(COMMUNITY, MEMBER, ENDPOINT));
      assert.deepEqual(commands, [["HDEL", `nl:cm:${COMMUNITY}:ps:${MEMBER}`, ENDPOINT]]);
    }

    const commands: (string | number)[][] = [];
    store.pipeline = async (batch) => { commands.push(...batch); return [2]; };
    await assert.rejects(forgetDevice(COMMUNITY, MEMBER, ENDPOINT), UnknownReplyError);
    assert.deepEqual(commands, [["HDEL", `nl:cm:${COMMUNITY}:ps:${MEMBER}`, ENDPOINT]]);
  } finally {
    store.pipeline = original;
  }
});
