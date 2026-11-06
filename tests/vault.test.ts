/**
 * A file that is sold, kept in the store that charges nothing for a download
 * (lib/vault.ts): from the upload the studio opens to the address a buyer is
 * handed, and what happens when the studio says one thing and sends another.
 *
 * The store is somebody else's, so it is stood in for here by something that
 * speaks the same dialect (Amazon's S3): uploads in pieces, joined at the
 * end; a measure of each file; listing by folder, a page at a time. The
 * signatures themselves are held to Amazon's own worked examples in
 * tests/aws-sign.test.ts. What no test here can hold is the store itself:
 * that is for a real file in a real bucket, once there is one.
 */
import { createHash } from "node:crypto";
import { folderFromPathname } from "@/lib/delivery";
import { deleteFile, fileUrl, headFile, listFiles, readFileWhole, writeFileWhole } from "@/lib/file-store";
import { ownsPath } from "@/lib/product-file";
import {
  abortVaultUpload,
  closeVaultUpload,
  deleteVault,
  headVault,
  isVaultConfigured,
  listVault,
  openVaultUpload,
  readVault,
  signPieces,
  vaultHeld,
  vaultOrigin,
  vaultUrl,
} from "@/lib/vault";
import {
  PIECE_BYTES,
  PIECE_SECONDS,
  isVaultPath,
  keyName,
  ownsVaultPath,
  pieceCount,
  pieceSize,
  readVaultPath,
  vaultPath,
} from "@/lib/vault-rules";
import { done, is, part } from "./check";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const BUCKET = "sold-files";
const ORIGIN = `https://${ACCOUNT}.r2.cloudflarestorage.com`;
const FOLDER = "0123456789abcdef0123456789abcdef";
const OTHER_FOLDER = "fedcba9876543210fedcba9876543210";

type Stored = { bytes: Uint8Array; type: string };
const objects = new Map<string, Stored>();
const uploads = new Map<string, { key: string; type: string; parts: Map<number, Uint8Array> }>();
const asked: string[] = [];
/** The store as a whole: there, or not answering. */
let service: "up" | "down" = "up";
let listingOverride: ((url: URL) => string) | null = null;
let made = 0;
/**
 * Whether the store compresses a file of text on its way out, as the real
 * one does: when the asker did not say to send it as it is kept ("asked"),
 * or even then ("always"). A file it squeezes is answered with no length.
 */
let squeezes: "asked" | "always" = "asked";
/** How many files a listing gives at a time, so paging is walked. */
const PAGE = 2;

const md5 = (bytes: Uint8Array) => createHash("md5").update(bytes).digest("hex");
const xml = (body: string, status = 200) => new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, { status, headers: { "content-type": "application/xml" } });
const join = (parts: Uint8Array[]) => {
  const whole = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    whole.set(p, at);
    at += p.byteLength;
  }
  return whole;
};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.origin !== ORIGIN) return new Response(null, { status: 404 });
  asked.push(`${method} ${url.pathname}${url.search ? "?" + [...url.searchParams.keys()].filter((k) => !k.startsWith("X-Amz-")).sort().join("&") : ""}`);
  if (service === "down") throw new TypeError("fetch failed");
  const headers = (init?.headers ?? {}) as Record<string, string>;
  // Every request is ours, with a signature in its headers, or carries one in its address.
  if (!headers.authorization && !url.searchParams.get("X-Amz-Signature")) return xml("<Error><Code>AccessDenied</Code></Error>", 403);
  const prefix = `/${BUCKET}`;
  if (!url.pathname.startsWith(prefix)) return xml("<Error><Code>NoSuchBucket</Code></Error>", 404);
  const key = url.pathname.slice(prefix.length + 1);
  const body = init?.body === undefined || init.body === null ? new Uint8Array() : typeof init.body === "string" ? new TextEncoder().encode(init.body) : new Uint8Array(init.body as ArrayBuffer);

  if (!key) {
    if (listingOverride) return xml(listingOverride(url));
    // A listing: a folder's files, a page at a time.
    const all = [...objects.keys()].filter((k) => k.startsWith(url.searchParams.get("prefix") ?? "")).sort();
    const from = Number(url.searchParams.get("continuation-token") ?? "0");
    const page = all.slice(from, from + PAGE);
    const more = from + PAGE < all.length;
    return xml(
      `<ListBucketResult><IsTruncated>${more}</IsTruncated>${page.map((k) => `<Contents><Key>${k}</Key><Size>${objects.get(k)!.bytes.byteLength}</Size></Contents>`).join("")}${more ? `<NextContinuationToken>${from + PAGE}</NextContinuationToken>` : ""}</ListBucketResult>`,
    );
  }
  if (method === "POST" && url.searchParams.has("uploads")) {
    made += 1;
    const id = `upload-${made}`;
    uploads.set(id, { key, type: headers["content-type"] ?? "", parts: new Map() });
    return xml(`<InitiateMultipartUploadResult><Bucket>${BUCKET}</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
  }
  const uploadId = url.searchParams.get("uploadId");
  if (uploadId) {
    const upload = uploads.get(uploadId);
    if (!upload || upload.key !== key) return xml("<Error><Code>NoSuchUpload</Code></Error>", 404);
    if (method === "PUT") {
      upload.parts.set(Number(url.searchParams.get("partNumber")), body);
      return new Response(null, { status: 200, headers: { ETag: `"${md5(body)}"` } });
    }
    if (method === "DELETE") {
      uploads.delete(uploadId);
      return new Response(null, { status: 204 });
    }
    if (method === "POST") {
      const listed = [...new TextDecoder().decode(body).matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>"([0-9a-f]+)"<\/ETag>/g)].map((m) => [Number(m[1]), m[2]] as const);
      const right = listed.length === upload.parts.size && listed.every(([n, etag], i) => n === i + 1 && upload.parts.has(n) && md5(upload.parts.get(n)!) === etag);
      if (!right) return xml("<Error><Code>InvalidPart</Code></Error>", 400);
      objects.set(key, { bytes: join(listed.map(([n]) => upload.parts.get(n)!)), type: upload.type });
      uploads.delete(uploadId);
      return xml(`<CompleteMultipartUploadResult><Key>${key}</Key></CompleteMultipartUploadResult>`);
    }
  }
  if (method === "PUT") {
    objects.set(key, { bytes: body, type: headers["content-type"] ?? headers["Content-Type"] ?? "" });
    return new Response(null, { status: 200, headers: { ETag: `"${md5(body)}"` } });
  }
  const found = objects.get(key);
  if (method === "DELETE") {
    objects.delete(key);
    return new Response(null, { status: 204 });
  }
  if (!found) return method === "HEAD" ? new Response(null, { status: 404 }) : xml("<Error><Code>NoSuchKey</Code></Error>", 404);
  // A part of a file: never squeezed, and the answer names the size of the whole.
  const range = /^bytes=(\d+)-(\d+)$/.exec(headers.range ?? "");
  if (range && method === "GET") {
    if (Number(range[1]) >= found.bytes.byteLength) return new Response(null, { status: 416 });
    const end = Math.min(Number(range[2]), found.bytes.byteLength - 1);
    const slice = found.bytes.slice(Number(range[1]), end + 1);
    return new Response(slice as BodyInit, { status: 206, headers: { "content-length": String(slice.byteLength), "content-range": `bytes ${range[1]}-${end}/${found.bytes.byteLength}`, "content-type": found.type } });
  }
  const squeezed = found.type.startsWith("text/") && (squeezes === "always" || headers["accept-encoding"] !== "identity");
  // Squeezed, the file is sent with no length: what is sent is not what is kept.
  // (The stand-in says so and sends the bytes as they are; nothing here reads them.)
  const about: Record<string, string> = squeezed ? { "content-type": found.type, "content-encoding": "gzip" } : { "content-length": String(found.bytes.byteLength), "content-type": found.type };
  if (method === "HEAD") return new Response(null, { status: 200, headers: about });
  return new Response(found.bytes as BodyInit, { status: 200, headers: squeezed ? { "content-type": found.type } : about });
}) as typeof fetch;

/** The studio's browser, sending one piece to the address it was given. */
async function send(url: string, bytes: Uint8Array, type: string | null = null): Promise<string | null> {
  const response = await fetch(url, { method: "PUT", body: bytes as BodyInit, headers: type ? { "content-type": type } : {} });
  return response.headers.get("ETag");
}

function setUp(on: boolean): void {
  for (const [name, value] of [
    ["R2_ACCOUNT_ID", ACCOUNT],
    ["R2_ACCESS_KEY_ID", "a-stand-in-access-key-id"],
    ["R2_SECRET_ACCESS_KEY", "a-stand-in-secret-access-key-for-tests-only"],
    ["R2_BUCKET", BUCKET],
  ]) {
    if (on) process.env[name] = value;
    else delete process.env[name];
  }
}

const bytesOf = (n: number, seed = 7) => Uint8Array.from({ length: n }, (_, i) => (i * seed + 3) % 251);

async function main() {
  part("The path a sold file is kept under");
  const sample = vaultPath(FOLDER, "82f9fc6354", "0011223344556677", "My Guide (final) é.pdf");
  is("the name is made plain, so its address never needs escaping", sample, `vault/${FOLDER}/82f9fc6354/0011223344556677-My-Guide-final-e.pdf`);
  is("it reads back as the store, what it hangs on, and its name", readVaultPath(sample), { folder: FOLDER, ownerId: "82f9fc6354", name: "My-Guide-final-e.pdf" });
  is("a name with nothing plain in it is still a name", keyName("日本語"), "file");
  is("it is this store's, on this product", ownsVaultPath(sample, FOLDER, "82f9fc6354"), true);
  is("not another store's", ownsVaultPath(sample, OTHER_FOLDER, "82f9fc6354"), false);
  is("nor another product's", ownsVaultPath(sample, FOLDER, "aaaaaaaaaa"), false);
  is("the check every upload passes takes it as it takes a file in the host's store", [ownsPath(sample, FOLDER, "82f9fc6354"), ownsPath(sample, OTHER_FOLDER, "82f9fc6354"), ownsPath(`stores/${FOLDER}/82f9fc6354/a.pdf`, FOLDER, "82f9fc6354")], [true, false, true]);
  is("a file in the host's store is not one of these", isVaultPath(`stores/${FOLDER}/82f9fc6354/a.pdf`), false);
  is("nor is a path that climbs out", isVaultPath(`vault/${FOLDER}/../82f9fc6354/0011223344556677-a.pdf`), false);
  is("a buyer's stamped copy, kept in a folder beside the files, is", isVaultPath(`vault/${FOLDER}/stamped/${"a".repeat(24)}/${"b".repeat(24)}/My-Guide.pdf`), true);
  is("the store it belongs to is read from it, for the month's delivery", folderFromPathname(sample), FOLDER);

  part("How an upload is cut into pieces");
  is("a small file goes whole", [pieceCount(1), pieceCount(PIECE_BYTES)], [1, 1]);
  is("one byte more and it is two", pieceCount(PIECE_BYTES + 1), 2);
  is("every piece is full but the last", [pieceSize(PIECE_BYTES * 2 + 5, 1), pieceSize(PIECE_BYTES * 2 + 5, 2), pieceSize(PIECE_BYTES * 2 + 5, 3)], [PIECE_BYTES, PIECE_BYTES, 5]);
  is("and there is no piece before the first or after the last", [pieceSize(PIECE_BYTES * 2 + 5, 0), pieceSize(PIECE_BYTES * 2 + 5, 4), pieceSize(PIECE_BYTES * 2 + 5, 1.5)], [0, 0, 0]);
  is("the largest file here is 320 pieces, far under the store's ten thousand", pieceCount(5 * 1024 * 1024 * 1024), 320);

  part("Nothing runs until the store is set up");
  setUp(false);
  is("it is off", [isVaultConfigured(), vaultOrigin()], [false, null]);
  is("no upload is opened", await openVaultUpload({ folder: FOLDER, ownerId: "82f9fc6354", name: "a.pdf", bytes: 10, type: "application/pdf" }), { ok: false, reason: "off" });
  is("no address is made", vaultUrl(sample, 300), null);
  is("and the store was not asked anything", asked.length, 0);
  setUp(true);
  is("with its four settings it is on", [isVaultConfigured(), vaultOrigin()], [true, ORIGIN]);

  part("A large file goes up in pieces");
  const big = bytesOf(PIECE_BYTES * 2 + 1000);
  const opened = await openVaultUpload({ folder: FOLDER, ownerId: "82f9fc6354", name: "Course pack.zip", bytes: big.byteLength, type: "application/zip" });
  if (!opened.ok) return done();
  const { pathname } = opened.upload;
  is("it is opened at the store, as what it is", [opened.upload.pieces, opened.upload.pieceBytes, [...uploads.values()][0]?.type], [3, PIECE_BYTES, "application/zip"]);
  is("under a path in the store's own folder that nobody chose", [ownsVaultPath(pathname, FOLDER, "82f9fc6354"), readVaultPath(pathname)?.name], [true, "Course-pack.zip"]);
  const again = await openVaultUpload({ folder: FOLDER, ownerId: "82f9fc6354", name: "Course pack.zip", bytes: big.byteLength, type: "application/zip" });
  is("a second file of the same name gets a path of its own", again.ok && again.upload.pathname !== pathname, true);
  const addresses = await signPieces(pathname, [1, 2, 3]);
  const first = new URL(addresses?.[0].url ?? "https://none.invalid");
  is("each piece gets an address at the store, for that piece of that upload", [first.origin, first.pathname, first.searchParams.get("partNumber"), first.searchParams.get("uploadId")], [ORIGIN, `/${BUCKET}/${pathname}`, "1", "upload-1"]);
  is("good for an hour, and signed with the size the piece has to be", [first.searchParams.get("X-Amz-Expires"), first.searchParams.get("X-Amz-SignedHeaders"), /^[0-9a-f]{64}$/.test(first.searchParams.get("X-Amz-Signature") ?? "")], [String(PIECE_SECONDS), "content-length;host", true]);
  is("the secret is nowhere in it", (addresses?.[0].url ?? "").includes("a-stand-in-secret"), false);
  is("there is no address for a piece the file does not have", await signPieces(pathname, [4]), null);
  is("nor for an upload nobody opened", await signPieces(vaultPath(FOLDER, "82f9fc6354", "ffffffffffffffff", "x.zip"), [1]), null);
  const etags: string[] = [];
  for (const [i, address] of (addresses ?? []).entries()) etags.push((await send(address.url, big.slice(i * PIECE_BYTES, (i + 1) * PIECE_BYTES))) ?? "");
  is("closing it with a piece missing from the list is refused", await closeVaultUpload(pathname, etags.slice(0, 2)), { ok: false, reason: "invalid" });
  is("and with something that is not what the store answered", await closeVaultUpload(pathname, ["one", "two", "three"]), { ok: false, reason: "invalid" });
  const closed = await closeVaultUpload(pathname, etags);
  is("with every piece, it is joined and measured by the store itself", closed, { ok: true, file: { pathname, bytes: big.byteLength, contentType: "application/zip" } });
  is("the store holds the file exactly", md5(objects.get(pathname)?.bytes ?? new Uint8Array()), md5(big));
  is("and the upload cannot be closed, or added to, a second time", [await closeVaultUpload(pathname, etags), await signPieces(pathname, [1])], [{ ok: false, reason: "unknown" }, null]);

  part("A small file goes up whole");
  const small = bytesOf(5000, 11);
  const one = await openVaultUpload({ folder: FOLDER, ownerId: "82f9fc6354", name: "Guide.pdf", bytes: small.byteLength, type: "application/pdf" });
  if (!one.ok) return done();
  const [whole] = (await signPieces(one.upload.pathname, [1])) ?? [];
  is("to one address, with no upload opened at the store", [one.upload.pieces, new URL(whole.url).searchParams.has("uploadId"), uploads.size], [1, false, 1]);
  is("signed with its size and with what it is", [new URL(whole.url).searchParams.get("X-Amz-SignedHeaders"), whole.type], ["content-length;content-type;host", "application/pdf"]);
  await send(whole.url, small, whole.type);
  is("closed, it is the file the store measured", await closeVaultUpload(one.upload.pathname, []), { ok: true, file: { pathname: one.upload.pathname, bytes: 5000, contentType: "application/pdf" } });


  part("A negotiated small file uses a revocable session");
  const session = await openVaultUpload({ folder: FOLDER, ownerId: "82f9fc6354", name: "Session.pdf", bytes: 7, type: "application/pdf", multipart: true });
  if (!session.ok) throw new Error("Small multipart session did not open");
  const [sessionPart] = (await signPieces(session.upload.pathname, [1])) ?? [];
  is("one part is signed against an upload ID, never the bare object", [session.upload.pieces, session.upload.multipart, new URL(sessionPart.url).searchParams.has("uploadId"), sessionPart.type], [1, true, true, null]);
  const sessionBytes = bytesOf(7);
  const sessionEtag = (await send(sessionPart.url, sessionBytes))!;
  is("one part cannot complete without its ETag", await closeVaultUpload(session.upload.pathname, []), { ok: false, reason: "invalid" });
  is("completion joins and verifies the small file", await closeVaultUpload(session.upload.pathname, [sessionEtag]), { ok: true, file: { pathname: session.upload.pathname, bytes: 7, contentType: "application/pdf" } });
  await deleteVault([session.upload.pathname]);
  is("an old part URL cannot resurrect the completed then deleted file", (await fetch(sessionPart.url, { method: "PUT", body: sessionBytes as BodyInit })).status, 404);
  is("the completed file stays deleted", objects.has(session.upload.pathname), false);
  const cancelled = await openVaultUpload({ folder: FOLDER, ownerId: "82f9fc6354", name: "Cancel.pdf", bytes: 7, type: "application/pdf", multipart: true });
  if (!cancelled.ok) throw new Error("Cancel session did not open");
  const [cancelPart] = (await signPieces(cancelled.upload.pathname, [1])) ?? [];
  service = "down";
  is("an unreachable provider does not falsely confirm cancellation", await abortVaultUpload(cancelled.upload.pathname), false);
  service = "up";
  is("a failed cancellation keeps the session available to retry", (await signPieces(cancelled.upload.pathname, [1]))?.length, 1);
  is("a retry confirms cancellation at the provider", await abortVaultUpload(cancelled.upload.pathname), true);
  is("a part URL from an aborted session cannot create a file", (await fetch(cancelPart.url, { method: "PUT", body: sessionBytes as BodyInit })).status, 404);
  is("the canceled file does not exist", objects.has(cancelled.upload.pathname), false);

  part("A file of text, which the store squeezes on its way out");
  const notes = bytesOf(3000, 23);
  const text = await openVaultUpload({ folder: FOLDER, ownerId: "82f9fc6354", name: "Notes.txt", bytes: notes.byteLength, type: "text/plain" });
  if (!text.ok) return done();
  const [plainAddress] = (await signPieces(text.upload.pathname, [1])) ?? [];
  await send(plainAddress.url, notes, plainAddress.type);
  const askedBefore = asked.length;
  is("is measured as it is kept, because we ask for it as it is kept", await closeVaultUpload(text.upload.pathname, []), { ok: true, file: { pathname: text.upload.pathname, bytes: 3000, contentType: "text/plain" } });
  is("in one question", asked.slice(askedBefore), [`HEAD /${BUCKET}/${text.upload.pathname}`]);
  is("and is kept", objects.has(text.upload.pathname), true);
  squeezes = "always";
  const askedSqueezed = asked.length;
  is("squeezed all the same, its size is read from its first byte", await headVault(text.upload.pathname), { bytes: 3000, contentType: "text/plain" });
  is("which is asked for after the store stated no length", asked.slice(askedSqueezed), [`HEAD /${BUCKET}/${text.upload.pathname}`, `GET /${BUCKET}/${text.upload.pathname}`]);
  is("a file that is not text is still measured in one question", [await headVault(one.upload.pathname), asked.length - askedSqueezed], [{ bytes: 5000, contentType: "application/pdf" }, 3]);
  // An empty file of text: there is no first byte to give.
  objects.set(`vault/${FOLDER}/82f9fc6354/00000000000000aa-empty.txt`, { bytes: new Uint8Array(), type: "text/plain" });
  is("an empty one is empty, not out of reach", await headVault(`vault/${FOLDER}/82f9fc6354/00000000000000aa-empty.txt`), { bytes: 0, contentType: "text/plain" });
  squeezes = "asked";
  await deleteVault([text.upload.pathname, `vault/${FOLDER}/82f9fc6354/00000000000000aa-empty.txt`]);

  part("The studio says one size and sends another");
  const lying = await openVaultUpload({ folder: FOLDER, ownerId: "82f9fc6354", name: "Not what it said.zip", bytes: PIECE_BYTES + 10, type: "application/zip" });
  if (!lying.ok) return done();
  const lies = (await signPieces(lying.upload.pathname, [1, 2])) ?? [];
  // The real store refuses a piece of another size by its signature; this
  // stand-in lets it through, so the check after it is the one being held.
  const sentEtags = [await send(lies[0].url, bytesOf(PIECE_BYTES)), await send(lies[1].url, bytesOf(99_999))].map((e) => e ?? "");
  is("the file is refused", await closeVaultUpload(lying.upload.pathname, sentEtags), { ok: false, reason: "invalid" });
  is("and not kept", objects.has(lying.upload.pathname), false);

  part("An upload that is given up");
  const gone = await openVaultUpload({ folder: FOLDER, ownerId: "82f9fc6354", name: "Half.zip", bytes: PIECE_BYTES * 2, type: "application/zip" });
  if (!gone.ok) return done();
  const before = uploads.size;
  await abortVaultUpload(gone.upload.pathname);
  is("its pieces are thrown away at the store", uploads.size, before - 1);
  is("and it is forgotten here", await signPieces(gone.upload.pathname, [1]), null);

  part("A file in the store");
  is("is measured by the store", await headVault(pathname), { bytes: big.byteLength, contentType: "application/zip" });
  is("one that is not there is said not to be", await headVault(vaultPath(FOLDER, "82f9fc6354", "ffffffffffffffff", "x.zip")), null);
  is("through the one door every server file uses, too", await headFile(pathname), { pathname, size: big.byteLength, contentType: "application/zip" });
  service = "down";
  is("a store that cannot be reached is not mistaken for a missing file", await headVault(pathname), "unreachable");
  is("and a delete that did not happen is not reported as done", await deleteVault([pathname]), false);
  service = "up";

  part("The address a buyer is handed");
  const address = new URL(vaultUrl(pathname, 300, 'Course "pack" é.zip') ?? "https://none.invalid");
  is("is the file's own, at the store, for five minutes", [address.origin, address.pathname, address.searchParams.get("X-Amz-Expires")], [ORIGIN, `/${BUCKET}/${pathname}`, "300"]);
  is(
    "and saves under the name the creator gave it, any character surviving",
    address.searchParams.get("response-content-disposition"),
    `attachment; filename="Course _pack_ _.zip"; filename*=UTF-8''${encodeURIComponent('Course "pack" é.zip')}`,
  );
  is("a lesson's video is played, not saved: no name is forced on it", new URL((await fileUrl(pathname, 14_400)) ?? "https://none.invalid").searchParams.has("response-content-disposition"), false);
  is("fetched with that address, it is the file", md5(new Uint8Array(await (await fetch(address)).arrayBuffer())), md5(big));
  is("there is no address for a path that is not one of these", vaultUrl(`stores/${FOLDER}/82f9fc6354/a.pdf`, 300), null);

  part("A buyer's stamped copy, written and read by us");
  const copy = `vault/${FOLDER}/stamped/${"a".repeat(24)}/${"b".repeat(24)}/Guide.pdf`;
  await writeFileWhole(copy, bytesOf(2000, 5), "application/pdf");
  is("it is kept as what it is", objects.get(copy)?.type, "application/pdf");
  is("and read back whole", md5((await readFileWhole(copy, 10_000)) ?? new Uint8Array()), md5(bytesOf(2000, 5)));
  is("a file over the size we will hold in memory is not read", await readVault(copy, 1999), null);
  is("the copies of one file are found by their folder", await listFiles(`vault/${FOLDER}/stamped/${"a".repeat(24)}/`), [copy]);

  part("What a store keeps here");
  is("is every file in its folder, page after page", await vaultHeld(FOLDER), big.byteLength + 5000 + 2000);
  is("a listing gives a page at a time", [(await listVault(`vault/${FOLDER}/`))?.files.length, typeof (await listVault(`vault/${FOLDER}/`))?.cursor], [2, "string"]);
  is("a store with nothing here keeps nothing", await vaultHeld(OTHER_FOLDER), 0);
  service = "down";
  is("and a count that cannot be read is said to be unknown, not zero", await vaultHeld(FOLDER), null);
  service = "up";

  part("Incomplete storage listings never authorize new storage");
  const bucket=(body:string)=>`<ListBucketResult>${body}</ListBucketResult>`;
  for(const bad of [
    "<Error/>",
    "<ListBucketResult><IsTruncated>false</IsTruncated>",
    bucket("<IsTruncated>false</IsTruncated><Contents><Key>broken</Key>"),
    bucket(""),
    bucket("<IsTruncated>maybe</IsTruncated>"),
    bucket("<IsTruncated>true</IsTruncated>"),
    ...["", "-1", "NaN", "1.5", "9007199254740992"].map(size=>bucket(`<IsTruncated>false</IsTruncated><Contents><Key>vault/${FOLDER}/bad</Key><Size>${size}</Size></Contents>`)),
    bucket("<IsTruncated>false</IsTruncated><Contents><Key>outside/folder</Key><Size>1</Size></Contents>"),
  ]){
    listingOverride=()=>bad;
    is("malformed page is unavailable",await vaultHeld(FOLDER),null);
  }
  listingOverride=()=>bucket("<IsTruncated>true</IsTruncated><NextContinuationToken>same</NextContinuationToken>");
  is("repeated cursor is incomplete",await vaultHeld(FOLDER),null);
  listingOverride=()=>bucket(`<IsTruncated>false</IsTruncated><Contents><Key>vault/${FOLDER}/same</Key><Size>1</Size></Contents><Contents><Key>vault/${FOLDER}/same</Key><Size>1</Size></Contents>`);
  is("duplicate file is not a complete measurement",await vaultHeld(FOLDER),null);
  listingOverride=(url)=>bucket(`<IsTruncated>true</IsTruncated><NextContinuationToken>${Number(url.searchParams.get("continuation-token")??0)+1}</NextContinuationToken>`);
  is("page cap is not a completed listing",await vaultHeld(FOLDER),null);
  listingOverride=(url)=>{
    const page=Number(url.searchParams.get("continuation-token")??0);
    return bucket(`<IsTruncated>${page<19}</IsTruncated>${page<19?`<NextContinuationToken>${page+1}</NextContinuationToken>`:""}`);
  };
  is("final page at page cap is complete",await vaultHeld(FOLDER),0);
  const listed=(count:number,start=0,size=1)=>Array.from({length:count},(_,i)=>`<Contents><Key>vault/${FOLDER}/bounded-${start+i}</Key><Size>${size}</Size></Contents>`).join("");
  listingOverride=()=>bucket("<IsTruncated>false</IsTruncated>"+listed(1000));
  is("a full requested thousand-key page remains complete",[(await listVault(`vault/${FOLDER}/`))?.files.length,await vaultHeld(FOLDER)],[1000,1000]);
  listingOverride=()=>bucket("<IsTruncated>false</IsTruncated>"+listed(1001,0,0));
  is("an oversized S3 page cannot be exposed as a complete listing",await listVault(`vault/${FOLDER}/`),null);
  is("an oversized zero-byte final page is unknown, never empty",await vaultHeld(FOLDER),null);
  listingOverride=(url)=>url.searchParams.has("continuation-token")
    ?bucket("<IsTruncated>false</IsTruncated>"+listed(1001,100,0))
    :bucket("<IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken>"+listed(1,0,5));
  is("an oversized later S3 page never returns the valid partial prefix",await vaultHeld(FOLDER),null);
  listingOverride=(url)=>{
    const page=Number(url.searchParams.get("continuation-token")??0);
    return bucket(`<IsTruncated>${page<19}</IsTruncated>${listed(1000,page*1000)}${page<19?`<NextContinuationToken>${page+1}</NextContinuationToken>`:""}`);
  };
  is("twenty full requested S3 pages remain measurable",await vaultHeld(FOLDER),20000);
  listingOverride=()=>bucket("<IsTruncated>false</IsTruncated><KeyCount>0</KeyCount><MaxKeys>1000</MaxKeys>");
  is("explicit consistent empty listing remains zero",await vaultHeld(FOLDER),0);
  listingOverride=()=>`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated><KeyCount>1</KeyCount><MaxKeys>1000</MaxKeys>${listed(1)}</ListBucketResult>`;
  is("consistent declared counts and the standard default namespace remain usable",[(await listVault(`vault/${FOLDER}/`))?.files.length,await vaultHeld(FOLDER)],[1,1]);
  listingOverride=()=>bucket("<IsTruncated>false</IsTruncated><KeyCount>1000</KeyCount><MaxKeys>1000</MaxKeys>"+listed(1000));
  is("the full declared requested page remains measurable",await vaultHeld(FOLDER),1000);
  const invalidEvidence=[
    "<IsTruncated>false</IsTruncated><KeyCount>1</KeyCount>",
    "<IsTruncated>false</IsTruncated><KeyCount>0</KeyCount>"+listed(1),
    ...["-1","0.5","1e3","NaN","","1001"].map(value=>"<IsTruncated>false</IsTruncated><KeyCount>"+value+"</KeyCount>"+listed(1)),
    "<IsTruncated>false</IsTruncated><KeyCount>1</KeyCount><KeyCount>1</KeyCount>"+listed(1),
    "<IsTruncated>false</IsTruncated><KeyCount>1</KeyCount><KeyCount>2</KeyCount>"+listed(1),
    "<IsTruncated>false</IsTruncated><IsTruncated>true</IsTruncated>",
    "<IsTruncated>false</IsTruncated><MaxKeys>0</MaxKeys>"+listed(1),
    "<IsTruncated>false</IsTruncated><MaxKeys>1001</MaxKeys>"+listed(1),
    "<IsTruncated>false</IsTruncated><MaxKeys>1000</MaxKeys><MaxKeys>1000</MaxKeys>"+listed(1),
    `<IsTruncated>false</IsTruncated><s3:Contents xmlns:s3="http://s3.amazonaws.com/doc/2006-03-01/"><s3:Key>vault/${FOLDER}/hidden</s3:Key><s3:Size>1</s3:Size></s3:Contents>`,
    `<IsTruncated>false</IsTruncated><Contents unexpected="true"><Key>vault/${FOLDER}/hidden</Key><Size>1</Size></Contents>`,
    "<IsTruncated>false</IsTruncated><KeyCount unexpected=\"true\">1</KeyCount>",
    "<IsTruncated>false</IsTruncated><s3:KeyCount xmlns:s3=\"http://s3.amazonaws.com/doc/2006-03-01/\">1</s3:KeyCount>",
  ];
  for(const body of invalidEvidence){
    listingOverride=()=>bucket(body);
    is("contradictory or unsupported listing evidence never becomes a complete listing",await listVault(`vault/${FOLDER}/`),null);
    is("contradictory or unsupported listing evidence is unknown, never zero",await vaultHeld(FOLDER),null);
  }
  listingOverride=null;

  part("A creator removes a file");
  await deleteFile([pathname, copy]);
  is("it is gone from the store", [objects.has(pathname), objects.has(copy)], [false, false]);
  is("deleting what is already gone is not a failure", await deleteVault([pathname]), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
