import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

// Completeness audit, lot 3 (docs/completeness-audit/lot-03.json, PR #2706).
// Every path:line reference is checked against the main commit the audit
// records, so later edits to a cited file cannot break this test, and a
// reference past the end of its file at that commit fails.
const lot = JSON.parse(readFileSync("docs/completeness-audit/lot-03.json", "utf8")) as Record<string, unknown>;
const lot1 = JSON.parse(readFileSync("docs/completeness-audit/lot-01.json", "utf8")) as Record<string, unknown>;

part("Lot 3 uses the same top-level keys as lots 1 and 2");
is("top-level keys match lot 1", Object.keys(lot).join(","), Object.keys(lot1).join(","));
is("the items list is under `items`", Array.isArray(lot.items) && (lot.items as unknown[]).length, 40);

part("Every path:line reference resolves at the recorded main commit");
const snapshot = String(lot.main ?? "");
is("the recorded main commit is a short or full sha", /^[0-9a-f]{7,40}$/.test(snapshot), true);
// CI checks out with depth 1, so the recorded commit is not in history there.
// The line count of every cited file at that commit is kept in
// tests/completeness-audit-lot-03-lines.json (taken with `git show <main>:<path>`),
// so the check needs no other commit. When the commit is in this checkout, the
// kept counts are verified against it as well.
const kept = JSON.parse(readFileSync("tests/completeness-audit-lot-03-lines.json", "utf8")) as { main: string; lineCounts: Record<string, number> };
is("the kept line counts are for the recorded commit", kept.main, snapshot);
const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
let inHistory = true;
try { git(["cat-file", "-e", `${snapshot}^{commit}`]); } catch { inHistory = false; }
{
  const files = new Set(Object.keys(kept.lineCounts));
  const lengthOf = (path: string) => kept.lineCounts[path];
  if (inHistory) {
    const wrong = Object.entries(kept.lineCounts).filter(([path, n]) => git(["show", `${snapshot}:${path}`]).split("\n").length - 1 !== n).map(([path]) => path);
    is(`kept line counts match ${snapshot}`, wrong, []);
  }
  const reference = /([A-Za-z0-9_.\-/[\]@]+\.(?:tsx?|mjs|cjs|js|json|md|ya?ml|py|css)):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)/g;
  const broken: string[] = [];
  let checked = 0;
  for (const match of JSON.stringify(lot).matchAll(reference)) {
    const path = match[1] === "queue.md" ? "docs/codex-queue.md" : match[1];
    if (!files.has(path)) { broken.push(`${match[0]} (no such file)`); continue; }
    for (const range of match[2].split(",")) {
      checked++;
      const [low, high = low] = range.split("-").map(Number);
      if (low < 1 || high < low || high > lengthOf(path)) broken.push(`${match[0]} (${path} has ${lengthOf(path)} lines)`);
    }
  }
  is("references were found", checked > 400, true);
  is("no reference points past the end of its file", broken, []);
}
done();
