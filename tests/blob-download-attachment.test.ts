/**
 * MM-SA-29 (security audit 506 [SG1], docs/security-audit-2026-10-28.md): a
 * sold file over 20 MB kept in the host's own file store (Vercel Blob) went
 * to the buyer as a plain signed address. `saveAs` was dropped for that
 * store, so a browser opened the file in the tab instead of saving it: a
 * creator's SVG ran as a page of its own, on Blob's address.
 *
 * Now every address handed out with a name to save under asks Blob for a
 * download (`download=1`, the switch the SDK's own `downloadUrl` uses), and
 * the signed part of the address is left exactly as the SDK made it. An
 * address with no name (a lesson's video, a podcast episode, played in
 * place) is unchanged. An address that cannot be signed is still no address,
 * never a link that half works.
 *
 * Only the signed token Blob's API would issue is a stand-in
 * (tests/blob-download-attachment-world.ts); the address is built by the real
 * SDK, and fileUrl and serveFile are the real ones. Redis is the in-memory
 * one. Nothing is reached.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileUrl } from "@/lib/file-store";
import { serveFile } from "@/lib/serve-file";
import { REDIRECT_ABOVE_BYTES, type ProductFile } from "@/lib/product-file";
import { monthKey } from "@/lib/delivery";
import { redisPipeline } from "@/lib/redis";
import { blobWorld, resetBlobWorld } from "./blob-download-attachment-world";
import { done, is, part } from "./check";

const FOLDER = "0123456789abcdef0123456789abcdef";
const PATHNAME = `stores/${FOLDER}/prod01/field-guide-Xy12AbCdEf.svg`;

const big: ProductFile = {
  pathname: PATHNAME,
  name: "Field guide.svg",
  bytes: REDIRECT_ABOVE_BYTES + 5 * 1024 * 1024,
  contentType: "image/svg+xml",
  addedAt: "2026-01-01T00:00:00.000Z",
};

async function delivered(): Promise<number> {
  const [value] = await redisPipeline([["GET", `nl:store:delivery:${FOLDER}:${monthKey()}`]]);
  return Number(value ?? 0);
}

async function main() {
  part("a named Blob address asks for a download");
  resetBlobWorld();
  const saved = await fileUrl(PATHNAME, 300, big.name);
  is("an address was made", typeof saved, "string");
  const url = new URL(saved ?? "https://invalid.example/");
  is("it is Blob's own address for the file", `${url.host}${url.pathname}`, `syntheticstore01.private.blob.vercel-storage.com/${PATHNAME}`);
  is("it asks for a download, not a page in the tab", url.searchParams.get("download"), "1");
  is("it carries the SDK's signature", Boolean(url.searchParams.get("vercel-blob-signature")), true);
  is("it carries the delegation", Boolean(url.searchParams.get("vercel-blob-delegation")), true);

  part("the signed part is the SDK's, untouched");
  resetBlobWorld();
  const plainAddress = await fileUrl(PATHNAME, 300);
  const plainUrl = new URL(plainAddress ?? "https://invalid.example/");
  is("an address with no name has no download switch (played in place)", plainUrl.searchParams.get("download"), null);
  const withoutSwitch = new URL(url);
  withoutSwitch.searchParams.delete("download");
  const signedKeys = (u: URL) => [...u.searchParams.keys()].filter((key) => key.startsWith("vercel-blob-")).sort();
  is("the same signed parameters, and no others", signedKeys(withoutSwitch), signedKeys(plainUrl));
  const scope = (u: URL) => {
    const payload = JSON.parse(Buffer.from(u.searchParams.get("vercel-blob-delegation")?.split(".")[0] ?? "", "base64url").toString() || "{}") as { pathname?: string; operations?: string[] };
    return [payload.pathname, payload.operations];
  };
  is("the delegation is for this one file, to read it only", scope(withoutSwitch), [PATHNAME, ["get"]]);
  is("the same delegation scope as a plain address", scope(withoutSwitch), scope(plainUrl));
  is("the same path", withoutSwitch.pathname, plainUrl.pathname);

  part("a buyer's big file goes out as a download (lib/serve-file.ts)");
  resetBlobWorld();
  const before = await delivered();
  const answer = await serveFile(big);
  is("a redirect to storage", answer.status, 302);
  const location = new URL(answer.headers.get("Location") ?? "https://invalid.example/");
  is("to Blob", location.host, "syntheticstore01.private.blob.vercel-storage.com");
  is("asking for a download", location.searchParams.get("download"), "1");
  is("never kept by a cache", answer.headers.get("Cache-Control"), "private, no-store");
  is("the delivery is counted once", (await delivered()) - before, big.bytes);
  const free = await serveFile(big, { paid: false });
  is("a free copy asks for a download too", new URL(free.headers.get("Location") ?? "https://invalid.example/").searchParams.get("download"), "1");

  part("an address that cannot be signed is no address");
  resetBlobWorld();
  blobWorld.failIssue = true;
  is("fileUrl answers null, never a half-made link", await fileUrl(PATHNAME, 300, big.name), null);
  const afterFail = await delivered();
  const failed = await serveFile(big);
  is("the buyer is told it could not be fetched", failed.status, 502);
  is("no Location is sent", failed.headers.get("Location"), null);
  is("nothing is counted as delivered", await delivered(), afterFail);

  part("every caller that hands out a sold file names it");
  // A signed address without a name opens in the tab. Only the media played in
  // place (a lesson's video, a podcast episode, through signedMedia) may leave
  // it out; any other caller must pass the name to save under.
  const root = process.cwd();
  const callers: [string, RegExp][] = [
    ["lib/serve-file.ts", /fileUrl\(file\.pathname, DOWNLOAD_URL_SECONDS, file\.name\)/],
    ["app/api/store/file/download/route.ts", /fileUrl\(pathname, DOWNLOAD_URL_SECONDS, name\)/],
  ];
  for (const [file, call] of callers) is(`${file} passes the name`, call.test(readFileSync(join(root, file), "utf8")), true);
  const learn = readFileSync(join(root, "lib/learn.ts"), "utf8");
  is("lib/learn.ts calls it without a name only in signedMedia", (learn.match(/fileUrl\(/g) ?? []).length, 1);

  done();
}

main();
