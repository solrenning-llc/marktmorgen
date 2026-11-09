/**
 * A word taken from the address (`?status=`, `?notice=`, `?done=`, ...) picks a
 * notice only when it is one of the table's own keys. A bare index reads the
 * prototype too: "?status=constructor" finds Object's own constructor (a
 * function) and the page shows a broken notice, or none where a fallback was
 * due. Each page and helper below reads its table with Object.hasOwn, as
 * app/library/page.tsx and app/[handle]/community/page.tsx already did.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BOOKING_WORDS, bookingNotice } from "@/lib/buyer-words/booking";

test("a bare index reaches the prototype", () => {
  assert.equal(typeof ({} as Record<string, unknown>)["constructor"], "function");
});

test("the booking notice reads only its own keys", () => {
  for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.equal(bookingNotice(BOOKING_WORDS.en, key, [], 30), null, key);
  }
});

test("every page reads a notice named in its address only from the table's own keys", () => {
  const bare: [string, RegExp][] = [
    ["app/affiliate/page.tsx", /"string" \? STATUS\[query\.status\]/],
    ["app/[handle]/manage/page.tsx", /: m\.manageNotices\[status\] \?\?/],
    ["app/[handle]/manage/page.tsx", /\(pauseNotice\[status\] \?/],
    ["app/[handle]/affiliates/page.tsx", /a\.notices\[status\] \?\? null/],
    ["app/[handle]/book/[product]/page.tsx", /moved \? null : b\.moveNotices\[status\]/],
    ["app/[handle]/contact/page.tsx", /\(w\.notices\[status\] \?\?/],
    ["app/[handle]/discord/page.tsx", /\(w\.notices\[status as keyof/],
    ["app/[handle]/free/page.tsx", /"string" \? ww\.notices\[query\.welcome/],
    ["app/[handle]/free/page.tsx", /= g\.freeNotices\[status\] \?\?/],
    ["app/[handle]/join/page.tsx", /= w\.notices\[status\] \?\?/],
    ["app/[handle]/left/page.tsx", /status && notices\[status\]\)/],
    ["app/[handle]/manage/card/page.tsx", /= m\.cardNotices\[status\] \?\?/],
    ["app/[handle]/move/[product]/page.tsx", /: m\.notices\[status as keyof/],
    ["app/[handle]/pay/[request]/page.tsx", /"string" \? w\.notices\[query\.notice\]/],
    ["app/[handle]/renew/[product]/page.tsx", /: notices\[status\];/],
    ["app/[handle]/sign/[agreement]/page.tsx", /!== "signed" \? w\.notices\[query\.notice\]/],
    ["app/[handle]/waitlist/page.tsx", /= g\.waitNotices\[status\] \?\?/],
    ["app/[handle]/orders/page.tsx", /: NOTICES\[status\] \?\? null/],
    ["app/[handle]/review/page.tsx", /&& REVIEW_NOTICES\[status\] \?/],
    ["app/[handle]/thanks/page.tsx", /"string" && REVIEW_NOTICES\[query\.review\]/],
    ["app/privacy/delete/page.tsx", /= STATUS\[statusKey\];/],
    ["app/signin/code/page.tsx", /= NOTICES\[status\] \?\? null/],
    ["app/signin/page.tsx", /: NOTICES\[status\];/],
    ["app/studio/discord/page.tsx", /"string" \? NOTICES\[query\.discord\]/],
    ["app/studio/refund/page.tsx", /"string" \? REFUND_DONE\[query\.done\]/],
    ["lib/buyer-words/booking.ts", /= words\.notices\[status\] \?\? null/],
  ];
  for (const [file, re] of bare) assert.doesNotMatch(readFileSync(file, "utf8"), re, `${file}: bare read left`);
});
