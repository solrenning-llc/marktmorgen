/** The real privacy page must not silently change stores after a removed bookmark. Synthetic views only. */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const gone = "1".repeat(32), owned = "2".repeat(32);
const temporary = mkdtempSync(join(tmpdir(), "privacy-view-synthetic-"));
after(() => rmSync(temporary, { recursive: true, force: true }));
const modules: Record<string, string> = {
  "next/headers": "export async function cookies() { return {}; }",
  "next/navigation": "export function redirect(href) { throw new Error(`Redirect: ${href}`); }",
  "@/lib/studio-route": `
    export function studioPath(store, query = "") { return "/studio?store=" + store.sid + (query ? "&" + query : ""); }
    export async function studioView(_cookies, asked) { return { ok: true, fellBack: asked === "${gone}", view: {
      store: { sid: "${owned}", extra: true }, role: "owner", email: "owner@example.test", stores: [], owned: 2,
    }}; }
  `,
  "@/lib/plan-standing": 'export const standingOf = () => "paid";',
  "@/lib/studio-privacy": 'export const privacyChoices = () => ({data: "file", deleteStore: "here"});',
  "@/components/breadcrumb": "export const StudioTrail = () => null;",
  "@/components/studio-header": "export const StudioHeader = () => null;",
  "@/components/studio-store-pin": "export const StudioStorePin = ({children}) => children;",
  "@/components/studio-privacy": "export const StudioPrivacy = () => null;",
};
const aliases = Object.entries(modules).map(([name, source], index) => {
  const path = join(temporary, `fixture-${index}.js`);
  writeFileSync(path, source);
  return `--alias:${name}=${path}`;
});
const bundle = join(temporary, "page.cjs");
execFileSync(join(process.cwd(), "node_modules/@esbuild/linux-x64/bin/esbuild"), [
  "app/studio/privacy/page.tsx", "--bundle", "--platform=node", "--format=cjs", "--jsx=automatic",
  `--outfile=${bundle}`, "--log-level=error", ...aliases,
], { cwd: process.cwd(), stdio: "pipe" });
const page = (createRequire(join(process.cwd(), "package.json"))(bundle) as {
  default: (props: { searchParams: Promise<{ store: string }> }) => Promise<{ type: unknown }>;
}).default;

test("a removed-store bookmark redirects with notice before drawing another store's privacy actions", async () => {
  await assert.rejects(page({ searchParams: Promise.resolve({ store: gone }) }), {
    message: `Redirect: /studio?store=${owned}&team=gone`,
  });
});
test("a still-accessible store keeps its privacy page", async () => {
  const tree = await page({ searchParams: Promise.resolve({ store: owned }) });
  assert.equal(tree.type, "div");
});
