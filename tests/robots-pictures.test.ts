import assert from "node:assert/strict";
import test from "node:test";
import robots from "@/app/robots";

test("search engines may read the pictures a page points them to, and nothing else under /api/", () => {
  const rules = robots().rules;
  const rule = Array.isArray(rules) ? rules[0] : rules;
  const allow = ([] as string[]).concat(rule.allow ?? []);
  const disallow = ([] as string[]).concat(rule.disallow ?? []);
  assert.ok(allow.includes("/api/image/") && allow.includes("/api/photo/"));
  assert.ok(disallow.includes("/api/") && disallow.includes("/studio") && disallow.includes("/signin"));
  // Only those two doors: no other path under /api/ is opened.
  assert.deepEqual(allow.filter((path) => path.startsWith("/api/")).sort(), ["/api/image/", "/api/photo/"]);
});
