/**
 * The in-memory Redis (lib/redis-memory.ts) answers ZADD as Redis does: the
 * number of members added, so a test meets the same 0 that a real duplicate
 * gets (C6's LOW on #3099, review 6712088601, point 3). With NX a member
 * already there is not added (0); with XX nothing is ever added (0) though a
 * member there is moved; with CH the count is of members added or changed.
 * Flags are read wherever they stand before the first score.
 *
 * lib/review-ask.ts scheduleReviewAsk reads that count (`added === 1`), so an
 * order put on the list twice is no longer taken for a new one.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

redis.clear();
const K = "nl:test:zadd";
const score = (member: string) => redis.run(["ZSCORE", K, member]);

part("Without flags: the new members are counted, the old ones only moved");
is("two new members", redis.run(["ZADD", K, 1, "a", 2, "b"]), 2);
is("one old (moved) and one new", redis.run(["ZADD", K, 5, "a", 3, "c"]), 1);
is("the old one moved", Number(score("a")), 5);

part("NX: only new members, each counted");
is("a member already there is not added", redis.run(["ZADD", K, "NX", 9, "a"]), 0);
is("and keeps its score", Number(score("a")), 5);
is("a new one is", redis.run(["ZADD", K, "NX", 4, "d"]), 1);

part("XX: never adds, so always 0, though a member there is moved");
is("a member there", redis.run(["ZADD", K, "XX", 7, "a"]), 0);
is("is moved", Number(score("a")), 7);
is("a member not there", redis.run(["ZADD", K, "XX", 7, "zz"]), 0);
is("is not added", score("zz"), null);

part("CH: members added or changed");
is("XX CH counts the one moved", redis.run(["ZADD", K, "XX", "CH", 8, "a"]), 1);
is("CH XX, the other order, too", redis.run(["ZADD", K, "CH", "XX", 9, "a"]), 1);
is("the same score is no change", redis.run(["ZADD", K, "CH", 9, "a"]), 0);
is("and the flag was not taken for a score: a is at 9", Number(score("a")), 9);

done();
