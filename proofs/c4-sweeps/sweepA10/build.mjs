import { build } from "/home/user/marktmorgen/node_modules/esbuild/lib/main.js";
const here = (f) => new URL(f, import.meta.url).pathname;
const alias = { "@/lib/redis": here("./redis-stub.ts"), "@/lib/email": here("./email-stub.ts"), "@/lib/stats-report": here("./stats-report-stub.ts"), "@/lib/delivery": here("./delivery-stub.ts") };
for (const m of ["traffic", "usage-billing", "plan-standing", "benchmarks", "ad-spend", "data-recount", "watch-billing"]) alias["@/lib/" + m] = here("./" + m + "-stub.ts");
alias["@"] = "/home/user/marktmorgen/.claude/worktrees/sweepA10";
await build({ entryPoints: ["proof.ts"], bundle: true, platform: "node", format: "cjs", outfile: "proof.cjs", logLevel: "error", nodePaths: ["/home/user/marktmorgen/node_modules"], alias });
