/**
 * #4589: what other members learn about a chat message's author. The room keeps each member's key (lib/learn.ts
 * emailKey, an unsalted hash of the address) inside the server; what it hands out is an HMAC under a deployment
 * secret (lib/secret-box.ts deriveKey), scoped to the community, so a guessed address can no longer be checked offline
 * and the same person cannot be followed from one community to another. Synthetic only.
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { GET as news } from "@/app/api/store/community/chat/new/route";
import { roomPass } from "@/lib/chat-pass";
import { parseChatSetting, say } from "@/lib/community-chat";
import { CREATOR, memberKey } from "@/lib/community";
import { chatAuthor } from "@/lib/chat-author";
import { store as redis } from "./redis-stub";

process.env.STRIPE_SECRET_KEY ||= "sk_test_chat_author_only_a_stand_in";
const ADDRESS = "Pseudonym.Person@Example.test";
const unsalted = createHash("sha256").update(`nimbus-learner:${ADDRESS.toLowerCase()}`).digest("hex").slice(0, 32);
const ROOM_A = "a".repeat(32), ROOM_B = "c".repeat(32);

async function look(id: string) {
  const response = await news(new Request(`https://marktmorgen.com/api/store/community/chat/new?c=${id}&p=${roomPass(id)}&s=0`) as never);
  return (await response.json()) as { ok: boolean; messages: { a: string; text: string }[] };
}

test("the key the server keeps is the unsalted hash (what the probe in #4589 found)", () => {
  assert.equal(memberKey(ADDRESS), unsalted);
});

test("the shared room read never hands out the address's hash, and two rooms give two different authors", async () => {
  redis.clear();
  const open = parseChatSetting({ on: true });
  assert.equal((await say(ROOM_A, open, memberKey(ADDRESS), false, "hello A")).ok, true);
  assert.equal((await say(ROOM_B, open, memberKey(ADDRESS), false, "hello B")).ok, true);
  const a = await look(ROOM_A), b = await look(ROOM_B);
  assert.equal(a.ok && b.ok, true);
  assert.notEqual(a.messages[0].a, unsalted);
  assert.notEqual(b.messages[0].a, unsalted);
  assert.notEqual(a.messages[0].a, b.messages[0].a);
  assert.equal(a.messages[0].a, chatAuthor(ROOM_A, memberKey(ADDRESS)), "the same value the page is given as 'me'");
});

test("the creator stays the creator; a key is 32 hex characters; the same author is stable in its room", () => {
  assert.equal(chatAuthor(ROOM_A, CREATOR), CREATOR);
  assert.match(chatAuthor(ROOM_A, unsalted), /^[0-9a-f]{32}$/);
  assert.equal(chatAuthor(ROOM_A, unsalted), chatAuthor(ROOM_A, unsalted));
  assert.notEqual(chatAuthor(ROOM_A, unsalted), chatAuthor(ROOM_A, "d".repeat(32)));
});
