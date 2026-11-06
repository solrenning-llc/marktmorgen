/**
 * 313 [CV1] unit 4a: product pictures copied to a Cloudflare R2 bucket of their
 * own and addressed by the images' own domain (lib/picture-r2.ts), against a
 * stand-in R2 (fetch replaced; nothing real is reached). Off today, and off
 * until both the owner's PICTURE_R2_* settings and the reviewed ceiling
 * (PICTURE_R2_CEILING, null: the request-limit rule the owner sets on the
 * images' domain) exist; nothing calls it yet.
 *
 * What fails here:
 *   - on with any setting missing, with the ceiling missing, with the sold
 *     files' or the backup's bucket or key id, with an origin that is not a
 *     plain https host of its own (an r2.dev address included);
 *   - a copy written over another picture (create-only: If-None-Match: *,
 *     signed with its body's own hash), under a name the picture folder could
 *     not hold, of a file larger than a picture may be, or whose bytes are not
 *     the type its name says;
 *   - a copy without the year-long immutable cache or its type;
 *   - any request that is not signed, any delete, or a redirect followed;
 *   - anything in the app importing it yet.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PICTURE_R2_CEILING, copyPictureToR2, pictureR2Config, pictureR2Url, type PictureR2Ceiling } from "@/lib/picture-r2";
import { done, is, part } from "./check";

const objects = new Map<string, { body: Uint8Array; headers: Record<string, string> }>();
const calls: { method: string; url: string; headers: Record<string, string>; cache?: string }[] = [];
let answer: number | null = null;
let down = false;
const badHashes: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
  calls.push({ method, url, headers, cache: init?.cache });
  if (down) throw new TypeError("fetch failed");
  if (init?.redirect !== "error") return new Response("redirects must be refused", { status: 599 });
  if (answer) return new Response("", { status: answer });
  if (method !== "PUT") return new Response("", { status: 405 });
  const body = new Uint8Array(init?.body as Uint8Array);
  if (headers["x-amz-content-sha256"] !== createHash("sha256").update(body).digest("hex")) badHashes.push(url);
  if (headers["if-none-match"] === "*" && objects.has(url)) return new Response("", { status: 412 });
  objects.set(url, { body, headers });
  return new Response("", { status: 200 });
}) as typeof fetch;

const ceiling: PictureR2Ceiling = { rule: "synthetic: 60 requests a minute per address on the images' domain, other names blocked", reviewedAt: "2026-10-31", source: "synthetic test, not a real review" };
const ENV = {
  PICTURE_R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  PICTURE_R2_BUCKET: "mm-pictures",
  PICTURE_R2_ACCESS_KEY_ID: "pictureskey000000001",
  PICTURE_R2_SECRET_ACCESS_KEY: "s".repeat(40),
  PICTURE_R2_ORIGIN: "https://images.marktmorgen.example",
};
function setEnv(values: Record<string, string | undefined>): void {
  for (const name of [...Object.keys(ENV), "PICTURE_R2_JURISDICTION", "R2_BUCKET", "R2_ACCESS_KEY_ID", "BACKUP_R2_BUCKET", "BACKUP_R2_ACCESS_KEY_ID"]) delete process.env[name];
  for (const [name, value] of Object.entries(values)) if (value !== undefined) process.env[name] = value;
}
const FOLDER = "a".repeat(24);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 8, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.(ts|tsx|mjs|js)$/.test(name) ? [path] : [];
  });
}

async function main(): Promise<void> {
  part("Off today, and off until every setting and the reviewed ceiling exist");
  is("no reviewed ceiling exists yet", PICTURE_R2_CEILING, null);
  setEnv(ENV);
  is("every setting but no ceiling: off", pictureR2Config(), null);
  is("every setting and the ceiling: on", pictureR2Config(ceiling)?.bucket, "mm-pictures");
  for (const name of Object.keys(ENV)) {
    setEnv({ ...ENV, [name]: undefined });
    is(`without ${name}: off`, pictureR2Config(ceiling), null);
  }
  for (const [what, extra] of [
    ["the sold files' bucket", { R2_BUCKET: "mm-pictures" }],
    ["the sold files' key id", { R2_ACCESS_KEY_ID: "pictureskey000000001" }],
    ["the backup's bucket", { BACKUP_R2_BUCKET: "mm-pictures" }],
    ["the backup's key id", { BACKUP_R2_ACCESS_KEY_ID: "pictureskey000000001" }],
    ["an http origin", { PICTURE_R2_ORIGIN: "http://images.marktmorgen.example" }],
    ["an origin with a path", { PICTURE_R2_ORIGIN: "https://images.marktmorgen.example/pics" }],
    ["an r2.dev address, which Cloudflare limits and does not cache", { PICTURE_R2_ORIGIN: "https://pub-0123.r2.dev" }],
    ["an r2.dev address with a trailing dot", { PICTURE_R2_ORIGIN: "https://pub-0123.r2.dev." }],
    ["the bare r2.dev host", { PICTURE_R2_ORIGIN: "https://r2.dev" }],
    ["any host with a trailing dot", { PICTURE_R2_ORIGIN: "https://images.marktmorgen.example." }],
    ["an IP address", { PICTURE_R2_ORIGIN: "https://1.2.3.4" }],
    ["an IPv6 address", { PICTURE_R2_ORIGIN: "https://[::1]" }],
    ["a single-label host", { PICTURE_R2_ORIGIN: "https://localhost" }],
    ["the S3 API host, which is not public", { PICTURE_R2_ORIGIN: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com" }],
    ["the site's own host", { PICTURE_R2_ORIGIN: "https://marktmorgen.com" }],
    ["the site's www host", { PICTURE_R2_ORIGIN: "https://www.marktmorgen.com" }],
    ["an origin with a port", { PICTURE_R2_ORIGIN: "https://images.marktmorgen.example:8443" }],
    ["an origin with a query", { PICTURE_R2_ORIGIN: "https://images.marktmorgen.example/?a=1" }],
    ["an origin with a fragment", { PICTURE_R2_ORIGIN: "https://images.marktmorgen.example/#a" }],
    ["a malformed account id", { PICTURE_R2_ACCOUNT_ID: "0123" }],
    ["a short key id", { PICTURE_R2_ACCESS_KEY_ID: "short" }],
    ["a short secret", { PICTURE_R2_SECRET_ACCESS_KEY: "s".repeat(10) }],
    ["a bucket name that is not one", { PICTURE_R2_BUCKET: "Bad_Bucket" }],
    ["an unknown jurisdiction", { PICTURE_R2_JURISDICTION: "us" }],
  ] as [string, Record<string, string>][]) {
    setEnv({ ...ENV, ...extra });
    is(`with ${what}: off`, pictureR2Config(ceiling), null);
  }
  for (const [what, bad] of [
    ["no rule", { ...ceiling, rule: " " }],
    ["no date", { ...ceiling, reviewedAt: "31/10/2026" }],
    ["no source", { ...ceiling, source: "" }],
    ["a date that rolls over", { ...ceiling, reviewedAt: "2026-02-30" }],
  ] as [string, PictureR2Ceiling][]) {
    setEnv(ENV);
    is(`a ceiling with ${what}: off`, pictureR2Config(bad), null);
  }
  setEnv({ ...ENV, PICTURE_R2_ORIGIN: "https://images.marktmorgen.com" });
  is("a subdomain of the site is the natural images' domain: on", pictureR2Config(ceiling)?.origin, "https://images.marktmorgen.com");
  setEnv({ ...ENV, PICTURE_R2_ORIGIN: "https://IMAGES.Marktmorgen.example:443/" });
  is("case and the default port are only spelling", pictureR2Config(ceiling)?.origin, "https://images.marktmorgen.example");
  setEnv({ ...ENV, PICTURE_R2_JURISDICTION: "eu" });
  is("a bucket under the EU jurisdiction is reached at its own address", pictureR2Config(ceiling)?.endpoint, "https://0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com");

  part("A copy is create-only, signed, cached for a year, of a real picture under its own name");
  setEnv(ENV);
  const config = pictureR2Config(ceiling)!;
  const path = `images/${FOLDER}/${"b".repeat(32)}.jpg`;
  is("a new picture is copied", await copyPictureToR2(config, path, JPEG), "copied");
  const target = `https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/mm-pictures/${path}`;
  const stored = objects.get(target);
  is("under the same name as in the picture folder", !!stored, true);
  is("with its type, the year-long immutable cache, create-only and signed", [stored?.headers["content-type"], stored?.headers["cache-control"], stored?.headers["if-none-match"], /^AWS4-HMAC-SHA256 Credential=pictureskey000000001\//.test(stored?.headers.authorization ?? ""), /if-none-match/.test(stored?.headers.authorization ?? ""), /cache-control/.test(stored?.headers.authorization ?? "")], ["image/jpeg", "public, max-age=31536000, immutable", "*", true, true, true]);
  is("the body is signed by its own hash", badHashes, []);
  const other = JPEG.slice();
  other[15] = 9;
  is("the same name again: already there, never written over", [await copyPictureToR2(config, path, other), objects.get(target)?.body[15]], ["already", 1]);
  const webpPath = `images/${FOLDER}/${"c".repeat(32)}.webp`;
  is("a WebP picture is copied as one", [await copyPictureToR2(config, webpPath, WEBP), objects.get(target.replace(path, webpPath))?.headers["content-type"]], ["copied", "image/webp"]);
  const before = calls.length;
  for (const [what, p, bytes] of [
    ["a name the picture folder could not hold", `images/${FOLDER}/../x.jpg`, JPEG],
    ["a name outside the picture folder", `files/${FOLDER}/${"d".repeat(32)}.jpg`, JPEG],
    ["bytes that are not the type the name says", `images/${FOLDER}/${"e".repeat(32)}.jpg`, WEBP],
    ["a real JPEG larger than a picture may be", `images/${FOLDER}/${"f".repeat(32)}.jpg`, (() => { const big = new Uint8Array(1_000_001); big.set(JPEG); return big; })()],
    ["an empty file", `images/${FOLDER}/${"7".repeat(32)}.jpg`, new Uint8Array(0)],
    ["a JPEG under a WebP name", `images/${FOLDER}/${"6".repeat(32)}.webp`, JPEG],
    ["a PNG under a JPEG name", `images/${FOLDER}/${"5".repeat(32)}.jpg`, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])],
  ] as [string, string, Uint8Array][]) {
    is(`${what}: refused before anything is sent`, await copyPictureToR2(config, p, bytes).then(() => "sent", () => "refused"), "refused");
  }
  is("and nothing was sent for them", calls.length - before, 0);
  const most = new Uint8Array(1_000_000);
  most.set(JPEG);
  is("a JPEG of exactly the most a picture may weigh is copied", await copyPictureToR2(config, `images/${FOLDER}/${"4".repeat(32)}.jpg`, most), "copied");
  for (const status of [301, 403, 409, 500, 503]) {
    answer = status;
    is(`an answer of ${status} is a failure`, await copyPictureToR2(config, `images/${FOLDER}/${"9".repeat(32)}.jpg`, JPEG).then(() => "ok", () => "failed"), "failed");
  }
  answer = null;
  down = true;
  is("an unreachable store is a failure", await copyPictureToR2(config, `images/${FOLDER}/${"8".repeat(32)}.jpg`, JPEG).then(() => "ok", () => "failed"), "failed");
  down = false;
  is("never a delete, never a read", calls.filter((c) => c.method !== "PUT").length, 0);
  is("never kept by the fetch cache", calls.length > 0 && calls.every((c) => c.cache === "no-store"), true);

  part("The address by the images' own domain");
  is("the same path under the images' origin", pictureR2Url(config, path), `https://images.marktmorgen.example/${path}`);
  is("a path that is not a picture's has none", (() => { try { return pictureR2Url(config, "images/../secret"); } catch { return "refused"; } })(), "refused");

  part("Only the copy on attach (unit 4b) and the served address (unit 4c) use it");
  const users = [...sources("app"), ...sources("lib"), ...sources("components"), ...sources("scripts")].filter((file) => file !== join("lib", "picture-r2.ts") && file !== join("lib", "picture-r2-copy.ts") && file !== join("lib", "picture-served.ts") && /(?:@\/lib\/|\.\/|\.\.\/)picture-r2["']/.test(readFileSync(file, "utf8")));
  is("no other file of the app imports it", users, []);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
