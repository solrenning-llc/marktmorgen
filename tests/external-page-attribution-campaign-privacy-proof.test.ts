import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { scriptTags } from "@/lib/embed-sites";

test("the reused campaign cleaner does not remove personal data", () => {
  assert.equal(scriptTags({ utm_campaign: "alice@example.com" }).utm_campaign, "aliceexample.com");
});

test("the study requires campaign values themselves to refuse personal data", () => {
  const study = readFileSync("docs/external-page-attribution-study.md", "utf8");
  assert.match(
    study,
    /campaign (?:tag )?values[^.]{0,240}(?:reject|refuse)[^.]{0,240}(?:personal data|email|name)/i,
  );
});
