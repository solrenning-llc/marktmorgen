// The course page's ?link= and ?cert= notices are typed by whoever writes the
// link. A name every object inherits (constructor, toString, __proto__,
// hasOwnProperty) is not one of the notices: the page must show none, never a
// box whose title and body are read off a function (found reviewing the
// course-link reply, CX-123 rule 30).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { coursesWords, noticeFor } from "@/lib/buyer-words/courses";
import { LANGUAGE_CODES } from "@/lib/store-language";

const INHERITED = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"];
const page = readFileSync("app/[handle]/course/[product]/page.tsx", "utf8");

test("an inherited name is something on the plain notices, which is why the page must not index them", () => {
  for (const code of LANGUAGE_CODES) {
    const w = coursesWords(code);
    assert.equal(typeof (w.linkNotices as Record<string, unknown>).constructor, "function", code);
    assert.equal(typeof (w.certNotices(2, 80) as Record<string, unknown>).toString, "function", code);
  }
});

test("the course page never indexes its notices with what the query says", () => {
  assert.doesNotMatch(page, /linkNotices\[/, "?link= is looked up only among the notices' own names");
  assert.doesNotMatch(page, /certNotices\([^)]*\)\[/, "?cert= is looked up only among the notices' own names");
});

test("only the notices' own names are notices, in every language", () => {
  for (const code of LANGUAGE_CODES) {
    const w = coursesWords(code);
    const certs = w.certNotices(2, 80);
    for (const name of INHERITED) {
      assert.equal(noticeFor(w.linkNotices, name), null, `${code}: ?link=${name}`);
      assert.equal(noticeFor(certs, name), null, `${code}: ?cert=${name}`);
    }
    for (const name of [undefined, "", ["sent"], 1]) assert.equal(noticeFor(w.linkNotices, name), null, `${code}: ${String(name)}`);
    assert.equal(noticeFor(w.linkNotices, "sent"), w.linkNotices.sent, code);
    assert.equal(noticeFor(certs, "name"), certs.name, code);
  }
});

test("the course page reads both notices through noticeFor", () => {
  assert.match(page, /noticeFor\(w\.linkNotices, query\.link\)/);
  assert.match(page, /noticeFor\(w\.certNotices\(MIN_CERT_NAME, MAX_CERT_NAME\), query\.cert\)/);
});
