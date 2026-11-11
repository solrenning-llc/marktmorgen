/**
 * Two versions of one email's words, the rest of the list getting the one
 * that did better (107 [E2-BROADCAST-CONTENT-AB], unit 1; added 10 November
 * 2026): the rules, on synthetic text and counts only. Nothing is sent.
 */
import { MAX_MAIL_BODY } from "@/lib/mail";
import {
  CONTENT_PROBLEMS,
  chooseContent,
  newContentTest,
  parseContentTest,
} from "@/lib/mail-content-test";
import { type Counted, MIN_TEST_REACH, TEST_HOURS, TEST_SHARES, chooseSubject } from "@/lib/mail-test";
import { done, is, part } from "./check";

const STORE = "https://marktmorgen.com/@shop";
const A = `Hi! My new course is out.\n\n${STORE}/course`;
const B = `The course you asked about is ready.\n\n${STORE}/course`;
const links = (body: string) => body.includes(STORE);
const ctx = { bodyA: A, maxBody: MAX_MAIL_BODY, subjectTest: false, linksToStore: links };

part("Asked for, or not");
is("no second version asked: one email, as today", [newContentTest(undefined, ctx), newContentTest(null, ctx), newContentTest({}, ctx), newContentTest({ bodyB: undefined }, ctx)], ["none", "none", "none", "none"]);
const made = newContentTest({ bodyB: B, share: 30, hours: 12, by: "sales" }, ctx);
is(
  "a second version, with the creator's choices",
  made,
  { bodyB: B, share: 30, hours: 12, by: "sales", a: 0, b: 0, endsAt: 0, winner: "", visits: null, sales: null, why: "", skipped: false },
);
is(
  "choices out of the lists fall back to the subject test's own defaults",
  [newContentTest({ bodyB: B, share: 99, hours: 7, by: "opens" }, ctx)].map((t) => typeof t === "object" && [t.share, t.hours, t.by]),
  [[TEST_SHARES[0], TEST_HOURS[1], "visits"]],
);
is("line ends are kept as the first version's are read: \\r\\n is \\n", (newContentTest({ bodyB: B.replace(/\n/g, "\r\n") }, ctx) as { bodyB: string }).bodyB, B);

part("Refused while the email can still be changed, never a result that means nothing");
is("one change at a time: never with a second subject line", newContentTest({ bodyB: B }, { ...ctx, subjectTest: true }), "both");
is("an empty second version", [newContentTest({ bodyB: "" }, ctx), newContentTest({ bodyB: "   \n " }, ctx), newContentTest({ bodyB: 42 }, ctx)], ["body", "body", "body"]);
is("the same words, spaces aside", newContentTest({ bodyB: `  ${A.replace(/ /g, "  ")}  ` }, ctx), "same");
is("longer than an email may be: refused, never cut", newContentTest({ bodyB: `${STORE} ${"x".repeat(MAX_MAIL_BODY)}` }, ctx), "long");
is("a part of a template left to write", newContentTest({ bodyB: `Hi ⟦name⟧, ${STORE}` }, ctx), "placeholder");
is(
  "each version needs a link to the store: what it brings is what decides",
  [newContentTest({ bodyB: "No link here." }, ctx), newContentTest({ bodyB: B }, { ...ctx, bodyA: "No link in the first." })],
  ["link", "link"],
);
is("every problem has a sentence that says how to fix it", Object.keys(CONTENT_PROBLEMS).sort(), ["body", "both", "link", "long", "placeholder", "same"]);
is("the sentences are whole", Object.values(CONTENT_PROBLEMS).every((w) => w.length > 20 && w.endsWith(".")), true);
is("the smallest list a test needs is the subject test's", MIN_TEST_REACH, 100);

part("Read back as stored");
is("what was stored", parseContentTest({ ...(made as object), a: 60, b: 60, endsAt: 1_800_000_000, winner: "b", visits: { a: 3, b: 9 } }), { ...(made as object), a: 60, b: 60, endsAt: 1_800_000_000, winner: "b", visits: { a: 3, b: 9 } });
is("nothing usable is no test", [parseContentTest(null), parseContentTest({ bodyB: "" }), parseContentTest({ share: 20 })], [null, null, null]);
is("counts that are not whole numbers are not read as more", parseContentTest({ bodyB: B, a: -4, b: "9", visits: { a: 1.7, b: -1 } }), { bodyB: B, share: 20, hours: 4, by: "visits", a: 0, b: 0, endsAt: 0, winner: "", visits: null, sales: null, why: "", skipped: false });
// A stored pair with a count that does not read is unknown, never an invented 0 or a count cut down (rule 24; Claude 3
// and Codex G on #3654).
is("a pair with one count that does not read is unknown", [parseContentTest({ bodyB: B, sales: { a: "x", b: 5 } })?.sales, parseContentTest({ bodyB: B, visits: { a: 1.7, b: 3 } })?.visits], [null, null]);
is("control: a whole pair is read as it is", parseContentTest({ bodyB: B, sales: { a: 0, b: 5 } })?.sales, { a: 0, b: 5 });

part("The better version, by what it brought per email sent");
is(
  "by sales, sales not read and visits even: says the sales could not be read, never a tie (Codex G on #3654)",
  chooseContent({ a: 100, b: 100, by: "sales" }, { a: 5, b: 5 }, null).why,
  "Sales could not be read when the time was up, and visits did not set the versions apart, so the rest got the first one. It was not chosen on merit.",
);
const sent = { a: 100, b: 50, by: "visits" as const };
is("by visits", chooseContent(sent, { a: 10, b: 8 }, null), { winner: "b", why: "The second version brought 8 visits to your store from 50 emails, against 10 from 100, so the rest got it." });
is("by sales", chooseContent({ ...sent, by: "sales" }, { a: 1, b: 1 }, { a: 4, b: 1 }), { winner: "a", why: "The first version brought 4 sales from 100 emails, against 1 from 50, so the rest got it." });
is(
  "by sales, none ahead: visits decide, and it says so",
  chooseContent({ ...sent, by: "sales" }, { a: 2, b: 5 }, { a: 0, b: 0 }),
  { winner: "b", why: "Neither version had sold more when the time was up, so visits decided: the second version brought 5 visits to your store from 50 emails, against 2 from 100. The rest got it." },
);
is(
  "counts that could not be read: the first, and never said as a finding",
  chooseContent(sent, null, null),
  { winner: "a", why: "The counts could not be read when the time was up, so the rest got the first version. It was not chosen on merit." },
);
is(
  "a tie: the first, and never said as a finding",
  chooseContent(sent, { a: 10, b: 5 }, null),
  { winner: "a", why: "Neither version did better than the other in the time you gave it, so the rest got the first one. It was not chosen on merit." },
);
// The same rule as the subject test, everywhere: one decision, two kinds of test.
const counts: Counted[] = [null, { a: 0, b: 0 }, { a: 3, b: 1 }, { a: 1, b: 3 }, { a: 2, b: 1 }, { a: 6, b: 3 }];
const sizes = [{ a: 60, b: 60 }, { a: 61, b: 60 }, { a: 100, b: 50 }, { a: 0, b: 50 }];
let same = true;
for (const size of sizes) for (const by of ["visits", "sales"] as const) for (const v of counts) for (const s of counts) {
  if (chooseContent({ ...size, by }, v, s).winner !== chooseSubject({ ...size, by }, v, s).winner) same = false;
}
is("the winner is always the one the subject test would pick", same, true);

done();
