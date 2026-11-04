import type { NextRequest } from "next/server";
import { del } from "@/lib/blob";
import {
  addStoreLink,
  editStoreLink,
  moveStoreLink,
  removeStoreLink,
  type LinkResult,
} from "@/lib/store";
import { MAX_LINK_LENGTH, readLink } from "@/lib/product-link";
import { MAX_LINK_TITLE_LENGTH, linkExtras, playsOnPage } from "@/lib/store-link";
import { guardStoreWrite, text } from "@/lib/store-request";
import { StoreFullError } from "@/lib/store";

const ACTIONS = new Set(["add", "edit", "remove", "move"]);

/** How firmly to answer when a change is refused. */
const STATUS: Record<string, number> = {
  too_many: 409,
  unknown: 404,
};

/**
 * Adds, changes, reorders or removes one of the links on the creator's page.
 * An add or an edit may also carry `spotlight`, `from` and `until` (when it
 * shows) and `play` (a video played on the page), read by linkExtras in
 * lib/store-link.ts; an edit sent without them clears them.
 *
 * Deliberately a separate route from products. A link takes no money, reaches
 * no Stripe account and delivers nothing, so it shares none of that code and
 * none of its ways of failing.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "page");
  if (!guarded.ok) return guarded.response;

  const { ref, body } = guarded;
  const action = text(body.action, 10);
  if (!ACTIONS.has(action)) {
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }

  const id = text(body.id, 40);
  const title = text(body.title, MAX_LINK_TITLE_LENGTH);
  // One past the length kept, so a longer link is refused as too long rather than cut and kept broken.
  const raw = text(body.url, MAX_LINK_LENGTH + 1);

  if (action !== "add" && !id) {
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }

  try {
    let result: LinkResult;
    if ((action === "add" || action === "edit") && body.header === true) {
      // A heading over links: a title, no address, perhaps a window to show in.
      const { from, until } = linkExtras(body, false);
      const extras = { header: true, ...(from ? { from } : {}), ...(until ? { until } : {}) };
      result = action === "add" ? await addStoreLink(ref, title, "", extras) : await editStoreLink(ref, id, title, "", extras);
    } else if (action === "add" || action === "edit") {
      // Checked before anything is written, and the creator is told which way
      // it was wrong rather than just that it failed.
      const read = readLink(raw);
      if (!read.ok) {
        return Response.json(
          { ok: false, error: "link", reason: read.reason },
          { status: 400 },
        );
      }
      result =
        action === "add"
          ? await addStoreLink(ref, title, read.url, linkExtras(body, playsOnPage(read.url)))
          : await editStoreLink(ref, id, title, read.url, linkExtras(body, playsOnPage(read.url)));
    } else if (action === "remove") {
      result = await removeStoreLink(ref, id);
    } else {
      const direction = body.direction === "up" ? "up" : "down";
      result = await moveStoreLink(ref, id, direction);
    }

    if (!result.ok) {
      return Response.json(
        { ok: false, error: result.reason, limit: result.limit },
        { status: STATUS[result.reason] ?? 400 },
      );
    }
    // A link taken off, or turned into a heading, lets its picture go, after the write.
    if (result.removed) {
      await del(result.removed.path).catch((error: unknown) => {
        console.error("could not delete a removed link's picture", error);
      });
    }
    return Response.json({ ok: true, links: result.store.links });
  } catch (error) {
    if (error instanceof StoreFullError) {
      return Response.json({ ok: false, error: "store_full" }, { status: 409 });
    }
    console.error("changing a link failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
