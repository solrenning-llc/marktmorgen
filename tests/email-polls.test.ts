/**
 * The votes of a poll in a broadcast, kept (125 [F2-EMAIL-POLLS], unit 3:
 * lib/email-polls.ts).
 *
 * What fails here:
 *   - a vote kept under anything but the recipient's place, or kept twice;
 *   - a vote that cannot be changed or taken back;
 *   - a reply that does not read taken as done, or results with a vote that
 *     does not read taken as a count without it (rule 24);
 *   - votes kept past the poll's end and the time after it.
 */
import { POLL_RESULTS_DAYS, pollResults, recordVote } from "@/lib/email-polls";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const BC = "0123456789abcdef01234567";
const key = `nl:mail:bc:${BC}:poll`;
const now = Date.now();
const closesAt = now + 7 * DAY;

(async () => {
  redis.clear();
  part("Kept by place");
  is("a vote", await recordVote(BC, 3, 1, closesAt, now), "recorded");
  is("kept under the place, never an address", redis.run(["HGET", key, "3"]), "1");
  is("changed", await recordVote(BC, 3, 2, closesAt, now), "recorded");
  is("still one vote for that place", redis.run(["HLEN", key]), 1);
  is("others vote", [await recordVote(BC, 4, 2, closesAt, now), await recordVote(BC, 9, 0, closesAt, now)], ["recorded", "recorded"]);
  is("totals only", await pollResults(BC, 3), { known: true, counts: [1, 0, 2], votes: 3 });
  is("taken back", await recordVote(BC, 4, null, closesAt, now), "withdrawn");
  is("totals after", await pollResults(BC, 3), { known: true, counts: [1, 0, 1], votes: 2 });
  is("taking back a vote never cast", await recordVote(BC, 7, null, closesAt, now), "withdrawn");
  const ttl = Number(redis.run(["TTL", key]));
  const until = Math.ceil((closesAt + POLL_RESULTS_DAYS * DAY - now) / 1000);
  is("kept until the end and the days after it, not longer", ttl > until - 5 && ttl <= until + 1, true);
  is("no votes yet: an exact zero", await pollResults("fedcba9876543210fedcba98", 2), { known: true, counts: [0, 0], votes: 0 });

  part("Refused");
  is("a place that is not one", await recordVote(BC, -1, 0, closesAt, now), "invalid");
  is("an answer that is not one", await recordVote(BC, 2, 7, closesAt, now), "invalid");
  is("a broadcast id that is not one", await recordVote("bad id!", 2, 0, closesAt, now), "invalid");
  is("an end that is not a time", await recordVote(BC, 2, 0, Number.NaN, now), "unknown");
  is("after the end", await recordVote(BC, 2, 0, closesAt, closesAt), "closed");

  part("Unknown is never done");
  const run = redis.run.bind(redis);
  redis.run = (c: (string | number)[]) => (String(c[0]).toUpperCase() === "HSET" ? "OK?" : run(c));
  is("an odd reply to the write", await recordVote(BC, 5, 0, closesAt, now), "unknown");
  redis.run = run;
  redis.run = (c: (string | number)[]) => (String(c[0]).toUpperCase() === "EXPIREAT" ? 0 : run(c));
  is("a vote whose end was not set: unknown, never kept without its end", await recordVote(BC, 6, 0, closesAt, now), "unknown");
  redis.run = run;
  redis.run = (c: (string | number)[]) => (String(c[0]).toUpperCase() === "HVALS" ? null : run(c));
  is("results that do not read", await pollResults(BC, 3), { known: false });
  redis.run = run;
  redis.run(["HSET", key, "11", "x"]);
  is("a kept vote that does not read: unknown, never left out", await pollResults(BC, 3), { known: false });
  part("Only a broadcast's own id, as lib/broadcasts.ts makes it (Claude 3 on #3673, LEVE)");
  is("an id in another shape keeps no vote", await recordVote("bc0123456789abcdef", 3, 1, closesAt, now), "invalid");
  is("and reads no totals", await pollResults("bc0123456789abcdef", 2), { known: false });

  done();
})();
