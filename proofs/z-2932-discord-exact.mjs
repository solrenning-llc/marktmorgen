import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, ["tests/g-proof-run.mjs", "z-2932-discord-exact.proof.ts"], {
  cwd: new URL("..", import.meta.url),
  env: process.env,
  stdio: "inherit",
});

process.exitCode = result.status ?? 1;
