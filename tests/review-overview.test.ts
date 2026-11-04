/**
 * 636 [GL4](c): reviews by month in the studio (lib/review-overview.ts,
 * lib/reviews.ts reviewsSince, app/studio/reviews/page.tsx). Twelve months,
 * newest first, in UTC; a one-star review counts as much as a five; a hidden
 * review still counts; a refunded one is shown apart and left out of the
 * average; nothing outside the months or in the future is counted; the
 * reader returns real saved reviews and says when it read only part; the
 * page says when the months could not be read rather than showing none.
 */
import { readFileSync } from "node:fs";
import { OVERVIEW_MONTHS, byMonth, monthAverage, monthStart } from "@/lib/review-overview";
import { reviewsSince, saveReview, setHidden } from "@/lib/reviews";
import { addProduct, claimHandle, ensureStatsId } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const NOW = Date.UTC(2026, 10, 15, 12); // 15 November 2026
const review = (at: number, rating: number, refunded = false) => ({ createdAt: at, rating, refunded });

async function main(): Promise<void> {
  part("The months");
  const empty = byMonth([], NOW);
  is("twelve, newest first", [empty.length, empty[0].label, empty[11].label], [OVERVIEW_MONTHS, "November 2026", "December 2025"]);
  is("a month starts at midnight UTC on its first day", monthStart(NOW, 0), Date.UTC(2026, 10, 1));
  is("across a year", new Date(monthStart(NOW, 11)).toISOString(), "2025-12-01T00:00:00.000Z");

  part("Counted alike");
  const rows = byMonth(
    [
      review(Date.UTC(2026, 10, 2), 5),
      review(Date.UTC(2026, 10, 3), 1),
      review(Date.UTC(2026, 10, 4), 4, true),
      review(Date.UTC(2026, 9, 31, 23, 59), 2),
      review(Date.UTC(2025, 10, 30), 5),
      review(NOW + 1, 5),
    ],
    NOW,
  );
  is("November: a five and a one, counted alike", [rows[0].count, monthAverage(rows[0])], [2, 3]);
  is("the refunded one shown apart, out of the average", rows[0].refunded, 1);
  is("the last minute of October is October", [rows[1].count, monthAverage(rows[1])], [1, 2]);
  is("older than twelve months, or in the future: not counted", rows.reduce((n, r) => n + r.count + r.refunded, 0), 4);
  is("a month with none has no average", monthAverage(rows[5]), null);

  part("Read from the saved reviews");
  redis.clear();
  const owner = "review-overview@example.com";
  await claimHandle(owner, "review-overview", "Review Overview", "");
  const statsId = (await ensureStatsId(owner))!.statsId!;
  const made = await addProduct(owner, "Bread Course", "", "29", null);
  if (!made.ok) throw new Error("no product");
  const product = made.product.id;
  const base = { productId: product, pi: "pi_overview0001", text: "Plain words.", name: "Ana" };
  await saveReview(statsId, { ...base, email: "a@example.com", reference: "cs_test_overview001", rating: 5 }, ROOM, Date.UTC(2026, 10, 2));
  const low = await saveReview(statsId, { ...base, email: "b@example.com", reference: "cs_test_overview002", rating: 1 }, ROOM, Date.UTC(2026, 10, 3));
  await saveReview(statsId, { ...base, email: "c@example.com", reference: "cs_test_overview003", rating: 4 }, ROOM, Date.UTC(2024, 0, 3));
  if (low.state === "created") await setHidden(statsId, product, low.review.id, true, "off_topic");
  const read = await reviewsSince(statsId, monthStart(NOW, OVERVIEW_MONTHS - 1));
  is("the two of the last twelve months, newest first, the old one left out", [read.reviews.map((r) => r.rating), read.complete], [[1, 5], true]);
  const months = byMonth(read.reviews, NOW);
  is("the hidden one-star still counts", [months[0].count, monthAverage(months[0])], [2, 3]);
  let failed = false;
  await reviewsSince(null, 0).catch(() => {
    failed = true;
  });
  is("no store: an error, never an empty list", failed, true);

  part("The studio");
  const page = readFileSync("app/studio/reviews/page.tsx", "utf8");
  is("a table with a caption and headers", page.includes("<caption") && page.includes('scope="col"') && page.includes('scope="row"'), true);
  is("says when it could not read the months", page.includes("this does not mean there were no reviews"), true);
  is("says every star counts the same", page.includes("one star as much as five"), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
