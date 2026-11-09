import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { withinEssentialLimit } from "@/lib/request-guard";
import { AI_PER_MINUTE, MAX_AI_NOTES } from "@/lib/ai-rules";
import { AI_RUN_ID, AI_STEP_PADDING_BYTES, type AiStepLine } from "@/lib/ai-steps";
import { AI_FILE_SAVE_BYTES, readFileDraft, readOutlineInput } from "@/lib/ai-file-rules";
import { reviewDone } from "@/lib/ai-draft-review";
import { fileTargetProblem, grantFileSave, saveAiFile, sectionRequests, takeFileSave, writeFileOutline, writeFileSections, type FileSaveIo } from "@/lib/ai-file";
import { readListing } from "@/lib/catalog";
import { costPauseCode, standingOf } from "@/lib/plan-standing";
import { isVaultConfigured, writeVault } from "@/lib/vault";
import { deleteFile, headFile } from "@/lib/file-store";
import { reserveStoreUpload } from "@/lib/upload-budget";
import { reserveStorage, releaseStorage } from "@/lib/storage-reservations";
import { storageBrakeFor, storageUsed } from "@/lib/storage-quota";
import { setProductFile, storeFolder } from "@/lib/store";
import { rememberFolderOwner } from "@/lib/delivery";

/**
 * Five model calls at a time, each waited on for at most 45 seconds, and two
 * batches for the most parts a file may have, then the stop's mark and the
 * answer: well inside three minutes. The deployment's plan must allow it.
 */
export const maxDuration = 180;

/**
 * The product's file written with AI (758 [STN5], unit 3; lib/ai-file.ts):
 *
 *   { action: "outline", product, notes }                     the plan: one writing job
 *   { action: "sections", product, outline, notes, run }      the parts, step by step: one job each
 *   { action: "save", product, run, draft, checks }           the checked text as a tagged PDF,
 *                                                             kept as this draft product's file
 *
 * A stop goes to the writing help's own route (`{ kind: "stop", run }`,
 * app/api/store/ai/route.ts). Only for a product the store does not show
 * yet, with nothing handed over; never publishes it. Who may ask is who may
 * change products.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products", AI_FILE_SAVE_BYTES);
  if (!guarded.ok) return guarded.response;
  const { body, store, ref } = guarded;
  const fail = (error: string, status = 400) => Response.json({ ok: false, error }, { status });
  const action = text(body.action, 10);
  if (action !== "outline" && action !== "sections" && action !== "save") return fail("invalid");
  const run = text(body.run, 60);
  if (action !== "outline" && !AI_RUN_ID.test(run)) return fail("invalid");

  const product = await readListing(store, text(body.product, 40));
  const problem = fileTargetProblem(product);
  if (problem || !product) return fail(problem ?? "unknown", problem === "unknown" ? 404 : 409);
  // Nothing is written, and so nothing is asked of the model, while the file could not be kept.
  if (!isVaultConfigured()) return fail("off", 503);
  { const paused = costPauseCode(store); if (paused) return fail(paused, 409); }
  if (!(await withinEssentialLimit("ai", store.sid || store.handle, AI_PER_MINUTE, 60))) return fail("slow", 429);
  const notes = text(body.notes, MAX_AI_NOTES + 100);

  if (action === "outline") {
    const done = await writeFileOutline(store, { productTitle: product.title, notes });
    if (!done.ok) return fail(done.reason, done.reason === "failed" ? 502 : 400);
    return Response.json({ ok: true, value: done.value, left: done.left });
  }

  if (action === "sections") {
    const outline = readOutlineInput(body.outline);
    if (!outline) return fail("invalid");
    const input = { productTitle: product.title, outline, notes };
    // A plan too big for one request is refused before anything is taken.
    if (!sectionRequests(store, input)) return fail("long");
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (line: AiStepLine | { pad: string }) => {
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
          } catch {
            // The page has gone; the job goes on to its end and keeps its count.
          }
        };
        send({ pad: " ".repeat(AI_STEP_PADDING_BYTES) });
        let last: AiStepLine = { done: true, ok: false, error: "failed" };
        try {
          const done = await writeFileSections(store, input, { run, onStep: (step, state) => send({ step, state }) });
          // What this run wrote may be made into a PDF once; a mark that could not be kept says so instead of a draft that cannot be saved.
          const wrote = done.ok || ("value" in done && done.value !== undefined);
          if (wrote && !(await grantFileSave(store, run))) console.error("a file's save could not be allowed");
          last = done.ok
            ? { done: true, ok: true, value: done.value, left: done.left }
            : "returned" in done
              ? { done: true, ok: false, error: done.reason, returned: done.returned, left: done.left, ...(done.value !== undefined ? { value: done.value } : {}) }
              : { done: true, ok: false, error: done.reason };
        } catch (error) {
          console.error("a file written step by step failed", error);
        }
        send(last);
        try {
          controller.close();
        } catch {
          // Already closed by the page going away.
        }
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" },
    });
  }

  // The save: only once the creator checked the draft (756 [STN3]), only once for each run of parts.
  if (!Array.isArray(body.checks) || !reviewDone(body.checks as boolean[])) return fail("unchecked");
  const draft = readFileDraft(body.draft);
  if (!draft) return fail("invalid");
  const taken = await takeFileSave(store, run);
  if (taken === null) return fail("unconfirmed", 503);
  if (!taken) return fail("expired", 409);
  const brake = storageBrakeFor(standingOf(store), store.tier);
  const io: FileSaveIo = {
    folder: () => storeFolder(ref),
    reserveUpload: (size) => reserveStoreUpload(store, size, "r2"),
    reserveRoom: async (folder, size) =>
      (
        await reserveStorage(folder, size, brake, async () => {
          const held = await storageUsed(folder, brake);
          if (held.available !== true) throw new Error("storage_unknown");
          return held.bytes;
        })
      ).id,
    releaseRoom: (folder, id) => releaseStorage(folder, id),
    write: (pathname, bytes) => writeVault(pathname, bytes, "application/pdf"),
    measure: async (pathname) => {
      const found = await headFile(pathname);
      return { size: found.size, contentType: found.contentType };
    },
    remove: (pathname) => deleteFile(pathname),
    attach: async (file) => {
      const result = await setProductFile(ref, product.id, file);
      return result.ok ? { ok: true, removed: result.removed } : { ok: false, reason: result.reason };
    },
    rememberOwner: (folder) => rememberFolderOwner(folder, ref),
  };
  const saved = await saveAiFile(store, product.id, draft, io);
  if (!saved.ok) {
    // Nothing was kept: the run's one save is given back, so the creator can try again with the same text.
    if (saved.error !== "changed") await grantFileSave(store, run).catch(() => false);
    return fail(saved.error, saved.error === "failed" ? 502 : saved.error === "upload_budget_unavailable" ? 503 : 409);
  }
  return Response.json({ ok: true, file: { name: saved.file.name, bytes: saved.file.bytes }, pages: saved.pages });
}
