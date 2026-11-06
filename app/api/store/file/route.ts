import { reserveStoreUpload } from "@/lib/upload-budget";
import type { NextRequest } from "next/server";
import { readKind } from "@/lib/catalog";
import { issueSignedToken } from "@/lib/blob";
import {
  handleUploadPresigned,
  type HandleUploadPresignedBody,
} from "@vercel/blob/client";
import { studioAccess } from "@/lib/studio-route";
import { ownsDeliveryId, storeFolder } from "@/lib/store";
import {
  ALLOWED_CONTENT_TYPES,
  MAX_FILE_BYTES,
  ownsPath,
} from "@/lib/product-file";
import { ITEM_ID_PATTERN, findLesson, readCourses } from "@/lib/course";
import { costPauseCode, storageRefusal, standingOf } from "@/lib/plan-standing";
import { maximumUploadBytes, storageBrakeFor, storageUsed } from "@/lib/storage-quota";
import { rememberFolderOwner } from "@/lib/delivery";
import { isVaultConfigured } from "@/lib/vault";
import { fromAnotherSite, limited } from "@/lib/request-guard";

/** How long the creator has to start the upload after asking for the door. */
const UPLOAD_WINDOW_MS = 10 * 60 * 1000;

/**
 * Hands the browser a one-off, time-limited door into the private file store.
 *
 * The file never passes through this server. The browser asks here, we check
 * that the person is signed in and that the path they want is inside their own
 * folder, and we sign a URL that accepts one upload of one kind of file up to
 * one size. Everything the signature allows is spelled out in it, so the door
 * cannot be widened by whoever holds it.
 *
 * This route is also where Vercel posts back when an upload finishes. That
 * message carries no session, and is trusted only because it is signed; the
 * signature is checked by the SDK against the store's public key. We do not
 * act on it — the browser tells us about its own upload, and that claim is
 * checked against the store before anything is saved — so it exists here only
 * to be answered politely rather than retried five times.
 */
export async function POST(request: NextRequest) {
  // Refused before anything else is read: another site, by Origin or by
  // Sec-Fetch-Site (lib/request-guard.ts).
  if (fromAnotherSite(request)) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });

  let body: HandleUploadPresignedBody;
  try {
    body = (await (await limited(request, 16_000)).json()) as HandleUploadPresignedBody;
  } catch {
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }

  try {
    const answer = await handleUploadPresigned({
      body,
      request,
      // The docs are explicit that this is where a route like ours has to
      // prove who is asking. Everything below runs before any URL is signed.
      getSignedToken: async (pathname, clientPayload) => {
        // Who, which store and whether their role has "products"
        // (lib/studio-route.ts); the folder below is that store's own.
        const access = await studioAccess(request, "products");
        if (!access.ok) throw new Error(access.reason === "no_store" ? "none" : access.reason);
        const { store, ref } = access.access;

        /*
          This door leads to the host's own file store, where every download
          costs by the gigabyte. A file that is sold goes to the store that
          charges nothing to send it (app/api/store/vault) wherever that one
          is set up, and the studio only comes here when it is told it is
          not. So this door is shut while that store is set up, whoever
          asks; and on the site people pay for it is shut either way, because
          every plan's worst case is worked out with downloads costing
          nothing (tests/plan-margin.test.ts), and a setting gone missing
          must stop an upload, loudly, not quietly bring the cost back.
        */
        if (isVaultConfigured() || process.env.VERCEL_ENV === "production") throw new Error("files_unavailable");

        let productId = "";
        try {
          const parsed = JSON.parse(clientPayload ?? "{}") as {
            productId?: unknown;
          };
          productId = typeof parsed.productId === "string" ? parsed.productId : "";
        } catch {
          throw new Error("invalid");
        }
        // A price option owns a folder exactly as a product does, and its id
        // is unique across the store, so one check covers both. A lesson of
        // one of the store's courses owns one too.
        if (!ownsDeliveryId(store, productId)) {
          const courseIds = (await readKind(store, "course")).flatMap((p) => (p.course ? [p.course.id] : []));
          const courses = ITEM_ID_PATTERN.test(productId) ? await readCourses(courseIds) : new Map();
          const isLesson = [...courses.values()].some((course) => findLesson(course, productId) !== null);
          if (!isLesson) throw new Error("unknown");
        }

        // Nothing new is stored while a renewal is unpaid (232 [CA1] unit 4).
        { const paused = costPauseCode(store); if (paused) throw new Error(paused); }
        if (!(await reserveStoreUpload(store, MAX_FILE_BYTES, "blob"))) throw new Error("upload_budget_unavailable");
        const folder = await storeFolder(ref);
        if (!ownsPath(pathname, folder, productId)) throw new Error("invalid");

        /*
          The storage brake (lib/storage-quota.ts). Checked here, before a
          single byte is signed for, because this is the one moment where
          saying no costs nobody anything: no buyer is waiting, nothing
          already sold is touched, and nothing that exists stops working.
          It sits far above any real store and is not a plan limit.
        */
        // By where the store stands with its plan (lib/plan-standing.ts).
        // The browser does not supply a trusted file size. Limit both parts
        // of the signed authorization to the confirmed room that remains.
        const standing = standingOf(store);
        const held = await storageUsed(folder, storageBrakeFor(standing, store.tier));
        if (held.available === false) throw new Error("files_unavailable");
        const maximumSizeInBytes = maximumUploadBytes(held, MAX_FILE_BYTES);
        if (maximumSizeInBytes <= 0) throw new Error(storageRefusal(standing));

        // The one moment this store's folder and its owner are both in hand.
        // Kept so the allowance notice can reach them without anybody
        // looking anything up (lib/delivery.ts).
        await rememberFolderOwner(folder, ref);

        return {
          // Scoped to this one path, so the token cannot sign anything else.
          // There is nothing to cache: a token that fits one upload fits no
          // other one.
          token: await issueSignedToken({
            pathname,
            operations: ["put"],
            allowedContentTypes: ALLOWED_CONTENT_TYPES,
            maximumSizeInBytes,
            validUntil: Date.now() + UPLOAD_WINDOW_MS,
          }),
          urlOptions: {
            allowedContentTypes: ALLOWED_CONTENT_TYPES,
            maximumSizeInBytes,
            validUntil: Date.now() + UPLOAD_WINDOW_MS,
            // Two files of the same name never fight, and an upload can never
            // quietly replace something that is already selling.
            addRandomSuffix: true,
            allowOverwrite: false,
          },
        };
      },
    });

    return Response.json(answer);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "server_error";
    const known = ["signed_out", "none", "unknown", "invalid", "forbidden", "gone", "storage_full", "storage_trial", "storage_setup", "files_unavailable", "upload_budget_unavailable", "renewal_unpaid", "plan_disputed"].includes(reason);
    if (!known) console.error("signing an upload failed", error);
    return Response.json(
      { ok: false, error: known ? reason : "server_error" },
      { status: reason === "signed_out" ? 401 : reason === "forbidden" || reason === "gone" ? 403 : reason === "files_unavailable" || reason === "upload_budget_unavailable" ? 503 : reason === "renewal_unpaid" || reason === "plan_disputed" ? 409 : known ? 400 : 500 },
    );
  }
}
