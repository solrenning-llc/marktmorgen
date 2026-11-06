import { build } from "/home/user/marktmorgen/node_modules/esbuild/lib/main.js";
const root = "/home/user/marktmorgen/.claude/worktrees/sweep4";
await build({ entryPoints: ["proof2.ts"], bundle: true, platform: "node", format: "cjs", outfile: "proof2.cjs", logLevel: "error",
  nodePaths: ["/home/user/marktmorgen/node_modules"],
  alias: { "@/lib/redis": new URL("./redis-stub.ts", import.meta.url).pathname, "@": root } });
