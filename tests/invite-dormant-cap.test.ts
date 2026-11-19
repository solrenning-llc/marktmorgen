/**
 * The creator invite pages (app/invite/[code]/page.tsx and its accept route)
 * read the database for any code a visitor types (lib/creator-invites.ts,
 * inviterFor), charged to no store, with no pace and no ceiling: the same
 * defect the short link had (Claude 5, 7 November 2026). Today the program is
 * closed (INVITE_PROGRAM_OPEN false) and both answer before any read, so
 * nothing costs. This holds that, and holds the day it opens: opening the
 * program fails here until each of them is bounded before inviterFor, as
 * app/l/[code]/route.ts is (lib/short-link-open.ts) or by the store's own
 * requests (lib/traffic.ts).
 */
import { readFileSync } from "node:fs";
import { INVITE_PROGRAM_OPEN } from "@/lib/creator-invite-rules";
import { done, is, part } from "./check";

const FILES = ["app/invite/[code]/page.tsx", "app/invite/[code]/accept/route.ts"];
const BOUNDS = ["withinLocalLimit(", "takePublicRequest(", "admitShortLinkOpen(", "essentialLimitState("];

/** What keeps a file from reading without a ceiling, for a program open or closed. */
function problems(open: boolean, sources: Record<string, string>): string[] {
  const found: string[] = [];
  for (const file of FILES) {
    const text = sources[file];
    const read = text.indexOf("inviterFor(");
    if (read < 0) { found.push(`${file}: inviterFor not found, read it again`); continue; }
    const closed = text.indexOf("if (!INVITE_PROGRAM_OPEN)");
    if (!open) {
      if (closed < 0 || closed > read) found.push(`${file}: the closed program must answer before inviterFor`);
      continue;
    }
    const bounded = BOUNDS.some((b) => { const at = text.indexOf(b); return at >= 0 && at < read; });
    if (!bounded) found.push(`${file}: an open program reads inviterFor with no pace or ceiling before it`);
  }
  return found;
}

const sources = Object.fromEntries(FILES.map((f) => [f, readFileSync(f, "utf8")]));

part("As the program is set");
is("closed, both answer before any read; open, both are bounded before inviterFor", problems(INVITE_PROGRAM_OPEN, sources), []);

part("The check itself, on synthetic sources");
const unbounded = Object.fromEntries(FILES.map((f) => [f, "const inviter = await inviterFor(code);"]));
const bounded = Object.fromEntries(FILES.map((f) => [f, "if (!withinLocalLimit(\"invite\", address, 30, 600_000)) return busy();\nconst inviter = await inviterFor(code);"]));
const closedLate = Object.fromEntries(FILES.map((f) => [f, "const inviter = await inviterFor(code);\nif (!INVITE_PROGRAM_OPEN) return paused();"]));
is("an open program reading with no ceiling is refused", problems(true, unbounded).length, FILES.length);
is("an open program bounded before the read passes", problems(true, bounded), []);
is("a closed program that reads before it answers is refused", problems(false, closedLate).length, FILES.length);
console.log(`  the pages as they are, were the program opened: ${JSON.stringify(problems(true, sources))}`);

done();
