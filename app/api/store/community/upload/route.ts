import type { NextRequest } from "next/server";
import { head, issueSignedToken } from "@/lib/blob";
import { BlobNotFoundError } from "@vercel/blob";
import { handleUploadPresigned, type HandleUploadPresignedBody } from "@vercel/blob/client";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { IMAGE_CONTENT_TYPES, MAX_IMAGE_BYTES } from "@/lib/product-image";
import { within } from "@/lib/community";
import { communityViewer } from "@/lib/community-access";
import { openCommunityDoor, takePicturePlace } from "@/lib/community-files";
import { takeBuyerAction } from "@/lib/buyer-actions";
import { picturesLimitFor } from "@/lib/community-picture-rules";
import { ownsCommunityImage } from "@/lib/community-image";
import { fromAnotherSite, limited } from "@/lib/request-guard";

/** How long the member has to start the upload after asking for the door. */
const UPLOAD_WINDOW_MS = 5 * 60 * 1000;

/**
 * Hands a member's browser a one-off door into the file store for one post
 * picture: the same door a creator gets for a product picture
 * (app/api/store/image/upload), for somebody who is in this community and
 * may write in it. The path has to be a fresh name in this community's own
 * folder, one the file store does not have and no other door or post holds,
 * the file a JPEG or a WebP of a megabyte at most, nothing can be written
 * over, and each member may open ten such doors an hour.
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
      getSignedToken: async (pathname, clientPayload) => {
        let handle = "";
        try {
          const parsed = JSON.parse(clientPayload ?? "{}") as { handle?: unknown };
          handle = typeof parsed.handle === "string" ? normaliseHandle(parsed.handle) : "";
        } catch {
          throw new Error("invalid");
        }
        const store = handle ? await storeForHandle(handle) : null;
        if (!store?.community) throw new Error("unknown");
        const viewer = await communityViewer(store, request.cookies);
        if (viewer.state !== "in" || !viewer.canWrite) throw new Error("signed_out");
        if (!ownsCommunityImage(pathname, store.community.id)) throw new Error("invalid");
        if (!viewer.owner && !(await within(store.community.id, viewer.key, "upload"))) throw new Error("slow");
        // A door is one of the store's buyer actions (or the creator's studio
        // requests), and takes one of the pictures its community may keep
        // (lib/community-picture-rules.ts), before it is given.
        if (!(await takeBuyerAction(store, viewer.owner ? "owner" : "buyer"))) throw new Error("resting");
        // A name that is already a file is refused, before a place is taken (the audit of 9 November 2026): it may be
        // a picture in somebody's post, its name printed on the page, and a door noted for it would let this member
        // put it in a post of their own and delete it, or leave it to the sweep. The upload could never write over it
        // anyway (allowOverwrite: false). A name the file store cannot answer for is not opened at all. The same check
        // as the studio's picture door (app/api/store/image/upload): one head of the file store, inside the buyer
        // action just taken (tests/plan-cost-registry.ts, line buyer-actions).
        const there = await head(pathname).then(() => true, (error: unknown) => (error instanceof BlobNotFoundError ? false : null));
        if (there === true) throw new Error("invalid");
        if (there === null) throw new Error("could not check whether a community picture name is free");
        if (!(await takePicturePlace(pathname, picturesLimitFor(store)))) throw new Error("pictures");

        // Only the member given this door may put the picture in a post, and only a door noted for them and listed
        // for the sweep is given (CX-123 rule 24). A name that already has a note (another door still open, or a
        // picture a post took, lib/community-files.ts) opens nothing, and its place goes back; a note that cannot be
        // confirmed throws (lib/community-files.ts openCommunityDoor), and no door is given.
        if (!(await openCommunityDoor(pathname, viewer.key))) throw new Error("invalid");

        const rules = {
          allowedContentTypes: [...IMAGE_CONTENT_TYPES],
          maximumSizeInBytes: MAX_IMAGE_BYTES,
          validUntil: Date.now() + UPLOAD_WINDOW_MS,
        };
        return {
          token: await issueSignedToken({ pathname, operations: ["put"], ...rules }),
          urlOptions: { ...rules, addRandomSuffix: false, allowOverwrite: false },
        };
      },
    });
    return Response.json(answer);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "server_error";
    const known = ["signed_out", "unknown", "invalid", "slow", "resting", "pictures"].includes(reason);
    if (!known) console.error("signing a community picture upload failed", error);
    return Response.json(
      { ok: false, error: known ? reason : "server_error" },
      { status: reason === "signed_out" ? 401 : reason === "slow" ? 429 : reason === "resting" ? 503 : reason === "pictures" ? 409 : known ? 400 : 500 },
    );
  }
}
