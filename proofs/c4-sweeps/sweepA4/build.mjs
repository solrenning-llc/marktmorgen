import { build } from "/home/user/marktmorgen/node_modules/esbuild/lib/main.js";
const root = "/home/user/marktmorgen/.claude/worktrees/sweepA4";
await build({ entryPoints: ["proof.ts"], bundle: true, platform: "node", format: "cjs", outfile: "proof.cjs", logLevel: "error",
  nodePaths: ["/home/user/marktmorgen/node_modules"],
  alias: { "@/lib/catalog": new URL("./catalog-stub.ts", import.meta.url).pathname, "@/lib/redis": new URL("./redis-stub.ts", import.meta.url).pathname, "@": root } });
