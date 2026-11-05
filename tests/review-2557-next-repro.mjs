/**
 * Review of PR #2557 at 1db112afb, on the real Next.js of this repository
 * (16.4.2): a minimal App Router app with a dynamic page that shows its
 * `session_id`, and a client component that clears the address exactly as
 * components/store-pixels.tsx hideKeys does (replaceState keeping Next's
 * state before the router listens, then replaceState(null) once it does).
 * Built with webpack, served by `next start`, driven in Chrome.
 *
 * Not part of the test run (not a *.test.ts): it needs Chrome and a build.
 *   node tests/review-2557-next-repro.mjs
 *
 * What it showed on 5 Nov 2026:
 *   - after the clearing, the page still shows the order, nothing is fetched
 *     and nothing reloads; a step away by Link and back shows it again;
 *   - router.refresh() (which a server action with revalidation also does)
 *     fetches the page at the cleared address, and the order is gone:
 *     "ORDER:none". Before 1db112afb the same refresh put the key back.
 */
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "review-2557-next-"));
const put = (path, text) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
};
symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
put("package.json", '{ "name": "repro", "private": true }\n');
put("app/layout.jsx", "export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n");
put(
  "app/t/page.jsx",
  `import Cleaner from "./cleaner";
import Link from "next/link";
export const dynamic = "force-dynamic";
export default async function Page({ searchParams }) {
  const q = await searchParams;
  return <main><p id="order">ORDER:{typeof q.session_id === "string" ? q.session_id : "none"}</p><Cleaner /><Link id="go" href="/u">to u</Link></main>;
}
`,
);
put("app/u/page.jsx", 'export default function U() { return <p id="u">U page</p>; }\n');
put(
  "app/t/cleaner.jsx",
  `"use client";
import { useEffect } from "react";
function routerListens() { return Object.prototype.hasOwnProperty.call(history, "replaceState"); }
export default function Cleaner() {
  useEffect(() => {
    const url = new URL(location.href);
    if (!url.searchParams.has("session_id")) return;
    url.searchParams.delete("session_id");
    const href = url.href;
    if (routerListens()) history.replaceState(null, "", href);
    else {
      history.replaceState(history.state, "", href);
      setTimeout(() => { if (routerListens() && location.href === href) history.replaceState(null, "", href); }, 0);
    }
  }, []);
  return null;
}
`,
);
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1" };
const next = join(dir, "node_modules/next/dist/bin/next");
const built = spawnSync(process.execPath, [next, "build", "--webpack"], { cwd: dir, env, encoding: "utf8" });
if (built.status !== 0) throw new Error(built.stdout + built.stderr);
const server = spawn(process.execPath, [next, "start", "-p", "3918"], { cwd: dir, env });
await new Promise((r) => setTimeout(r, 2500));
const { chromium } = createRequire(import.meta.url)(join(root, "node_modules/playwright-core"));
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  const read = () => page.evaluate(() => ({ href: location.href, order: document.getElementById("order")?.textContent }));
  await page.goto("http://localhost:3918/t?session_id=cs_abc&x=1");
  await page.waitForTimeout(1500);
  console.log("after clearing      ", JSON.stringify(await read()));
  await page.click("#go");
  await page.waitForSelector("#u");
  await page.goBack();
  await page.waitForTimeout(1500);
  console.log("away by Link and back", JSON.stringify(await read()));
  await page.evaluate(() => window.next.router.refresh());
  await page.waitForTimeout(2000);
  const after = await read();
  console.log("after router.refresh", JSON.stringify(after));
  process.exitCode = after.order === "ORDER:cs_abc" ? 0 : 1;
} finally {
  await browser.close();
  server.kill();
}
