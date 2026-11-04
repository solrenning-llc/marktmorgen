import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { previewHandle } from "@/components/home-claim";
import { HANDLE_PATTERN } from "@/lib/store-handle-pattern";

/*
 * VS1 (queue item 571, owner 30/10/2026): one action in words at the top and
 * at the end, the store address, leading to the existing start page; the
 * menu has Pricing, Log in and one start button. Native anchors and a native
 * GET form, so every action works before any script loads.
 */
test("home actions are native, self-service and lead to the existing start page", () => {
  const page = readFileSync("app/page.tsx", "utf8");
  const claim = readFileSync("components/home-claim.tsx", "utf8");
  // The address form, twice (hero and end), is a GET to the start page.
  assert.match(claim, /<form action="\/signin" method="get"/);
  assert.match(claim, /name="handle"/);
  assert.equal((page.match(/<HeroClaim\b/g) ?? []).length, 1);
  assert.equal((page.match(/<ClaimForm\b/g) ?? []).length, 1);
  // The menu: Pricing, Log in, one start button, in the morning header the
  // home page shares with /pricing (components/morning-header.tsx).
  const header = readFileSync("components/morning-header.tsx", "utf8");
  assert.equal((page.match(/<MorningHeader \/>/g) ?? []).length, 1);
  for (const href of ['href="/pricing"', 'href="/signin?to=login"', 'href="/signin"']) assert.ok(header.includes(href), href);
  assert.doesNotMatch(page + claim + header, /<Link\b|Talk to an expert|Book a demo/);
  // The page itself starts nothing paid and calls nothing.
  assert.doesNotMatch(page + claim, /fetch\(|useEffect|localStorage|sessionStorage/);
});

test("the phone shows the typed address under the existing handle alphabet, never more", () => {
  is(previewHandle("  @Jenny.Cooks "), "jenny.cooks");
  is(previewHandle("hé llo<script>"), "hlloscript");
  is(previewHandle("a".repeat(40)).length, 24);
  // Whatever the preview shows is either empty or within the alphabet the claim accepts.
  for (const raw of ["Jenny", "x", "-bad-", "ok_name-1", "🙂🙂🙂"]) {
    assert.match(previewHandle(raw), /^[a-z0-9._-]*$/);
  }
  assert.ok(HANDLE_PATTERN.test(previewHandle("@HarborKitchen")));
});

test("the start page says a typed address back and reserves nothing", () => {
  const signin = readFileSync("app/signin/page.tsx", "utf8");
  // 568 [GD2] (j): the typed address is checked as a claim (the stricter rule), not only by its shape.
  assert.match(signin, /newAddressProblem\(asked\)/);
  assert.match(signin, /It is not held for you yet/);
  assert.doesNotMatch(signin.slice(signin.indexOf("const asked"), signin.indexOf("return (")), /fetch\(|claim|redis/i);
});

function is<T>(actual: T, expected: T) {
  assert.deepEqual(actual, expected);
}
