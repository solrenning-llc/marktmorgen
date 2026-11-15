/**
 * The image optimizer (/_next/image) is off, because nothing here uses it.
 *
 * No page renders next/image: every picture, a creator's included, is served
 * as the file itself (tests/e2e/creator-situations.mjs counts zero requests to
 * /_next/image). Yet with no `images` setting the optimizer stays open on
 * Vercel, and with no localPatterns it takes ANY local address with ANY query
 * string: /_next/image?url=/og.png?n=1&w=3840&q=75, ?n=2, ?n=3 … are each a new
 * source image and a new transformation, billed by Vercel, and each fetches the
 * original from the deployment (Fast Origin Transfer, and a function run when
 * the address is a route such as /blog/x/opengraph-image). Anyone can mint them
 * in a loop, with no ceiling (C1 cost audit, 12 November 2026).
 *
 * Vercel's builder (@vercel/next 29.1.0, dist/index.js) publishes the
 * optimizer only when `images.loader === "default" && images.unoptimized !==
 * true`; Next's own server answers 404 when `loader !== "default" ||
 * unoptimized` (next/dist/server/next-server.js). Both are read here from the
 * real next.config.ts.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import loaded from "../next.config";
import { done, is, part } from "./check";

type Images = { loader?: string; unoptimized?: boolean };
type Config = { images?: Images };

async function config(): Promise<Config> {
  const value = loaded as unknown;
  if (typeof value === "function") return (await (value as (phase: string, ctx: object) => Promise<Config>)("phase-production-build", {})) ?? {};
  return (value as Config) ?? {};
}

/** Files under app/, components/ and lib/ that import next/image. */
function imageUsers(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name) && /from\s+["']next\/(legacy\/)?image["']/.test(readFileSync(path, "utf8"))) found.push(path);
    }
  };
  for (const dir of ["app", "components", "lib"]) walk(join(process.cwd(), dir));
  return found;
}

async function main(): Promise<void> {
  const images = (await config()).images ?? {};
  const loader = images.loader ?? "default";

  part("Nothing renders next/image, so nothing needs the optimizer");
  is("no file under app/, components/ or lib/ imports next/image", imageUsers(), []);

  part("The optimizer is therefore not published at all");
  is(
    "Vercel's builder publishes no optimizer (loader default and unoptimized !== true would publish it)",
    loader === "default" && images.unoptimized !== true,
    false,
  );
  is("Next's own server answers /_next/image with 404", loader !== "default" || images.unoptimized === true, true);
  done();
}

void main();
