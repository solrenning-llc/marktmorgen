/**
 * The address a request came from is read in one place (lib/request-guard.ts, forwardedAddress), so the rule for which
 * header the platform in front of us fills in can change in one line rather than in ten copies that drift apart (the
 * security audit of 14 November 2026). The rule itself is unchanged: the first value of X-Forwarded-For, else
 * X-Real-IP; each caller keeps its own fallback. It is only safe because Vercel overwrites X-Forwarded-For; a proxy
 * put in front of it would need this one function changed, from a dated official source.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { clientAddress, forwardedAddress } from "@/lib/request-guard";
import { done, is, part } from "./check";

/** Where the header is still read on its own, and why. */
const EXCEPTIONS: Record<string, string> = {
  "lib/request-guard.ts": "the one place",
  // Its line is inside an open PR's hunk (#4172, 14 November 2026); moved once that PR lands.
  "app/[handle]/page.tsx": "an open PR's hunk",
  // Its import block's last line is inside three open PRs' hunks (#3697, #3380, #3330); moved once they land.
  "lib/traffic.ts": "open PRs' hunks at its imports",
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

async function main(): Promise<void> {
  part("Nobody reads X-Forwarded-For but lib/request-guard.ts");
  const readers = ["lib", "app", "components"].flatMap(files).filter((path) => readFileSync(path, "utf8").includes('"x-forwarded-for"'));
  is("no other file", readers.filter((path) => !(path in EXCEPTIONS)).sort(), []);

  part("The rule is the one the copies had");
  // The copies' own rule, as it was written in each of them until 14 November 2026.
  const old = (headers: Headers) => headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip") || "";
  const cases: [string, Record<string, string>][] = [
    ["nothing", {}],
    ["one forwarded address", { "x-forwarded-for": "198.51.100.7" }],
    ["a chain, the first one counts", { "x-forwarded-for": " 198.51.100.7 , 203.0.113.9" }],
    ["an empty first value falls to X-Real-IP", { "x-forwarded-for": " , 203.0.113.9", "x-real-ip": "192.0.2.4" }],
    ["only X-Real-IP", { "x-real-ip": "192.0.2.4" }],
    ["both, X-Forwarded-For first", { "x-forwarded-for": "198.51.100.7", "x-real-ip": "192.0.2.4" }],
  ];
  for (const [name, values] of cases) {
    const headers = new Headers(values);
    is(`${name}: the same address`, forwardedAddress(headers), old(headers));
    is(`${name}: clientAddress keeps "unknown" for none`, clientAddress({ headers }), old(headers) || "unknown");
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
