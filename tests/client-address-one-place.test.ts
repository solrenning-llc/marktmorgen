/**
 * The address a request came from is read in one place (lib/request-guard.ts, forwardedAddress), so the rule for which
 * header the platform in front of us fills in can change in one line rather than in ten copies that drift apart (the
 * security audit of 14 November 2026). The rule itself is unchanged: the first value of X-Forwarded-For, else
 * X-Real-IP; each caller keeps its own fallback. It is only safe because Vercel overwrites X-Forwarded-For; a proxy
 * put in front of it would need this one function changed, from a dated official source.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { done, is, part } from "./check";

/** Where the header is still read on its own, and why. */
const EXCEPTIONS: Record<string, string> = {
  "lib/request-guard.ts": "the one place",
  // Its line is inside an open PR's hunk (#4172, 14 November 2026); moved once that PR lands.
  "app/[handle]/page.tsx": "an open PR's hunk",
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
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
