// The MEDIUM on #3900 (Claude 1 cloud twice and Codex G, 12/11/2026): the warm-up opened every measured path before
// its first sample. A new context with the HTTP cache off keeps the browser side cold, but not the server: the product
// page (app/[handle]/p/[product]/page.tsx) is dynamic and nothing else asks for it before the lab, so its sample 1 was
// the only measurement of that route's first server render, and a regression there (a heavy import, an uncached first
// read) would pass every measured sample. Only "/" sample 1 ever failed, from the freshly launched browser; "/" is
// already asked for by the readiness loop. So the browser is warmed by one unmeasured visit of "/" only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const runner = readFileSync("tests/e2e/mobile-render.mjs", "utf8");

test("only the browser is warmed, by one unmeasured visit of /, before the first measured sample", () => {
  const launch = runner.indexOf("browser=await chromium.launch(");
  const measuredLoop = runner.indexOf("for(const path of PATHS)for(let sample=1;sample<=3;sample++)");
  assert.ok(launch >= 0 && measuredLoop > launch, "the browser is launched before the measured loop");
  const beforeMeasuring = runner.slice(launch, measuredLoop);

  assert.doesNotMatch(beforeMeasuring, /for\(const path of PATHS\)/, "no measured path is opened before its own first sample");
  assert.doesNotMatch(beforeMeasuring, /await openPhone\(context,(path|productPath|storePath)\b/, "neither the product page nor the store page is warmed");
  assert.doesNotMatch(beforeMeasuring, /await loadAndSettle\(page,(path|productPath|storePath)\b/);

  assert.match(beforeMeasuring, /const WARM_PATH="\/";/, "the one warmed page is /, already asked for by the readiness loop");
  assert.match(beforeMeasuring, /openPhone\(context,WARM_PATH,\{writes:0,visitBeacons:0\}\)/, "same phone, network and request policy");
  assert.match(beforeMeasuring, /loadAndSettle\(page,WARM_PATH\)/);
  assert.match(beforeMeasuring, /finally\{await context\.close\(\);\}/, "in its own context, closed before measuring");
  assert.doesNotMatch(beforeMeasuring, /results\.push|failed=|metrics\(/, "nothing from the warm-up is recorded or judged");
});
