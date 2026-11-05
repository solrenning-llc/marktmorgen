/**
 * Build synthetic GitHub Actions fixtures without a live Google Fonts dependency.
 * Production keeps its normal "next build" and real approved typography.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ciBuildNodeEnvironment } from "./ci-build-args.mjs";

if (process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("ci-build.mjs is only for synthetic GitHub Actions builds; use npm run build elsewhere");
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const font = await readFile(join(root, "node_modules/next/dist/next-devtools/server/font/geist-latin.woff2"));
if (font.length > 1_048_576 || font.subarray(0, 4).toString() !== "wOF2") {
  throw new Error("The installed Next test font is not a bounded WOFF2 file");
}
const server = createServer((request, response) => {
  if (request.method !== "GET" || request.url !== "/fonts/mock.woff2") {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, { "Content-Type": "font/woff2", "Content-Length": font.length, "Cache-Control": "no-store" });
  response.end(font);
});
server.requestTimeout = 5_000;
server.headersTimeout = 5_000;
await new Promise((accept, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", accept);
});
try {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback font port");
  const child = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "build"], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      ...ciBuildNodeEnvironment(process.platform, process.env.NODE_OPTIONS),
      NEXT_FONT_GOOGLE_MOCKED_RESPONSES: join(root, "tests/e2e/google-fonts-mock.cjs"),
      E2E_FONT_ORIGIN: `http://127.0.0.1:${address.port}`,
    },
  });
  process.exitCode = await new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => accept(code ?? 1));
  });
} finally {
  await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
}
