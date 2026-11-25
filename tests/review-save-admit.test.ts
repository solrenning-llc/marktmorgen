/**
 * Claude 2 lpgvy's MEDIUM 2 on #5400 (#5010 row 180): the review route took the order's one save of the store's month
 * before saveReview, and nothing gave it back when the save wrote nothing (busy, full, no room, an error), so a buyer
 * whose first review met a busy lock was told "already saved" and could not review the order until next month.
 *
 * Now the route reads the count first (monthCountWhy, one GET), saveReview takes it only under the product's lock,
 * just before the write (SaveInput.admit), and a save it admitted that then finds no room gives it back
 * (giveBackMonth). Checked here, below the route (the route's own busy-then-saved case is in
 * tests/review-route-units.test.ts):
 *   - monthCountWhy reads without taking, and says "over" only once the limit is taken;
 *   - giveBackMonth gives one back, and a key gone in between comes back with an expiry;
 *   - saveReview asks admit only when it is about to write: never for a full product nor an invalid rating, and an
 *     "over" or "unknown" admission writes nothing;
 *   - a save that admitted and found no room answers "noroom", and the route's give-back makes the month's save usable.
 * Synthetic store and buyers; in-memory Redis; no network.
 */
import { giveBackMonth, monthCountWhy, withinMonthWhy } from "@/lib/request-guard";
import { MAX_REVIEWS_PER_PRODUCT, readReview, reviewId, saveReview } from "@/lib/reviews";
import { ROOM, roomOnly } from "./data-room";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.UPSTASH_REDIS_REST_URL ||= "https://redis.example.invalid";
process.env.UPSTASH_REDIS_REST_TOKEN ||= "test-token";

const STATS = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const PRODUCT = "prod0001";
const MONTH = "2026-11-13";
const KEEP = 32 * 86_400;
const input = (email: string, admit?: () => Promise<"ok" | "over" | "unknown">) => ({ productId: PRODUCT, email, reference: `cs_test_${email.slice(0, 6)}`, pi: "", rating: 5, text: "Clear steps and good bread.", name: "Ana", ...(admit ? { admit } : {}) });

async function main(): Promise<void> {
  part("monthCountWhy reads the count without taking one");
  redis.clear();
  is("nothing taken yet: ok", await monthCountWhy("review-saves", "cs_a", 1, MONTH), "ok");
  is("still nothing taken by the read", redis.keys().filter((key) => key.startsWith("nl:rlm:review-saves:")), []);
  is("one taken (control)", await withinMonthWhy("review-saves", "cs_a", 1, MONTH, KEEP), "ok");
  is("now the read says over", await monthCountWhy("review-saves", "cs_a", 1, MONTH), "over");
  is("another order is apart", await monthCountWhy("review-saves", "cs_b", 1, MONTH), "ok");
  is("a window that is not one is unknown", await monthCountWhy("review-saves", "cs_a", 1, "not-a-month"), "unknown");
  const [key] = redis.keys().filter((k) => k.startsWith("nl:rlm:review-saves:"));
  await redis.pipeline([["SET", key, "garbled"]]);
  is("a count of another shape is unknown, never room", await monthCountWhy("review-saves", "cs_a", 1, MONTH), "unknown");

  part("giveBackMonth gives one back");
  redis.clear();
  await withinMonthWhy("review-saves", "cs_a", 1, MONTH, KEEP);
  await giveBackMonth("review-saves", "cs_a", MONTH, KEEP);
  is("the month's save is usable again", [await monthCountWhy("review-saves", "cs_a", 1, MONTH), await withinMonthWhy("review-saves", "cs_a", 1, MONTH, KEEP)], ["ok", "ok"]);
  redis.clear();
  await giveBackMonth("review-saves", "cs_c", MONTH, KEEP);
  const [gone] = redis.keys().filter((k) => k.startsWith("nl:rlm:review-saves:"));
  is("a key gone in between comes back at -1 with an expiry, never without one", [redis.run(["GET", gone]), Number(redis.run(["TTL", gone])) > 0], ["-1", true]);

  part("saveReview asks admit only when it is about to write");
  redis.clear();
  let asked = 0;
  const count = (answer: "ok" | "over" | "unknown") => async () => {
    asked += 1;
    return answer;
  };
  const invalid = await saveReview(STATS, { ...input("rate@example.com", count("ok")), rating: 9 }, ROOM);
  is("an invalid rating: never admitted", [invalid.state, asked], ["invalid", 0]);
  const over = await saveReview(STATS, input("over@example.com", count("over")), ROOM);
  is("admission over: answered over, nothing written", [over.state, await readReview(STATS, PRODUCT, reviewId(STATS, PRODUCT, "over@example.com"))], ["over", null]);
  let threw = "";
  await saveReview(STATS, input("unknown@example.com", count("unknown")), ROOM).catch((error: unknown) => {
    threw = error instanceof Error ? error.constructor.name : "other";
  });
  is("admission unknown: thrown, nothing written", [threw, await readReview(STATS, PRODUCT, reviewId(STATS, PRODUCT, "unknown@example.com"))], ["UnknownReplyError", null]);
  asked = 0;
  const saved = await saveReview(STATS, input("ok@example.com", count("ok")), ROOM);
  is("admitted: written, asked once", [saved.state, asked], ["created", 1]);

  part("A full product never reaches the admission");
  redis.clear();
  const fields: (string | number)[] = [];
  for (let n = 0; n < MAX_REVIEWS_PER_PRODUCT; n += 1) fields.push(`r${n}`, "{}");
  await redis.pipeline([["HSET", `nl:rev:${STATS}:${PRODUCT}`, ...fields]]);
  asked = 0;
  const full = await saveReview(STATS, input("full@example.com", count("ok")), ROOM);
  is("full, and the month's save never asked for", [full.state, asked], ["full", 0]);

  part("A save admitted that finds no room: noroom, and the route's give-back keeps the month's save");
  redis.clear();
  let admitted = false;
  const take = async () => {
    const taken = await withinMonthWhy("review-saves", "cs_room", 1, MONTH, KEEP);
    admitted = taken === "ok";
    return taken;
  };
  // The store's data room refuses the growth: its script answers nothing a take reads as room.
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (batch: (string | number)[][]) => (roomOnly(batch) ? batch.map(() => null) : real(batch))) as typeof redis.pipeline;
  const noroom = await saveReview(STATS, input("room@example.com", take), ROOM);
  redis.pipeline = real;
  is("no room: answered noroom, after the admission", [noroom.state, admitted], ["noroom", true]);
  is("nothing written", await readReview(STATS, PRODUCT, reviewId(STATS, PRODUCT, "room@example.com")), null);
  // As app/api/store/review does on noroom after an admission.
  if (noroom.state === "noroom" && admitted) await giveBackMonth("review-saves", "cs_room", MONTH, KEEP);
  is("the order's save this month is still there", await monthCountWhy("review-saves", "cs_room", 1, MONTH), "ok");
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
