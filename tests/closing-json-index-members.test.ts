/**
 * A closing store's members are taken out of the company's lists whatever their shape (nuvem I privacy audit of
 * main @3cdc624a7d, 13 November 2026, MÉDIO).
 *
 * lib/data-families.ts marks `nl:recover:asks` (lib/checkout-ask.ts) as an index whose closing store's members the
 * walk takes out. Each member there is a JSON array, `["<statsId>","<handle>","<productId>","<address>",…]`, and
 * the walk told a store's members by splitting them at `:`, `|` and `,` (namesStore), which leaves quotes and
 * brackets on every piece: none ever matched, so a closed store's asks, each holding a buyer's address in plain
 * text, stayed until they fell due. A member that is a JSON array of text is now read as its texts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { walkPage } from "@/lib/closed-store-data";
import { askMember } from "@/lib/checkout-ask";
import { store as redis } from "./redis-stub";

const closing = "0123456789abcdef0123456789abcdef";
const staying = "fedcba9876543210fedcba9876543210";
const owners = { byMark: new Map([[closing, "store:closing"]]), byHandle: new Map<string, string>(), byRef: new Map<string, string>() } as Parameters<typeof walkPage>[2];
const ask = (statsId: string, handle: string, email: string) =>
  askMember({ statsId, handle, productId: "prod_0001", email, askedAt: 1_800_000_000, from: "page", after: 86_400 });

test("a closed store's checkout asks, JSON members with an address each, are taken out of the queue", async () => {
  redis.clear();
  const theirs = ask(closing, "closingstore", "buyer-of-closing@example.test");
  const others = ask(staying, "stayingstore", "buyer-of-staying@example.test");
  redis.run(["ZADD", "nl:recover:asks", 1, theirs, 2, others]);
  const { pruned } = await walkPage(["nl:recover:asks"], new Map(), owners);
  assert.equal(pruned, 1, "one member named the closing store");
  assert.deepEqual(redis.run(["ZRANGE", "nl:recover:asks", 0, -1]), [others], "only the other store's ask is left");
});

test("a member that only looks like JSON, or holds a mark inside a longer text, is never taken for the store's", async () => {
  redis.clear();
  const near = [`["${closing}x"]`, `[${closing}]`, `{"s":"${closing}"}`, `["${closing.slice(1)}"]`];
  redis.run(["ZADD", "nl:recover:asks", ...near.flatMap((m, i) => [i, m])]);
  const { pruned } = await walkPage(["nl:recover:asks"], new Map(), owners);
  assert.equal(pruned, 0);
});
