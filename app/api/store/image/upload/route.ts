import type { NextRequest } from "next/server";
import { hasProduct } from "@/lib/catalog";
import { head, issueSignedToken } from "@/lib/blob";
import { BlobNotFoundError } from "@vercel/blob";
import { handleUploadPresigned, type HandleUploadPresignedBody } from "@vercel/blob/client";
import { studioAccess } from "@/lib/studio-route";
import { isHeader } from "@/lib/store-link";
import { imageFolder } from "@/lib/store";
import { IMAGE_CONTENT_TYPES, MAX_IMAGE_BYTES, ownsImagePath } from "@/lib/product-image";
import { fromAnotherSite, limited } from "@/lib/request-guard";
import { costPauseCode } from "@/lib/plan-standing";
import { notePictureDoor } from "@/lib/picture-door";
import { handedBack } from "@/lib/upload-hand-back";
import { SESSION_COOKIE, sessionIdShaped } from "@/lib/session-id";

/** How long the creator has to start the upload after asking for the door. */
const UPLOAD_WINDOW_MS = 5 * 60 * 1000;

/**
 * Hands the browser a one-off door into the file store for one product
 * picture.
 *
 * The same shape as the door for paid files (app/api/store/file), made
 * narrower: the path has to be a fresh name in this account's own picture
 * folder, the file has to be a JPEG or a WebP, and it may weigh a megabyte at
 * most. Everything the signature allows is spelled out in it, and nothing
 * can be written over, so the door cannot be used to replace a picture that
 * is already on somebody's page.
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
    // The browser asked this door already and read its answer (lib/upload-refusal.ts askDoor), so a refusal says why;
    // the file store's library now asks for what was issued then, and is given it back unchanged: nothing is checked,
    // counted or signed twice, and it grants nothing the browser does not already hold.
    const issued = handedBack(body);
    // Only to a browser holding a session id's shape: a caller with none has no counted upload to hand back, so it is
    // refused as the signed path refuses it, with nothing read (lib/session-id.ts, as lib/auth.ts emailForSession).
    if (issued && !sessionIdShaped(request.cookies.get(SESSION_COOKIE)?.value)) return Response.json({ ok: false, error: "signed_out" }, { status: 401 });
    if (issued) return Response.json(issued);
    const answer = await handleUploadPresigned({
      body,
      request,
      getSignedToken: async (pathname, clientPayload) => {
        let productId = "";
        let linkId = "";
        let pageId = "";
        try {
          const parsed = JSON.parse(clientPayload ?? "{}") as { productId?: unknown; linkId?: unknown; pageId?: unknown };
          productId = typeof parsed.productId === "string" ? parsed.productId : "";
          linkId = typeof parsed.linkId === "string" ? parsed.linkId : "";
          pageId = typeof parsed.pageId === "string" ? parsed.pageId : "";
        } catch {
          throw new Error("invalid");
        }
        // Who, which store and whether their role may change what the
        // picture is for: "products" for a product's, "page" for a link's
        // (lib/studio-route.ts). The folder below is that store's own.
        // A picture on one of the store's own pages (lib/site-page-rules.ts) is part of the public page too.
        const access = await studioAccess(request, (linkId || pageId) && !productId ? "page" : "products");
        if (!access.ok) throw new Error(access.reason === "no_store" ? "none" : access.reason);
        const { store, ref } = access.access;

        if (pageId && !productId) {
          if (!store.sitePages.some((page) => page.id === pageId)) throw new Error("unknown");
        } else if (linkId && !productId) {
          // A link's picture: a link on this store's page, never a heading.
          const link = store.links.find((each) => each.id === linkId);
          if (!link || isHeader(link)) throw new Error("unknown");
        } else if (!hasProduct(store, productId)) {
          // A picture belongs to a product of this store, never to an option.
          throw new Error("unknown");
        }
        if (!ownsImagePath(pathname, await imageFolder(ref))) throw new Error("invalid");
        // Nothing new is stored while a renewal is unpaid (232 [CA1] unit 4).
        { const paused = costPauseCode(store); if (paused) throw new Error(paused); }

        // A name that is already a file is refused: the upload could never write over it, and noting it would let a
        // failed request later take somebody's picture for a fresh upload (lib/picture-door.ts). Only a name the file
        // store says is not there is written down. A name that cannot be checked or written down is not opened at
        // all: only a noted upload may be put on a product, a link or a page, so it would be stored for nothing.
        const there = await head(pathname).then(() => true, (error: unknown) => (error instanceof BlobNotFoundError ? false : null));
        if (there === true) throw new Error("invalid");
        if (there === null) throw new Error("could not check whether a picture name is free");
        const noted = await notePictureDoor(pathname).catch((error: unknown) => {
          console.error("could not note a picture upload", error);
          return false;
        });
        if (!noted) throw new Error("could not note a picture upload");

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
    const known = ["signed_out", "none", "unknown", "invalid", "forbidden", "gone", "renewal_unpaid", "plan_disputed"].includes(reason);
    if (!known) console.error("signing a picture upload failed", error);
    return Response.json(
      { ok: false, error: known ? reason : "server_error" },
      { status: reason === "signed_out" ? 401 : reason === "forbidden" || reason === "gone" ? 403 : reason === "renewal_unpaid" || reason === "plan_disputed" ? 409 : known ? 400 : 500 },
    );
  }
}
