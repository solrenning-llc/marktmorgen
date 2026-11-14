/**
 * ALL-194 (coordinator, 14/11/2026): CodeQL (javascript-typescript) was cancelled at its 60-minute job limit in about
 * 45% of merge groups. The logs show time, not memory: run-queries already uses every core of the runner (--threads=4)
 * and ~14 GB (--ram=14568), shows no memory error, and was cancelled with 82 of 105 queries done; completed runs take
 * 27 to 54 minutes. The analyze job gets 120 minutes, well inside the merge queue's own 360-minute check timeout,
 * while the coverage stays exactly the same: both languages, security-extended, build-mode none, no paths-ignore.
 * Reads .github/workflows/codeql.yml as it is.
 */
import { readFileSync } from "node:fs";
import { codeqlTimeout } from "../scripts/queue_health_report.mjs";
import { done, is, part } from "./check";

const yaml = readFileSync(".github/workflows/codeql.yml", "utf8");

part("Time to finish");
is("the analyze job may run 120 minutes, read as the queue health report reads it", codeqlTimeout(yaml), 120);

part("The same coverage");
is("both languages are analyzed", /language: \[javascript-typescript, actions\]/.test(yaml), true);
is("with the security-extended queries and build-mode none", [/queries: security-extended/.test(yaml), /build-mode: none/.test(yaml)], [true, true]);
is("no path is left out of the analysis", /paths-ignore|paths:/.test(yaml), false);
is("All checks (codeql) still needs the analysis", /needs: \[analyze, documentation-scope\]/.test(yaml), true);
done();
