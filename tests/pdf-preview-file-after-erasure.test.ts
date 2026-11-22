/**
 * A preview's FILE after its store's erasure (Claude 4 Z's LOW on #5068): previewCopy (lib/pdf-preview.ts) writes
 * `preview-*.pdf` into the store's copy folder (lib/pdf-stamp.ts writeWithinStorage) before the live keeper decides
 * whether its record may be kept. When the erasure's folder cleanup has already passed that folder, the keeper says
 * the store is erased and no record is kept (#5068), but the file it had just written stayed in storage with nothing
 * pointing at it and nothing to delete it later: the first pages of the creator's PDF, kept for a store erased.
 *
 * Held here, through the real route (app/api/store/preview/route.ts) and the real fence (lib/live-fence.ts):
 *   - the store's erasure begun (its erasing mark) or finished (its record closed) after the folder was cleaned and
 *     before the keeper: the request is refused and no `preview-*.pdf` is left under the store's folder;
 *   - a live store keeps both its preview file and its record (control);
 *   - a request made under the old owner ref of a store moved to another account meanwhile is refused, but the file
 *     is not deleted: the moved store is live, and its own fresh request may have kept a record for that same path;
 *   - an unknown answer from the keeper deletes nothing: the record may have been kept (rule 24);
 *   - a store whose id key is not set yet while its record already carries its id (lib/store.ts ensureStoreId saves the
 *     record first; Claude 5 icEJ's LEVE on #5140) is refused without deleting the file, and served once the key is set.
 * Synthetic stores, a synthetic PDF made with pdf-lib, an in-memory file store, the Redis stub.
 */
import { NextRequest } from "next/server";
import { PDFDocument } from "pdf-lib";
import { addProduct, claimHandle, closeStoreRecord, ensureStatsId, ERASING_KEY, erasingField, moveAccount, setProductFile, setProductPreview, setStripeAccount, setSubscription, storeFolder, storeForEmail, storeIdCommand, storeRef } from "@/lib/store";
import { dataKey } from "@/lib/store-data";
import type { ProductFile } from "@/lib/product-file";
import { previewKey } from "@/lib/pdf-preview";
import { GET } from "@/app/api/store/preview/route";
import { store as redis } from "./redis-stub";
import { files } from "./r30-blob-world";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "drop.preview@example.com";
const MOVED = "drop.moved@example.test";
const HANDLE = "droppreview";

async function readablePdf(pages = 4): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([300, 400]);
  return doc.save({ useObjectStreams: false });
}

let address = 0;
async function ask(id: string): Promise<number> {
  address += 1;
  const response = await GET(new NextRequest(`https://marktmorgen.com/api/store/preview?handle=${HANDLE}&product=${id}`, { headers: { "x-forwarded-for": `203.0.113.${1 + (address % 200)}` } }));
  return response.status;
}

/** The preview files kept anywhere under a store's folder. */
const previewFiles = (folder: string) => [...files.keys()].filter((path) => path.startsWith(`stores/${folder}/`) && /\/preview-[^/]+\.pdf$/.test(path));

async function fixture(): Promise<{ id: string; file: ProductFile; folder: string }> {
  redis.clear();
  files.clear();
  await claimHandle(OWNER, HANDLE, "Drop Preview", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1DropPrev01", true);
  await setSubscription(OWNER, { customerId: "cus_DropPrev", subscriptionId: "sub_DropPrev", active: true, period: paidPeriod() });
  const added = await addProduct(OWNER, "Workbook", "Workbook, synthetic", "12");
  if (!added.ok) throw new Error(`product: ${JSON.stringify(added)}`);
  const id = added.product.id;
  const folder = await storeFolder(OWNER);
  const pdf = await readablePdf();
  const pathname = `stores/${folder}/${id}/workbook.pdf`;
  files.set(pathname, { bytes: pdf, contentType: "application/pdf" });
  const file: ProductFile = { pathname, name: "Synthetic private workbook.pdf", bytes: pdf.byteLength, contentType: "application/pdf", addedAt: "2026-11-01T00:00:00.000Z" };
  const set = await setProductFile(OWNER, id, file);
  if (!set.ok) throw new Error(`file: ${JSON.stringify(set)}`);
  const pv = await setProductPreview(OWNER, id, 3);
  if (!pv.ok) throw new Error(`preview: ${JSON.stringify(pv)}`);
  return { id, file, folder };
}

const isKeeper = (key: string) => (commands: (string | number)[][]) => commands.some((c) => (c[0] === "SET" && c[1] === key) || (c[0] === "EVAL" && c[5] === key));

async function main(): Promise<void> {
  for (const state of ["live", "erasing", "closed", "moved-live", "id-being-set"] as const) {
    part(`The preview file once its store's folder was cleaned before the keeper: ${state}`);
    const f = await fixture();
    const key = previewKey(f.file, 3);
    const parent = (await storeForEmail(OWNER))!;
    const pipeline = redis.pipeline.bind(redis);
    let hits = 0;
    let freshStatus = 0;
    redis.pipeline = async (commands) => {
      if (!hits && isKeeper(key)(commands)) {
        hits++;
        is("the preview file was written before the keeper runs", previewFiles(f.folder).length, 1);
        if (state === "erasing") {
          await pipeline([["HSET", ERASING_KEY, await erasingField(storeRef(parent)), String(Date.now())], ["DEL", key, dataKey(parent)!]]);
        } else if (state === "closed") {
          is("the real store close completes", await closeStoreRecord(parent, [key, dataKey(parent)!]), true);
        } else if (state === "moved-live") {
          const moved = await moveAccount(OWNER, MOVED);
          is("the real account move completes", moved.ok, true);
          const found = await storeForEmail(MOVED);
          if (!moved.ok || !found || found.sid !== parent.sid || found.statsId !== parent.statsId) throw new Error("move fixture");
          // The moved store's own visitor makes and keeps the preview, at the same path, before the stale keeper answers.
          freshStatus = await ask(f.id);
        } else if (state === "id-being-set") {
          // Between ensureStoreId's save of the record (with its sid) and its SET of the id key: the key is not there yet.
          await pipeline([["DEL", storeIdCommand(parent.sid)[1]]]);
        }
        if (state === "erasing" || state === "closed") {
          // The erasure's folder cleanup passed this folder before the preview file was written: everything else is gone.
          for (const path of [...files.keys()]) if (path.startsWith(`stores/${f.folder}/`) && !previewFiles(f.folder).includes(path)) files.delete(path);
        }
      }
      return pipeline(commands);
    };
    let status: number;
    try { status = await ask(f.id); }
    finally { redis.pipeline = pipeline; }
    is("the real route reached its final preview write exactly once", hits, 1);
    const kept = (await pipeline([["GET", key]]))[0];
    if (state === "live") {
      is("a live store is served and keeps its record", [status, typeof kept === "string"], [200, true]);
      is("and its preview file", previewFiles(f.folder).length, 1);
      is("the record names that very file", typeof kept === "string" && files.has((JSON.parse(kept) as ProductFile).pathname), true);
    } else if (state === "moved-live") {
      is("the moved store's fresh request is served", freshStatus, 200);
      is("the stale request under the old owner is refused", status, 404);
      is("the moved store's record is kept", typeof kept === "string", true);
      is("and the file it names is still there: the stale request deletes nothing", typeof kept === "string" && files.has((JSON.parse(kept) as ProductFile).pathname), true);
    } else if (state === "id-being-set") {
      is("the request is refused while the id key is not set, with no record", [status, kept], [404, null]);
      is("but the preview file is not deleted: the store is live and only being given its id", previewFiles(f.folder).length, 1);
      await pipeline([["SET", storeIdCommand(parent.sid)[1], storeRef(parent)]]);
      is("once the id key is set, the next request is served", await ask(f.id), 200);
    } else {
      is("the erased store's request is refused, with no record", [status, kept], [404, null]);
      is("and no preview file is left in the erased store's folder", previewFiles(f.folder), []);
    }
  }

  part("An unknown answer from the keeper deletes nothing (rule 24): its record may have been kept");
  {
    const f = await fixture();
    const key = previewKey(f.file, 3);
    const pipeline = redis.pipeline.bind(redis);
    let picked = 0;
    redis.pipeline = async (commands) => {
      const out = await pipeline(commands);
      if (!isKeeper(key)(commands)) return out;
      picked += 1;
      return ["QUEUED"];
    };
    let status: number;
    try { status = await ask(f.id); }
    finally { redis.pipeline = pipeline; }
    const kept = (await pipeline([["GET", key]]))[0];
    is("the unknown answer is refused once", [status, picked], [404, 1]);
    is("the record the stub did keep is there", typeof kept === "string", true);
    is("and its file is not deleted", typeof kept === "string" && files.has((JSON.parse(kept) as ProductFile).pathname), true);
    is("so the next request is served from it", await ask(f.id), 200);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
