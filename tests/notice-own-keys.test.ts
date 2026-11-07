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
 *     only behind Object.hasOwn on the same table and key;
 *   - the word tables those pages read (requests, agreements, Discord, move,
 *     community, community links, course links and certificates, store home)
 *     really do inherit these names in every language, so the guard is what
 *     stands between them and the page;
 *   - a sweep of every page file under app/ finds no other lookup by a key
 *     from the address without the guard, except the ones listed by name in
 *     NOT_HERE with the reason (another pull request owns the line, or the
 *     key is already narrowed). That includes keys written inline
 *     (`TABLE[typeof query.n === "string" ? query.n : ""]`).
 *
 * Synthetic only; nothing is read from Redis or sent.
 */
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReviewForm } from "@/components/review-form";
import { LessonComments } from "@/components/lesson-comments";
import { BOOKING_WORDS, bookingNotice } from "@/lib/buyer-words/booking";
import { agreementWords } from "@/lib/buyer-words/agreements";
import { discordWords } from "@/lib/buyer-words/discord";
import { moveWords } from "@/lib/buyer-words/move";
import { requestWords } from "@/lib/buyer-words/requests";
import { coursesWords } from "@/lib/buyer-words/courses";
import { speechFor } from "@/lib/buyer-words";
import { communityNotices, linkNotices } from "@/components/community-parts";
import { LANGUAGE_CODES } from "@/lib/store-language";

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
  ["app/[handle]/pay/[request]/page.tsx", "w.notices", "query.notice"],
  ["app/[handle]/sign/[agreement]/page.tsx", "w.notices", "query.notice"],
  ["app/[handle]/review/page.tsx", "REVIEW_NOTICES", "status"],
  ["app/affiliate/page.tsx", "STATUS", "query.status"],
  ["app/studio/discord/page.tsx", "NOTICES", "query.discord"],
  ["app/[handle]/discord/page.tsx", "w.notices", "status"],
  ["app/[handle]/move/[product]/page.tsx", "m.notices", "status"],
  ["app/privacy/delete/page.tsx", "STATUS", "statusKey"],
  ["app/[handle]/community/page.tsx", "notices", "word"],
  ["app/[handle]/community/page.tsx", "linkNotices(store.language)", "query.link"],
  ["app/[handle]/community/post/[post]/page.tsx", "notices", "query.n"],
  ["app/[handle]/community/you/page.tsx", "NOTICES", "query.n"],
  ["app/[handle]/community/search/page.tsx", "notices", "query.n"],
  ["app/[handle]/community/events/page.tsx", "notices", "query.n"],
  ["app/[handle]/community/events/[event]/page.tsx", "notices", "query.n"],
  ["app/[handle]/community/messages/page.tsx", "notices", "query.n"],
  ["app/[handle]/community/messages/[pair]/page.tsx", "NOTICES", "query.n"],
  ["app/[handle]/page.tsx", "w.notices", "query.status"],
  ["app/[handle]/course/[product]/page.tsx", "w.linkNotices", "query.link"],
  ["app/[handle]/course/[product]/page.tsx", "certNotices", "query.cert"],
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

/** The guarded read the pages above use, run on the tables they read. */
const pick = (table: object, key: string): unknown => (Object.hasOwn(table, key) ? (table as Record<string, unknown>)[key] : undefined);

const TABLES: [string, (language: string) => object][] = [
  ["requestWords().notices (pay)", (l) => requestWords(l).notices],
  ["agreementWords().notices (sign)", (l) => agreementWords(l).notices],
  ["discordWords().notices (store Discord page)", (l) => discordWords(l).notices],
  ["moveWords().notices (move)", (l) => moveWords(l).notices],
  ["communityNotices() (community pages)", (l) => communityNotices(l)],
  ["linkNotices() (community front page)", (l) => linkNotices(l)],
  ["coursesWords().linkNotices (course page)", (l) => coursesWords(l).linkNotices],
  ["speechFor().w.notices (store home page)", (l) => speechFor(l, "usd").w.notices],
];

/** The certificate notices are sentences, not { title } notices: the same proof with their own control. */
const certNotices = (language: string) => coursesWords(language).certNotices(2, 80);

test("coursesWords().certNotices (course page): every own key has words, in every language (control)", () => {
  for (const language of LANGUAGE_CODES) {
    const table = certNotices(language);
    assert.ok(Object.keys(table).length > 0, `${language}: no notices`);
    for (const key of Object.keys(table)) {
      const words = pick(table, key);
      assert.ok(typeof words === "string" && words.length > 0, `${language}.${key}`);
    }
  }
});

test("coursesWords().certNotices (course page): an inherited name reads as something unguarded and as nothing guarded", () => {
  for (const language of LANGUAGE_CODES) {
    const table = certNotices(language);
    for (const inherited of INHERITED) {
      assert.notEqual((table as Record<string, unknown>)[inherited], undefined, `${language}: ${inherited} is not inherited here`);
      assert.equal(pick(table, inherited), undefined, `${language}: ${inherited}`);
    }
  }
});

for (const [name, of] of TABLES) {
  test(`${name}: every own key is a notice with words, in every language (control)`, () => {
    for (const language of LANGUAGE_CODES) {
      const table = of(language);
      const keys = Object.keys(table);
      assert.ok(keys.length > 0, `${language}: no notices`);
      for (const key of keys) {
        // A notice has a title (pages with a heading) or a text (the community's one line).
        const notice = pick(table, key) as { title?: unknown; text?: unknown };
        const words = notice && (notice.title ?? notice.text);
        assert.ok(typeof words === "string" && words.length > 0, `${language}.${key}`);
      }
    }
  });
  test(`${name}: an inherited name reads as something unguarded and as nothing guarded`, () => {
    for (const language of LANGUAGE_CODES) {
      const table = of(language);
      for (const inherited of INHERITED) {
        assert.notEqual((table as Record<string, unknown>)[inherited], undefined, `${language}: ${inherited} is not inherited here`);
        assert.equal(pick(table, inherited), undefined, `${language}: ${inherited}`);
      }
    }
  });
}

/**
 * Lookups by a key from the address that the sweep below allows, each with
 * its reason. A key is `${file} ${table}[${key}]`; an inline key
 * (`typeof query.x === "string" ? query.x : ""`) is written as query.x. When
 * an entry is no longer found, the sweep fails so the list stays true.
 */
const NOT_HERE: Record<string, string> = {
  // Owned by another open pull request: that line is theirs.
  "app/[handle]/group/[group]/page.tsx g.groupNotices[status]": "#2654 (Claude 4) and claude5/fix-places-totals own this line",
  "app/studio/refund/page.tsx REFUND_DONE[query.done]": "#2849 (Claude 2, KB9 u3) owns app/studio/refund/page.tsx",
  // Not a key typed into the address.
  "app/[handle]/affiliates/page.tsx lw.status[status]": "an inner `status` (line.status, a LeadStatus) shadows ?status=",
  "app/embed/[handle]/join/page.tsx w.notices[status]": "status is already one of STATUSES or empty",
  "app/[handle]/thanks/page.tsx t.upsellNotes[query.upsell]": "read only after Object.hasOwn(UPSELL_NOTES, query.upsell)",
};

function pageFiles(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) pageFiles(path, into);
    else if (/^page\.tsx?$/.test(name)) into.push(path);
  }
  return into;
}

/** `table[key]` lookups in a page where the key came from the address, with no Object.hasOwn(table, key) in the file. */
function unguarded(path: string, text: string): string[] {
  // Helpers that read one value from the address: `const get = (name: string) => ... query[name] ...`.
  const getters = [...text.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*\([^)]*\)\s*=>[^\n]*\bquery\[/g)].map((m) => m[1]);
  const source = ["\\bquery\\.[A-Za-z_$]", ...getters.map((g) => `\\b${escape(g)}\\(`)].join("|");
  // Names that hold a value from the address: `const status = typeof query.status === "string" ? ... : ""`.
  const named = [...text.matchAll(new RegExp(`\\b(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=]+)?=\\s*[^;\\n]*(?:${source})`, "g"))].map((m) => m[1]);
  const inline = `typeof (query\\.[A-Za-z_$][\\w$]*) === "string" \\? query\\.[A-Za-z_$][\\w$]* : ""`;
  const keys = [inline, "query\\.[A-Za-z_$][\\w$]*", ...named.map(escape)].join("|");
  const table = "(?:[A-Za-z_$][\\w$]*\\.)*[A-Za-z_$][\\w$]*(?:\\([^()\\n]*\\))?";
  const lookup = new RegExp(`(?<![\\w$.\\]])(${table})\\[(?:${keys})(?: as [^\\]]+)?\\]`, "g");
  const found: string[] = [];
  for (const m of text.matchAll(lookup)) {
    const name = m[1];
    if (name === "query" || name === "params") continue;
    const key = m[2] ?? m[0].slice(name.length + 1).replace(/ as [^\]]+\]$|\]$/, "");
    if (new RegExp(`Object\\.hasOwn\\(${escape(name)}, ${escape(key)}\\)`).test(text)) continue;
    found.push(`${path} ${name}[${key}]`);
  }
  return found;
}

test("the sweep still finds a lookup it must find (control)", () => {
  const sample = 'const query = await searchParams;\nconst status = typeof query.status === "string" ? query.status : "";\nconst a = w.notices[status] ?? null;\nconst b = T(x)[typeof query.n === "string" ? query.n : ""];\nconst c = Object.hasOwn(OK, status) ? OK[status] : null;';
  assert.deepEqual(unguarded("x/page.tsx", sample), ["x/page.tsx w.notices[status]", "x/page.tsx T(x)[query.n]"]);
});

test("no page under app/ reads a table by a key from the address without Object.hasOwn, outside NOT_HERE", () => {
  const found = pageFiles("app").flatMap((path) => unguarded(path, readFileSync(path, "utf8")));
  const unexpected = [...new Set(found)].filter((one) => !Object.hasOwn(NOT_HERE, one));
  assert.deepEqual(unexpected, [], "guard these with Object.hasOwn (or list them in NOT_HERE with the reason)");
  const stale = Object.keys(NOT_HERE).filter((one) => !found.includes(one));
  assert.deepEqual(stale, [], "these are no longer found: take them out of NOT_HERE");
});
