/**
 * CX-123 rule 24: who may come to a live event (lib/community-events.ts). An
 * event kept for the buyers of some products keeps that list in its record
 * ("only"). A record whose list is there but in another shape (text, numbers,
 * an object, null, an id this code never writes) is not "for everyone": it is
 * not read at all, so no member who does not hold one of the products is let
 * in, RSVPs or gets the way in. A record with no list at all, as the code
 * writes it for an event open to every member, stays open to every member.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mayAttend, readEvent } from "@/lib/community-events";
import { store as redis } from "./redis-stub";

const community = "c".repeat(32);
const eventId = "abcdef123456";
const start = Date.UTC(2026, 10, 20, 18);
const store = { community: { id: community } } as Parameters<typeof mayAttend>[0];
const config = { access: ["prodlocked1", "prodopen001"], v: 1 } as unknown as Parameters<typeof mayAttend>[1];
const stranger = { owner: false, email: "fictional.member@example.test" };

function keep(only: unknown, present = true): void {
  const record: Record<string, unknown> = { id: eventId, title: "Members only", start, minutes: 60, tz: "UTC", where: "room", room: "", v: 1 };
  if (present) record.only = only;
  redis.clear();
  redis.run(["SET", `nl:cm:${community}:ev:${eventId}`, JSON.stringify(record)]);
}

const OFF_SHAPE: [string, unknown][] = [
  ["text", "prodlocked1"],
  ["numbers", [123456]],
  ["an object", { 0: "prodlocked1" }],
  ["null", null],
  ["an empty id", [""]],
  ["an id longer than any product id", ["p".repeat(41)]],
];

for (const [label, only] of OFF_SHAPE) {
  test(`an event whose product list is ${label} is never opened to every member`, async () => {
    keep(only);
    const event = await readEvent(community, eventId);
    if (event === null) return; // Not read at all: nobody is let in on it.
    assert.equal(await mayAttend(store, config, event, stranger), false);
  });
}

test("an event with no product list in its record stays open to every member", async () => {
  keep(undefined, false);
  const event = await readEvent(community, eventId);
  assert.ok(event);
  assert.deepEqual(event.only, []);
  assert.equal(await mayAttend(store, config, event, stranger), true);
});

test("an event kept for a product, written as the code writes it, still names that product", async () => {
  keep(["prodlocked1", "prodlocked1"]);
  const event = await readEvent(community, eventId);
  assert.ok(event);
  assert.deepEqual(event.only, ["prodlocked1"]);
});
