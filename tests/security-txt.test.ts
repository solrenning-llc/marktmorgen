import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import { FEATURE_PAGES } from "@/lib/feature-pages";

// 508 [SG4] part 2: /.well-known/security.txt (RFC 9116), served from public/ (the proxy skips paths with an extension).
const text = readFileSync("public/.well-known/security.txt", "utf8");
const fields = new Map<string, string[]>();
for (const line of text.split("\n")) {
  if (!line.trim() || line.startsWith("#")) continue;
  const match = /^([A-Za-z-]+): (.+)$/.exec(line);
  assert.ok(match, `not a field: ${line}`);
  fields.set(match[1].toLowerCase(), [...(fields.get(match[1].toLowerCase()) ?? []), match[2]]);
}

test("security.txt has the fields RFC 9116 asks for, each once where it must be", () => {
  assert.deepEqual(fields.get("contact"), [`mailto:${SUPPORT_EMAIL}`]);
  assert.equal(fields.get("expires")?.length, 1);
  assert.deepEqual(fields.get("canonical"), ["https://marktmorgen.com/.well-known/security.txt"]);
  assert.deepEqual(fields.get("preferred-languages"), ["en"]);
  assert.ok(text.endsWith("\n"));
});

test("it has not expired, and is renewed a month before it does, never set more than a year ahead", () => {
  const expires = Date.parse(fields.get("expires")?.[0] ?? "");
  assert.ok(Number.isFinite(expires));
  const now = Date.now();
  assert.ok(expires - now > 30 * 86_400_000, "security.txt expires within 30 days: set a new Expires, under a year ahead");
  assert.ok(expires - now <= 366 * 86_400_000, "RFC 9116 recommends an Expires less than a year ahead");
});

test("its policy is the public security page, which names the same address and the file", () => {
  assert.deepEqual(fields.get("policy"), ["https://marktmorgen.com/platform/security"]);
  const page = FEATURE_PAGES.find((p) => p.slug === "security" && p.section === "platform");
  assert.ok(page);
  const words = JSON.stringify(page);
  assert.ok(words.includes(SUPPORT_EMAIL));
  assert.ok(words.includes("marktmorgen.com/.well-known/security.txt"));
});
