/**
 * A new conversation written through the live-store fence without a chat token never touches the store's identity
 * key (Claude 6's LEVE on #5000, 7058487424).
 *
 * INBOX_OPEN_WRITE is the fence followed by INBOX_WRITE's body, which writes the token key with
 * `if #KEYS >= 5 then SET KEYS[5]`. The fence appends two keys (identity, erasing), so a tokenless open has 6 keys
 * and KEYS[5] is the store's identity key: it would be overwritten with "" under the conversation's expiry. The
 * open writer must take the token key by position (present only with 7 keys).
 *
 * Checked on the in-memory Redis model, which follows the script, and on the script text itself. Synthetic keys.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { INBOX_OPEN_WRITE } from "@/lib/inbox";
import { store as redis } from "./redis-stub";

const KEEP = 3600;

function openArgs(keys: string[], tokenValue: string, field: string, ref: string): (string | number)[] {
  return ["EVAL", INBOX_OPEN_WRITE, keys.length, ...keys, "", JSON.stringify({ id: "c1" }), KEEP, 1, "c1", "", 50, tokenValue, "0", field, ref, ""];
}

test("a tokenless new conversation through the fence writes the conversation and leaves the identity key alone", async () => {
  redis.clear();
  const identity = "nl:store:id:abcdef0123456789abcdef0123456789";
  redis.run(["SET", identity, "owner@example.test"]);
  const keys = ["nl:inbox:c:s1:c1", "nl:inbox:i:s1", "nl:inbox:m:s1:c1", "nl:inbox:u:s1:c1", identity, "nl:closed:erasing"];
  const [answer] = await redis.pipeline([openArgs(keys, "", "field-1", "owner@example.test")]);
  assert.equal(answer, 1);
  assert.equal(redis.run(["GET", identity]), "owner@example.test");
  assert.equal(redis.run(["TTL", identity]), -1);
  assert.ok(redis.run(["GET", keys[0]]));
});

test("with a chat token (7 keys) the token is still written beside the conversation", async () => {
  redis.clear();
  const identity = "nl:store:id:abcdef0123456789abcdef0123456789";
  redis.run(["SET", identity, "owner@example.test"]);
  const keys = ["nl:inbox:c:s1:c1", "nl:inbox:i:s1", "nl:inbox:m:s1:c1", "nl:inbox:u:s1:c1", "nl:inbox:t:tok", identity, "nl:closed:erasing"];
  const [answer] = await redis.pipeline([openArgs(keys, "s1|c1|shop", "field-1", "owner@example.test")]);
  assert.equal(answer, 1);
  assert.equal(redis.run(["GET", "nl:inbox:t:tok"]), "s1|c1|shop");
  assert.equal(redis.run(["GET", identity]), "owner@example.test");
});

test("the production script takes the token key only when it is there: never the fence's identity key", () => {
  assert.ok(!INBOX_OPEN_WRITE.includes("if #KEYS >= 5 then"), "the plain writer's key-count test would read the identity key as the token");
  assert.match(INBOX_OPEN_WRITE, /if #KEYS >= 7 then redis\.call\('SET', KEYS\[5\]/);
});
