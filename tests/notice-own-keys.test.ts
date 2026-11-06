/**
 * A key typed into the address (?status=, ?review=, ?welcome=, ?c=) picks a
 * notice only when the table itself holds it. "constructor", "toString",
 * "__proto__" and the like are inherited from Object.prototype: read from a
 * plain table they give a function or the prototype, which draws an empty
 * status line, a heading with no words, or throws while rendering. They must
 * read as no notice at all (or as the page's own fallback), never as one.
 *
 * Siblings of #2936 and #3000 (same fix, other pages):
 *   - components/review-form.tsx and components/lesson-comments.tsx are
 *     rendered with each inherited name and must equal the render with none;
 *   - bookingNotice (lib/buyer-words/booking.ts) returns null for them;
 *   - every page that looks a notice table up by the raw address key does so
 *     only behind Object.hasOwn on the same table and key.
 *
 * Synthetic only; nothing is read from Redis or sent.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReviewForm } from "@/components/review-form";
import { LessonComments } from "@/components/lesson-comments";
import { BOOKING_WORDS, bookingNotice } from "@/lib/buyer-words/booking";

const INHERITED = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "isPrototypeOf"];

function quietly(run: () => string): { out: string; warned: string[] } {
  const warned: string[] = [];
  const was = console.error;
  console.error = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
  try {
    return { out: run(), warned };
  } catch (error) {
    return { out: `THREW: ${(error as Error).message}`, warned };
  } finally {
    console.error = was;
  }
}

const review = (notice: string | null) =>
  quietly(() =>
    renderToStaticMarkup(
      createElement(ReviewForm, {
        handle: "shop",
        door: { order: "cs_test_synthetic" },
        product: { id: "p1", title: "A synthetic product" },
        existing: null,
        storeName: "Synthetic Store",
        back: "thanks",
        notice,
      }),
    ),
  );

const comments = (notice: string) =>
  quietly(() =>
    renderToStaticMarkup(
      createElement(LessonComments, {
        threads: [],
        reader: "student-synthetic",
        storeName: "Synthetic Store",
        hidden: { handle: "shop", product: "p1", lesson: "l1" },
        myName: "Dana",
        notice,
        now: 1_800_000_000,
      }),
    ),
  );

test("the review form still shows its own notice (control)", () => {
  const { out, warned } = review("saved");
  assert.notEqual(out, review(null).out);
  assert.match(out, /role="status"/);
  assert.deepEqual(warned, []);
});

for (const name of INHERITED) {
  test(`the review form with notice ${name} is the form with no notice`, () => {
    const { out, warned } = review(name);
    assert.equal(out, review(null).out);
    assert.deepEqual(warned, []);
  });
}

test("lesson comments still show their own notice (control)", () => {
  const { out, warned } = comments("posted");
  assert.notEqual(out, comments("").out);
  assert.match(out, /cm-flash/);
  assert.deepEqual(warned, []);
});

for (const name of INHERITED) {
  test(`lesson comments with ?c=${name} show no notice`, () => {
    const { out, warned } = comments(name);
    assert.equal(out, comments("").out);
    assert.deepEqual(warned, []);
  });
}

test("bookingNotice still names a refused booking (control)", () => {
  const known = Object.keys(BOOKING_WORDS.en.notices)[0];
  assert.ok(known);
  assert.ok(bookingNotice(BOOKING_WORDS.en, known, [], 30));
});

for (const name of INHERITED) {
  test(`bookingNotice with status ${name} is no notice`, () => {
    assert.equal(bookingNotice(BOOKING_WORDS.en, name, [], 30), null);
  });
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** [file, the table as written, the key as written] for each lookup by a key from the address. */
const LOOKUPS: [string, string, string][] = [
  ["app/[handle]/orders/page.tsx", "NOTICES", "status"],
  ["app/[handle]/thanks/page.tsx", "REVIEW_NOTICES", "query.review"],
  ["components/review-form.tsx", "REVIEW_NOTICES", "notice"],
  ["components/review-form.tsx", "g.reviewNotices", "notice"],
  ["components/lesson-comments.tsx", "w.commentNotices", "notice"],
  ["app/library/page.tsx", "STATUS", "query.status"],
  ["lib/buyer-words/booking.ts", "words.notices", "status"],
  ["app/[handle]/book/[product]/page.tsx", "b.moveNotices", "status"],
  ["app/[handle]/renew/[product]/page.tsx", "notices", "status"],
  ["app/[handle]/podcast/[product]/page.tsx", "w.podcastNotices", "status"],
  ["app/[handle]/waitlist/page.tsx", "g.waitNotices", "status"],
  ["app/[handle]/manage/page.tsx", "m.manageNotices", "status"],
  ["app/[handle]/manage/page.tsx", "pauseNotice", "status"],
  ["app/[handle]/manage/card/page.tsx", "m.cardNotices", "status"],
  ["app/[handle]/left/page.tsx", "notices", "status"],
  ["app/[handle]/contact/page.tsx", "w.notices", "status"],
  ["app/[handle]/free/page.tsx", "g.freeNotices", "status"],
  ["app/[handle]/free/page.tsx", "ww.notices", "query.welcome"],
  ["app/[handle]/affiliates/page.tsx", "a.notices", "status"],
  ["app/[handle]/join/page.tsx", "w.notices", "status"],
];

for (const [path, table, key] of LOOKUPS) {
  test(`${path} reads ${table}[${key}] only as one of the table's own keys`, () => {
    const text = readFileSync(path, "utf8");
    // A lookup, with or without a cast on the key; not one inside a longer name.
    const raw = (text.match(new RegExp(`(?<![\\w.])${escape(table)}\\[${escape(key)}(?: as [^\\]]+)?\\]`, "g")) ?? []).length;
    const guarded = (text.match(new RegExp(`Object\\.hasOwn\\(${escape(table)}, ${escape(key)}\\)`, "g")) ?? []).length;
    // thanks only asks whether ?review= is one of the keys, so its guard may stand alone.
    assert.ok(raw + guarded >= 1, `${table}[${key}] is no longer looked up here: update this list`);
    assert.ok(guarded >= 1 && raw <= guarded, `${raw} lookups, ${guarded} guarded`);
  });
}
