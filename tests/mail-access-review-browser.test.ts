/**
 * The email's "Can everyone read it?" panel in a real Chromium, from the regular suite: this file runs
 * tests/e2e/mail-access-review.mjs (axe with every WCAG 2.0–2.2 A/AA/AAA rule, 44 × 44 px targets, real Tab presses,
 * fixes said in the status region and undone, the studio's editor opening Write at the place) and holds its summary.
 * It runs here, not as a step of its own in .github/workflows/accessibility-studio-matrix.yml, so the PR that brings
 * the panel (#4414) touches no workflow file (Claude 5's review on 35b5533b09). Synthetic text, no server, nothing
 * sent; not a conformity claim, and no assistive technology is run.
 */
import { execFileSync } from "node:child_process";
import { done, is } from "./check";

const env = { ...process.env, E2E_BROWSER: "chromium" };
let out = "";
let status = 0;
try {
  out = execFileSync(process.execPath, ["tests/e2e/mail-access-review.mjs"], { encoding: "utf8", env, timeout: 180_000, maxBuffer: 4_000_000 });
} catch (error) {
  const failed = error as { stdout?: string; stderr?: string; status?: number | null };
  out = String(failed.stdout ?? "");
  status = failed.status ?? -1;
  console.log(String(failed.stderr ?? "").slice(0, 4_000));
}
for (const line of out.split("\n")) if (line.startsWith("FAIL")) console.log(line);

const line = out.split("\n").find((l) => l.startsWith("MAIL_ACCESS_REVIEW_SUMMARY:"));
const summary = line ? (JSON.parse(line.slice("MAIL_ACCESS_REVIEW_SUMMARY:".length)) as { engine: string; cases: number; failed: number }) : null;
is("the browser check ran to its end and said what it checked", summary !== null, true);
is("it ran in Chromium", summary?.engine, "chromium");
is("it checked the panel and the editor at both widths (at least 67 checks)", (summary?.cases ?? 0) >= 67, true);
is("not one of its checks failed", summary?.failed, 0);
is("and the process ended without an error", status, 0);
done();
