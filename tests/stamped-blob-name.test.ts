/**
 * A buyer's stamped copy of a file kept in the host's own store (Vercel Blob) is kept under a plain name.
 *
 * The defect (uploads audit, Claude 1, 12 November 2026): lib/pdf-stamp.ts made the copy's path from the creator's
 * own name for the file when the original sits in Blob (only the vault's took keyName). A name with "#" or "?" (both
 * kept by safeFileName: "Workbook #2?.pdf") is written whole, because the SDK sends a put's path as a query value,
 * but read back from https://<store>.private.blob.vercel-storage.com/<path> unescaped (@vercel/blob constructBlobUrl),
 * where "#" starts a fragment and "?" a query: the read asks for another path and answers 404, and the copy's record
 * is reused for 400 days, so every download of that sale failed. The name the buyer saves it under is kept beside.
 */
import { MockAgent, setGlobalDispatcher } from "undici";
import { PDFDocument } from "pdf-lib";
import { stampedCopy } from "@/lib/pdf-stamp";
import { get } from "@/lib/blob";
import type { ProductFile } from "@/lib/product-file";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STORE_ID = "AbCdEf0123456789";
process.env.BLOB_READ_WRITE_TOKEN = `vercel_blob_rw_${STORE_ID}_aStandInSecretForTestsOnly0123456789`;
const FOLDER = "0123456789abcdef0123456789abcdef";

/** What the Blob service keeps, by the path it was given. */
const kept = new Map<string, Uint8Array>();

// The SDK's calls go through undici's own fetch: answered by a stand-in of the service that keeps a put under the path
// it was sent as a query value, and reads a get from the path of the address asked, as a web server does.
const agent = new MockAgent();
agent.disableNetConnect();
setGlobalDispatcher(agent);
agent
  .get("https://vercel.com")
  .intercept({ path: (path: string) => path.startsWith("/api/blob"), method: "PUT" })
  .reply(200, (options: { path: string; body?: unknown }) => {
    const pathname = new URL(options.path, "https://vercel.com").searchParams.get("pathname") ?? "";
    const body = options.body;
    kept.set(pathname, body instanceof Uint8Array ? new Uint8Array(body) : typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(0));
    const at = `https://${STORE_ID}.private.blob.vercel-storage.com/${pathname}`;
    return { url: at, downloadUrl: `${at}?download=1`, pathname, contentType: "application/pdf", contentDisposition: "attachment" };
  })
  .persist();
agent
  .get(`https://${STORE_ID.toLowerCase()}.private.blob.vercel-storage.com`)
  .intercept({ path: () => true, method: "GET" })
  .reply((options: { path: string }) => {
    const found = kept.get(decodeURIComponent(new URL(options.path, "https://x").pathname.slice(1)));
    return found ? { statusCode: 200, data: Buffer.from(found), responseOptions: { headers: { "content-type": "application/pdf", "content-length": String(found.byteLength) } } } : { statusCode: 404, data: "Not found" };
  })
  .persist();

async function main() {
  redis.clear();
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  const bytes = await pdf.save();
  const original = `stores/${FOLDER}/p1/workbook-2.pdf`;
  kept.set(original, bytes);
  const file: ProductFile = { pathname: original, name: "Workbook #2?.pdf", bytes: bytes.byteLength, contentType: "application/pdf", addedAt: "2026-11-03T12:00:00.000Z" };
  const store = { sid: "stamp-blob-name", tier: "creator" as const, subscriptionActive: true, subscriptionId: "sub_1", trialEnds: 0, planEndedAt: "" };
  const sale = { reference: "cs_test_a1B2c3D4e5F6", email: "maya@example.com", paidAt: Date.UTC(2026, 10, 3) / 1000 };

  part("A copy of a file in the host's own store");
  const copy = await stampedCopy(file, sale, store);
  is("a copy is made, saved by the buyer under the creator's own name", [copy !== null, copy?.name], [true, "Workbook #2?.pdf"]);
  is("kept under plain characters only, so its address never needs escaping", /^[A-Za-z0-9._-]+$/.test(copy?.pathname.split("/").pop() ?? ""), true);
  const read = copy ? await get(copy.pathname, { access: "private" }) : null;
  is("and it can be read back, as a download does", read?.statusCode, 200);
  const again = await stampedCopy(file, sale, store);
  is("the same sale is handed the same copy", again?.pathname, copy?.pathname);

  done();
}

void main();
