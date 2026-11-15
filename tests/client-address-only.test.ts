/**
 * Who asked is read in one place (Claude 7, 15/11/2026): lib/request-guard.ts clientAddress.
 *
 * Every per-connection limit (sign-in links and codes, free copies, order and membership links, checkouts, joins)
 * counts the address clientAddress reads. Ten places read the forwarding headers by hand instead, each with its own
 * copy of the rule, so a change to how the address is read (which header, which of its values, an IPv6 client by its
 * /64: #4628, #4637) would reach the limits through clientAddress and miss those ten. This test fails when a file
 * reads x-forwarded-for or x-real-ip itself. The files still doing so are named below, each held by an open pull
 * request that reserves it, or whose test is (docs/reservations.md: a file changed by an open pull request is reserved by it); each
 * moves to clientAddress when it is free, and the test fails if one is fixed and left on the list.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { done, is, part } from "./check";

const ROOT = process.cwd();
const READS = /\.get\(\s*["'`]x-(?:forwarded-for|real-ip)["'`]\s*\)/i;
/** The one reader. */
const OWNER = "lib/request-guard.ts";
/** Still reading by hand, each reserved by the open pull requests named (15/11/2026). */
const LEFT: Record<string, string> = {
  "app/[handle]/page.tsx": "#2850, #3067, #3636, #4535 and others",
  "app/api/auth/request/route.ts": "#3712; moved on claude7/auth-link-limit",
  "app/api/creators/route.ts": "#3495, #3584, #3717",
  "app/api/store/free/route.ts": "#3440, #3636, #4636 and others",
  "app/api/store/orders/route.ts": "#3068",
  "lib/ad-events.ts": "#3324, #3440",
  "lib/day-visit.ts": "free itself, but tests/room.test.ts, which holds its source text, is reserved by #1496",
  "lib/traffic.ts": "#3068, #3330, #4530 and others",
  "lib/visit.ts": "#1496",
};

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) continue;
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) out.push(relative(ROOT, path).split("\\").join("/"));
  }
  return out;
}

const readers = [...sources(join(ROOT, "app")), ...sources(join(ROOT, "lib"))]
  .filter((file) => READS.test(readFileSync(join(ROOT, file), "utf8")))
  .sort();

part("The forwarding headers are read by clientAddress alone");
is("the one reader still reads them", readers.includes(OWNER), true);
is("no other file reads them, except those still reserved", readers.filter((file) => file !== OWNER && !(file in LEFT)), []);
is("a file moved to clientAddress leaves the list", Object.keys(LEFT).filter((file) => !readers.includes(file)), []);

done();
