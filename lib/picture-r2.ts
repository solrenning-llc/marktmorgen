/**
 * 313 [CV1] unit 4a: product pictures copied to a Cloudflare R2 bucket of
 * their own, to be served from the images' own domain instead of from
 * app/api/image (R2 Standard: reads are Class B at $0.36 a million, writes
 * Class A at $4.50 a million, data out free, https://developers.cloudflare.com/r2/pricing/,
 * read 31 October 2026; a free quota is never counted as zero).
 *
 * Off today, two ways, and both are needed:
 *   - the owner's own settings: PICTURE_R2_ACCOUNT_ID, PICTURE_R2_BUCKET,
 *     PICTURE_R2_ACCESS_KEY_ID, PICTURE_R2_SECRET_ACCESS_KEY and
 *     PICTURE_R2_ORIGIN (the images' domain connected to that bucket, a plain
 *     https host; never an r2.dev address, which Cloudflare rate-limits, meant
 *     for development only, without its cache or rules; a custom domain gets
 *     Cloudflare's cache, which keeps JPG and WEBP by default,
 *     https://developers.cloudflare.com/r2/buckets/public-buckets/ and
 *     https://developers.cloudflare.com/cache/concepts/default-cache-behavior/,
 *     both read 31 October 2026),
 *     with PICTURE_R2_JURISDICTION=eu for a bucket made under the EU
 *     jurisdiction; never the sold files' or the backup's bucket or key id;
 *   - PICTURE_R2_CEILING, null: on a public domain anyone can ask for made-up
 *     names, and each request is a paid read with no ceiling in this code
 *     (app/api/image is paced by lib/picture-pace.ts; R2's domain is not). So
 *     nothing is served from R2 until the owner has set a request-limit rule
 *     on the images' domain and it is recorded here with its date and source
 *     (MR: a ceiling before every expense; unknown cost fails).
 * Nothing calls it yet: copying each new picture when it is attached, and
 * addressing copied pictures by this domain, are later units.
 *
 * Every write is create-only: PutObject with If-None-Match: *, which R2
 * evaluates atomically (https://developers.cloudflare.com/r2/api/s3/api/);
 * a picture's name is fresh at every upload and never reused, so a 412 means
 * an object under that name is already there (not checked to be this very
 * picture: no other writer may use the bucket), and is billed as a Class A
 * operation (https://developers.cloudflare.com/r2/pricing/). Storage is
 * $0.015 a GB-month on the same page. No delete and no read here.
 *
 * The key check compares key ids only: the owner's token must be scoped to
 * the pictures' bucket alone. A PutObject keeps Cache-Control and
 * Content-Type, but not app/api/image's X-Content-Type-Options: nosniff,
 * Content-Security-Policy: default-src 'none'; sandbox or
 * Cross-Origin-Resource-Policy: so serving from the images' domain (a later
 * unit) also needs a Cloudflare response-header rule adding those three.
 */
import { hashOf, signV4, type AwsKey } from "@/lib/aws-sign";
import { timed } from "@/lib/fetch-timeout";
import { IMAGE_FILE_PATTERN, IMAGE_FOLDER_PATTERN, MAX_IMAGE_BYTES, imageType } from "@/lib/product-image";
import { sniffPhotoType } from "@/lib/store-photo";
import { SITE_URL } from "@/lib/site-url";

/**
 * The owner's rules on the images' domain, as reviewed: the request limit, and (since public pages take marked
 * pictures from there, unit 4c) the response-header rule adding X-Content-Type-Options: nosniff,
 * Content-Security-Policy: default-src 'none'; sandbox and Cross-Origin-Resource-Policy: cross-origin, as
 * app/api/image sends. Recorded only when both exist.
 */
export type PictureR2Ceiling = { rule: string; reviewedAt: string; source: string };

/** No rule recorded yet: off. */
export const PICTURE_R2_CEILING: PictureR2Ceiling | null = null;

export type PictureR2Config = { endpoint: string; bucket: string; origin: string; key: AwsKey };

const REGION = "auto";
const SERVICE = "s3";
const TIMEOUT_MS = 15_000;
const CACHE = "public, max-age=31536000, immutable";

const env = (name: string) => (process.env[name] ?? "").trim();

function wholeCeiling(ceiling: PictureR2Ceiling | null): boolean {
  if (!ceiling) return false;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(ceiling.reviewedAt) ? Date.parse(`${ceiling.reviewedAt}T00:00:00Z`) : NaN;
  return ceiling.rule.trim().length >= 10 && ceiling.source.trim().length >= 10 && Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === ceiling.reviewedAt;
}

/** The images' own bucket, key and domain; null while off (any setting missing or malformed, a bucket or key that is another's, no reviewed ceiling). */
export function pictureR2Config(ceiling: PictureR2Ceiling | null = PICTURE_R2_CEILING): PictureR2Config | null {
  if (!wholeCeiling(ceiling)) return null;
  const account = env("PICTURE_R2_ACCOUNT_ID");
  const bucket = env("PICTURE_R2_BUCKET");
  const accessKeyId = env("PICTURE_R2_ACCESS_KEY_ID");
  const secretAccessKey = env("PICTURE_R2_SECRET_ACCESS_KEY");
  if (!/^[0-9a-f]{32}$/.test(account) || accessKeyId.length < 16 || secretAccessKey.length < 32) return null;
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) return null;
  // Never the sold files' bucket or key (lib/vault.ts), nor the backup's (lib/backup-store.ts).
  if ([env("R2_BUCKET"), env("BACKUP_R2_BUCKET")].includes(bucket)) return null;
  if ([env("R2_ACCESS_KEY_ID"), env("BACKUP_R2_ACCESS_KEY_ID")].includes(accessKeyId)) return null;
  let origin: URL;
  try {
    origin = new URL(env("PICTURE_R2_ORIGIN"));
  } catch {
    return null;
  }
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password || origin.port) return null;
  if (!publicImagesHost(origin.hostname)) return null;
  const jurisdiction = env("PICTURE_R2_JURISDICTION").toLowerCase();
  if (jurisdiction !== "" && jurisdiction !== "eu") return null;
  const host = jurisdiction === "eu" ? `${account}.eu.r2.cloudflarestorage.com` : `${account}.r2.cloudflarestorage.com`;
  return { endpoint: `https://${host}`, bucket, origin: origin.origin, key: { accessKeyId, secretAccessKey } };
}

/**
 * A name that can be the images' own public domain: two labels or more of
 * letters, digits and hyphens, no trailing dot, no IP literal; never an
 * r2.dev address, the S3 API host (not public), or the site's own host.
 */
function publicImagesHost(host: string): boolean {
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return false;
  if (/^\d+$/.test(labels.at(-1)!)) return false;
  const under = (suffix: string) => host === suffix || host.endsWith(`.${suffix}`);
  const site = new URL(SITE_URL).hostname;
  // A subdomain of the site (images.marktmorgen.com) is fine; the site itself is not.
  return !under("r2.dev") && !under("r2.cloudflarestorage.com") && host !== site && host !== `www.${site}`;
}

/** "images/<folder>/<file>" split, or a refusal: only a name the picture folder can hold. */
function pictureParts(path: string): { folder: string; file: string } {
  const [root, folder, file, ...rest] = path.split("/");
  if (root !== "images" || rest.length || !IMAGE_FOLDER_PATTERN.test(folder ?? "") || !IMAGE_FILE_PATTERN.test(file ?? "")) throw new Error("Not a picture's path");
  return { folder, file };
}

/** Copies one picture, create-only. "already" when the same name is there. Any other answer, or a file that is not the picture its name says, throws. */
export async function copyPictureToR2(config: PictureR2Config, path: string, bytes: Uint8Array): Promise<"copied" | "already"> {
  const { folder, file } = pictureParts(path);
  const type = imageType(file);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("Not a picture's size");
  if (sniffPhotoType(bytes) !== type) throw new Error("Not the type its name says");
  const url = `${config.endpoint}/${config.bucket}/images/${folder}/${file}`;
  const payloadHash = hashOf(bytes);
  const headers = signV4({
    method: "PUT",
    url,
    headers: { "cache-control": CACHE, "content-type": type, "if-none-match": "*", "x-amz-content-sha256": payloadHash },
    payloadHash,
    region: REGION,
    service: SERVICE,
    key: config.key,
  });
  const status = await timed(TIMEOUT_MS, async (signal) => {
    // A redirect is refused, never followed.
    const response = await fetch(url, { method: "PUT", headers, body: bytes as BodyInit, signal, cache: "no-store", redirect: "error" });
    await response.body?.cancel().catch(() => {});
    return response.status;
  });
  if (status === 412) return "already";
  if (status !== 200) throw new Error(`Picture copy failed with status ${status}`);
  return "copied";
}

/** The address of a copied picture on the images' own domain. */
export function pictureR2Url(config: PictureR2Config, path: string): string {
  const { folder, file } = pictureParts(path);
  return `${config.origin}/images/${folder}/${file}`;
}
