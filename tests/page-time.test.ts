/**
 * 639 [GL7](25): how long measured visitors stay on a sales page
 * (lib/page-depth-rules.ts, lib/page-depth.ts, app/api/store/read,
 * components/page-depth.tsx, components/page-time.tsx). Counted in ranges
 * in the same command as the furthest block, never as a visitor of its own;
 * shown as each range's share once enough are measured; no cookie, nothing
 * about who; the privacy policy says so.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PageTime } from "@/components/page-time";
import { countDepth, readDepth } from "@/lib/page-depth";
import { TIME_RANGES, timeField, timeShares } from "@/lib/page-depth-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  part("The ranges");
  is("each stay in its range", [timeField(0), timeField(9.9), timeField(10), timeField(45), timeField(120), timeField(300), timeField(3600)], ["@t0", "@t0", "@t1", "@t2", "@t3", "@t4", "@t5"]);
  is("not a time a page could be open: none", [timeField(-1), timeField(86_401), timeField("x"), timeField(undefined), timeField(null)], [null, null, null, null, null]);
  is("a range field is never a block's", TIME_RANGES.every((r) => !/^[a-z0-9]{6}$/.test(r.field) && !r.field.startsWith("~")), true);
  is("shares from counts, each range said", timeShares({ "@t0": 2, "@t2": 6 }).map((r) => [r.words, r.count, r.share]), [["Under 10 seconds", 2, 25], ["10 to 30 seconds", 0, 0], ["30 seconds to 1 minute", 6, 75], ["1 to 3 minutes", 0, 0], ["3 to 10 minutes", 0, 0], ["10 minutes or more", 0, 0]]);
  is("nothing measured: every share 0", timeShares({}).every((r) => r.share === 0), true);

  part("Counted with the furthest block");
  redis.clear();
  const STATS = "a".repeat(32);
  await countDepth(STATS, "prod01", "blk001", "", "", 42);
  await countDepth(STATS, "prod01", "blk002", "", "", 5);
  await countDepth(STATS, "prod01", "blk002");
  const read = await readDepth(STATS, "prod01");
  is("visitors and blocks as before: a stay is not a visitor of its own", [read.visitors, read.stopped], [3, { blk001: 1, blk002: 2 }]);
  is("each stay in its range", read.time, { "@t2": 1, "@t0": 1 });
  await countDepth(STATS, "prod01", "not a block", "", "", 20);
  is("a reading with no real block counts no stay either", (await readDepth(STATS, "prod01")).time, { "@t2": 1, "@t0": 1 });

  part("A full blocks' record");
  redis.clear();
  // 120 fields already, the most a page's record keeps (DEPTH_FIELDS_MAX).
  const full = "b".repeat(32);
  for (let i = 0; i < 120; i += 1) await countDepth(full, "prod02", `blk${String(i).padStart(3, "0")}`);
  await countDepth(full, "prod02", "blk000", "", "", 42);
  const fullRead = await readDepth(full, "prod02");
  is("a stay never pushes anything into the overflow: no visitor counted twice", [fullRead.visitors, fullRead.stopped["~"]], [121, undefined]);
  is("and the stay is still counted, in its own record", fullRead.time, { "@t2": 1 });

  part("Sent, received, shown");
  const page = readFileSync("components/page-depth.tsx", "utf8");
  is("the page sends only the seconds it was visible, added up", page.includes('let visibleSince: number | null = document.visibilityState === "visible" ? performance.now() : null;') && page.includes("seenMs += performance.now() - visibleSince;") && page.includes("s: seenSeconds()"), true);
  is("the route passes them on, in the same count", readFileSync("app/api/store/read/route.ts", "utf8").includes("countDepth(statsId, scope, block, whyNot, video, body.s)"), true);
  is("the studio route says them, test or not", readFileSync("app/api/store/depth/route.ts", "utf8").includes("time: timeShares(depth.time)"), true);
  const few = renderToStaticMarkup(createElement(PageTime, { ranges: timeShares({ "@t0": 3 }), least: 20 }));
  is("too few measured: said how many so far, nothing shown", few.includes("Shown once 20 visitors have been measured; 3 so far.") && !few.includes("<table"), true);
  const shown = renderToStaticMarkup(createElement(PageTime, { ranges: timeShares({ "@t0": 10, "@t3": 30 }), least: 20 }));
  is("the screen says the time runs until they first switch away, and that it can read shorter (inbox C3-46, item 4)", shown.includes("until they first switched to another tab or app or left") && shown.includes("can read shorter than the real ones, more often on phones"), true);
  is("enough: a table of ranges, with headers, each share as counted", shown.includes('aria-labelledby="page-time-title"') && shown.includes("<caption") && shown.includes('scope="col"') && shown.includes('scope="row"') && shown.includes(">75%<") && shown.includes(">25%<"), true);
  is("no average made up from ranges", /average|about \d/i.test(shown), false);
  is("said to be one in eight, no cookie, nothing about who", shown.includes("one in eight, with no cookie and nothing about who they are"), true);
  const privacy = readFileSync("app/privacy/page.tsx", "utf8");
  is("the privacy policy says the range is sent too", privacy.includes("how long the page was open in front of them, as one of six ranges") && privacy.includes("measured until they first\n          switch to another tab or app or leave"), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
