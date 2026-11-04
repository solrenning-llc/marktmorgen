"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { uploadPresigned } from "@vercel/blob/client";
import { toast } from "@/components/toast";
import { shrink } from "@/components/product-image-editor";
import { Icon } from "@/components/icons";
import { IMAGE_ACCEPT, MAX_SOURCE_BYTES, imagePath, imageUrl } from "@/lib/product-image";
import { LINK_IMAGE_SIDE, type StoreLink } from "@/lib/store-link";
import { linkIcon } from "@/lib/store-socials";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  unreadable: "That picture could not be opened. Try a JPEG, PNG or WebP.",
  source: "That picture is over 30 MB. Pick a smaller one, or a screenshot of it.",
  too_big: "That picture is still over 1 MB after shrinking. Try a simpler one.",
  type: "That picture could not be read. Try a JPEG, PNG or WebP.",
  unknown: "That link is no longer on your page.",
  // A picture or file named that is already used by something else in the store (app/api/store/image, app/api/store/link-image).
  in_use: "That picture is already used somewhere else in your store, so it can't go here too. Choose it from your device again.",
  none: "This account has no store yet.",
  signed_out: "Your session ended. Log in again.",
  store_full: "Your store is full. Remove something before adding more.",
  unavailable: "Stores are not switched on yet, so nothing was saved.",
  server_error: "Something went wrong on our side. Try again in a moment.",
};

/**
 * A link's own small picture, beside its words on the page in place of the
 * plain icon (lib/store-link.ts, LinkImage): a podcast's cover, a channel's
 * face. Shrunk here, in the browser, to LINK_IMAGE_SIDE before it is sent.
 */
export function LinkPicture({ link, folder }: { link: StoreLink; folder: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function post(payload: Record<string, unknown>): Promise<string | null> {
    try {
      const response = await fetch("/api/store/link-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: link.id, ...payload }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      return data.ok ? null : (MESSAGES[data.error ?? ""] ?? MESSAGES.server_error);
    } catch {
      return MESSAGES.server_error;
    }
  }

  async function choose(file: File | undefined) {
    if (!file || busy) return;
    setError(null);
    if (file.size > MAX_SOURCE_BYTES) {
      setError(MESSAGES.source);
      return;
    }
    setBusy("upload");
    try {
      let shrunk: Awaited<ReturnType<typeof shrink>>;
      try {
        shrunk = await shrink(file, LINK_IMAGE_SIDE);
      } catch (thrown) {
        setError(thrown instanceof Error && thrown.message === "too_big" ? MESSAGES.too_big : MESSAGES.unreadable);
        return;
      }
      const path = imagePath(folder, crypto.randomUUID().replace(/-/g, ""), shrunk.blob.type);
      await uploadPresigned(path, shrunk.blob, {
        access: "private",
        handleUploadUrl: "/api/store/image/upload",
        clientPayload: JSON.stringify({ linkId: link.id }),
        contentType: shrunk.blob.type,
      });
      const problem = await post({ action: "attach", path, width: shrunk.width, height: shrunk.height });
      if (problem) {
        setError(problem);
        return;
      }
      toast(link.image ? "Picture replaced." : "Picture added.");
      router.refresh();
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setBusy(null);
      if (input.current) input.current.value = "";
    }
  }

  async function remove() {
    if (busy) return;
    setBusy("remove");
    setError(null);
    const problem = await post({ action: "remove" });
    setBusy(null);
    if (problem) {
      setError(problem);
      return;
    }
    toast("Picture removed. The icon is back.");
    router.refresh();
  }

  return (
    <div className="mt-3">
      <input
        ref={input}
        type="file"
        accept={IMAGE_ACCEPT}
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        data-link-picture={link.id}
        onChange={(event) => choose(event.target.files?.[0])}
      />
      <div className="flex flex-wrap items-center gap-3">
        {link.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl(link.image)}
            alt=""
            width={link.image.width}
            height={link.image.height}
            className="h-11 w-11 shrink-0 rounded-xl object-cover ring-1 ring-line"
          />
        ) : (
          <span
            aria-hidden="true"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white text-ink-soft ring-1 ring-line"
          >
            <Icon name={linkIcon(link.url)} size={18} />
          </span>
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm font-bold">
          <button
            type="button"
            disabled={busy !== null}
            aria-busy={busy === "upload"}
            onClick={() => input.current?.click()}
            className="text-ink-soft underline underline-offset-4 transition hover:text-violet-deep disabled:opacity-50"
          >
            {busy === "upload" ? "Adding the picture…" : link.image ? "Change the picture" : "Add a picture"}
          </button>
          {link.image ? (
            <button
              type="button"
              disabled={busy !== null}
              aria-busy={busy === "remove"}
              onClick={remove}
              className="text-ink-soft underline underline-offset-4 transition hover:text-danger disabled:opacity-50"
            >
              {busy === "remove" ? "Removing…" : "Use the icon instead"}
            </button>
          ) : (
            <span className="font-normal text-ink-soft">
              A cover or a face, shown small beside the words instead of the icon.
            </span>
          )}
        </div>
      </div>
      {error ? (
        <p role="alert" className="mt-2 rounded-2xl bg-danger-soft px-4 py-3 text-sm font-semibold text-ink">
          {error}
        </p>
      ) : null}
    </div>
  );
}
