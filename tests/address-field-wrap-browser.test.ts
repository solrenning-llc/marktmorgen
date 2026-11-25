/**
 * The store address field laid out in a real Chromium, from the regular suite (Claude 3 cloud O's LEVE on #4498,
 * 6872872616): tests/address-prefix-wrap.test.ts reads the class strings; this runs tests/e2e/address-field-wrap.mjs,
 * which draws both forms with the site's own style sheet at 195, 320 and 390 px and checks no horizontal scroll, the
 * field at least 6 rem wide and "marktmorgen.com/" never broken inside. Synthetic, no server, nothing sent; not a
 * conformity claim (WCAG 1.4.10 Reflow measured in one engine only).
 */
import { execFileSync } from "node:child_process";
import { done, is } from "./check";

let out = "";
let status = 0;
try {
  out = execFileSync(process.execPath, ["tests/e2e/address-field-wrap.mjs"], { encoding: "utf8", timeout: 180_000, maxBuffer: 2_000_000 });
} catch (error) {
  const failed = error as { stdout?: string; stderr?: string; status?: number | null };
  out = String(failed.stdout ?? "");
  status = failed.status ?? -1;
  console.log(String(failed.stderr ?? "").slice(0, 4_000));
}
for (const line of out.split("\n")) if (line.startsWith("FAIL")) console.log(line);

const line = out.split("\n").find((l) => l.startsWith("ADDRESS_FIELD_WRAP_SUMMARY:"));
const summary = line ? (JSON.parse(line.slice("ADDRESS_FIELD_WRAP_SUMMARY:".length)) as { engine: string; cases: number; failed: number }) : null;
is("the browser check ran to its end and said what it checked", summary !== null, true);
is("it ran in Chromium", summary?.engine, "chromium");
is("both forms at the three widths (at least 31 checks)", (summary?.cases ?? 0) >= 31, true);
is("not one of its checks failed", summary?.failed, 0);
is("and the process ended without an error", status, 0);
done();
