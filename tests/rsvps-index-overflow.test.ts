/**
 * Claude 5 on #2957 (MÉDIO, privacy): the events' index is read exactly, but it can hold more than
 * MAX_KEPT_EVENTS (two createEvent calls at once, each counting before its ZADD). forgetRsvpsPerson and rsvpsOf
 * used to cut the list at MAX_KEPT_EVENTS without saying so. ZRANGEBYSCORE is in start order, so the newest events
 * were left out: the erasure said "done" with the member's RSVP still kept, and the copy of their data came out
 * without it. Past the cap, both now throw UnknownReplyError: the erasure is never reported done and the copy says
 * it could not be read. That matches eventCount, which sizes the erasure's units at MAX_KEPT_EVENTS at most.
 * Synthetic data only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { forgetRsvpsPerson, rsvpsOf } from "@/lib/community-events";
import { MAX_KEPT_EVENTS } from "@/lib/community-text";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

type Command = (string | number)[];

const community = "0123456789abcdef0123456789abcdef";
const member = "fedcba9876543210fedcba9876543210";
const email = "member@example.com";
const indexKey = `nl:cm:${community}:evs`;
const call = (c: Command[]) => redis.pipeline(c);
const newest = `event${MAX_KEPT_EVENTS}`;

async function seed(events: number) {
  redis.clear();
  const adds: Command[] = [];
  for (let i = 0; i < events; i++) adds.push(["ZADD", indexKey, i + 1, `event${i}`]);
  await call(adds);
  // The member's RSVP is on the event with the latest start: the one a cut at MAX_KEPT_EVENTS leaves out.
  await call([["HSET", `nl:cm:${community}:ev:${`event${events - 1}`}:r`, member, "1700000000"]]);
}

const rsvpLeft = async (event: string) => (await call([["HGET", `nl:cm:${community}:ev:${event}:r`, member]]))[0];

test(`an index past MAX_KEPT_EVENTS (${MAX_KEPT_EVENTS + 1} events): the erasure throws, never "done" with the RSVP kept`, async () => {
  await seed(MAX_KEPT_EVENTS + 1);
  await assert.rejects(() => forgetRsvpsPerson(community, member, email), UnknownReplyError);
  assert.equal(await rsvpLeft(newest), "1700000000", "nothing is reported done while this RSVP is kept");
});

test(`an index past MAX_KEPT_EVENTS: the copy of the member's data throws instead of coming out without the RSVP`, async () => {
  await seed(MAX_KEPT_EVENTS + 1);
  await assert.rejects(() => rsvpsOf(community, member), UnknownReplyError);
});

test(`an index at exactly MAX_KEPT_EVENTS still reads and forgets every event`, async () => {
  await seed(MAX_KEPT_EVENTS);
  const last = `event${MAX_KEPT_EVENTS - 1}`;
  assert.deepEqual(await rsvpsOf(community, member), [{ event: last, at: 1700000000 }]);
  assert.equal(await forgetRsvpsPerson(community, member, email), 1);
  assert.equal(await rsvpLeft(last), null);
});
