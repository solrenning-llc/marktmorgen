/**
 * A recipient's confirmed answer to a poll in a broadcast (125
 * [F2-EMAIL-POLLS], unit 4: lib/email-poll-vote.ts and the poll a broadcast
 * keeps in lib/broadcasts.ts).
 *
 * What fails here:
 *   - a vote kept from a link that is not that recipient's, or for a place
 *     past the broadcast's list;
 *   - a link that is refused costing a read of the database;
 *   - a vote kept for a broadcast with no poll, not sent yet, or canceled;
 *   - a vote kept after the poll closed, or with no buyer action of the
 *     store's month taken first (then the store is resting: nothing kept);
 *   - anything that does not read (the broadcast, the store, the month,
 *     the write) answered as kept or as refused, never "unknown" (rule 24);
 *   - a broadcast whose poll does not read taken as one without a poll.
 */
import { BroadcastsUnreadable, readBroadcast } from "@/lib/broadcasts";
import { pollLinkPart } from "@/lib/email-poll-links";
import { votePoll } from "@/lib/email-poll-vote";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const now = Date.now();
const ID = "0123456789abcdef01234567";
const poll = { question: "Which class next?", options: ["Glazing", "Trimming", "Firing"], days: 7 };
const record = (extra: Record<string, unknown> = {}) => ({
  id: ID, listId: "list1", handle: "clayhouse", subject: "News", body: "Hello", productId: null, notProductId: null,
  who: "all", narrow: null, status: "sent", createdAt: now - DAY, sendAt: now - DAY, finishedAt: now - DAY + 60_000,
  total: 10, sent: 10, note: "", failures: 0, listed: true, tagged: true, test: null, poll, ...extra,
});
const put = (extra: Record<string, unknown> = {}) => redis.run(["SET", `nl:mail:bc:${ID}`, JSON.stringify(record(extra))]);
const votes = () => redis.run(["HGETALL", `nl:mail:bc:${ID}:poll`]);
const shop = { handle: "clayhouse" } as Store;

let reads = 0;
let taken = 0;
const deps = (over: Partial<Parameters<typeof votePoll>[1]> = {}) => ({
  loadStore: async (handle: string) => { reads += 1; return handle === "clayhouse" ? shop : null; },
  take: async () => { taken += 1; return true; },
  ...over,
});
const link = (place: number) => pollLinkPart(ID, place) as string;

(async () => {
  redis.clear();
  put();

  part("The broadcast keeps its poll");
  is("read back whole", (await readBroadcast(ID))?.poll, poll);
  put({ poll: undefined });
  is("an email made without one has none", (await readBroadcast(ID))?.poll, undefined);
  put({ poll: { question: "", options: ["a"], days: 99 } });
  let unreadable = false;
  try { await readBroadcast(ID); } catch (error) { unreadable = error instanceof BroadcastsUnreadable; }
  is("a poll that does not read: the record does not read, never one without a poll", unreadable, true);
  is("and a vote on it is unknown", await votePoll({ broadcastId: ID, link: link(2), option: 0, now }, deps()), "unknown");
  put();

  part("A confirmed answer is kept under the recipient's place");
  taken = 0;
  is("kept", await votePoll({ broadcastId: ID, link: link(2), option: 1, now }, deps()), "recorded");
  is("under the place, the answer's index", votes(), ["2", "1"]);
  is("one buyer action of the store's month taken first", taken, 1);
  is("changed", await votePoll({ broadcastId: ID, link: link(2), option: 2, now }, deps()), "recorded");
  is("taken back", await votePoll({ broadcastId: ID, link: link(2), option: null, now }, deps()), "withdrawn");
  is("nothing kept for that place", votes(), []);
  is("the last place of the list", await votePoll({ broadcastId: ID, link: link(9), option: 0, now }, deps()), "recorded");

  part("Refused, with no read of the database");
  redis.clear();
  put();
  let calls = 0;
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (commands) => { calls += 1; return pipeline(commands); };
  reads = 0;
  is("a link with a changed place", await votePoll({ broadcastId: ID, link: link(2).replace(/^2\./, "3."), option: 0, now }, deps()), "invalid");
  is("another broadcast's link", await votePoll({ broadcastId: ID, link: pollLinkPart("fedcba9876543210fedcba98", 2), option: 0, now }, deps()), "invalid");
  is("no link", await votePoll({ broadcastId: ID, link: undefined, option: 0, now }, deps()), "invalid");
  is("a broadcast id that is not one", await votePoll({ broadcastId: "nope", link: link(2), option: 0, now }, deps()), "invalid");
  is("no store read for them", reads, 0);
  is("no database command for them", calls, 0);
  redis.pipeline = pipeline;

  part("Refused after reading the broadcast");
  is("a place past the list", await votePoll({ broadcastId: ID, link: link(10), option: 0, now }, deps()), "invalid");
  is("an answer the poll does not have", await votePoll({ broadcastId: ID, link: link(2), option: 3, now }, deps()), "invalid");
  put({ poll: undefined });
  is("a broadcast with no poll", await votePoll({ broadcastId: ID, link: link(2), option: 0, now }, deps()), "invalid");
  for (const status of ["scheduled", "waiting", "cancelled", "failed"]) {
    put({ status });
    is(`a broadcast ${status}: its poll was never sent`, await votePoll({ broadcastId: ID, link: link(2), option: 0, now }, deps()), "invalid");
  }
  put({ status: "sending" });
  is("while it is going out: kept", await votePoll({ broadcastId: ID, link: link(2), option: 0, now }, deps()), "recorded");
  redis.run(["DEL", `nl:mail:bc:${ID}`]);
  is("a broadcast no longer kept", await votePoll({ broadcastId: ID, link: link(2), option: 0, now }, deps()), "invalid");

  part("Closed");
  redis.clear();
  put({ sendAt: now - 8 * DAY });
  taken = 0;
  is("after its days", await votePoll({ broadcastId: ID, link: link(2), option: 0, now }, deps()), "closed");
  is("taking back after it closed: closed too", await votePoll({ broadcastId: ID, link: link(2), option: null, now }, deps()), "closed");
  is("no action of the month taken for it", taken, 0);
  is("nothing kept", votes(), []);

  part("Resting and unknown: nothing kept");
  redis.clear();
  put();
  is("the store's month is spent: resting", await votePoll({ broadcastId: ID, link: link(2), option: 0, now }, deps({ take: async () => false })), "resting");
  is("the month could not be read: unknown", await votePoll({ broadcastId: ID, link: link(2), option: 0, now }, deps({ take: async () => { throw new Error("down"); } })), "unknown");
  is("the store is gone or does not read: unknown", await votePoll({ broadcastId: ID, link: link(2), option: 0, now }, deps({ loadStore: async () => null })), "unknown");
  is("the store's read failed: unknown", await votePoll({ broadcastId: ID, link: link(2), option: 0, now }, deps({ loadStore: async () => { throw new Error("down"); } })), "unknown");
  is("nothing kept by any of them", votes(), []);
  redis.run(["SET", `nl:mail:bc:${ID}`, "{not json"]);
  is("a record that does not read: unknown", await votePoll({ broadcastId: ID, link: link(2), option: 0, now }, deps()), "unknown");
  put({ sendAt: "soon" });
  is("a send time that is not one: unknown", await votePoll({ broadcastId: ID, link: link(2), option: 0, now }, deps()), "unknown");
  put({ total: -1 });
  is("a list size that is not one: unknown", await votePoll({ broadcastId: ID, link: link(2), option: 0, now }, deps()), "unknown");

  done();
})();
