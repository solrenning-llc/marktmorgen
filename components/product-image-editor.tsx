"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { uploadPresigned } from "@vercel/blob/client";
import { toast } from "@/components/toast";
import type { Product } from "@/lib/store";
import {
  DISPLAY_STYLES,
  type DisplayStyle,
  IMAGE_ACCEPT,
  MAX_ALT_LENGTH,
  MAX_SOURCE_BYTES,
  SMALL_LONG_SIDE,
  imagePath,
  imageUrl,
} from "@/lib/product-image";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { shrink } from "@/components/shrink-image";
import { CoverMaker, type CoverLook } from "@/components/cover-maker";
import { coverLabel } from "@/lib/cover-maker";
import type { LanguageCode } from "@/lib/store-language";

export { shrink };

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  unreadable: "That picture could not be opened. Try a JPEG, PNG or WebP.",
  source: "That picture is over 30 MB. Pick a smaller one, or a screenshot of it.",
  too_big: "That picture is still over 1 MB after shrinking. Try a simpler one.",
  type: "That picture could not be read. Try a JPEG, PNG or WebP.",
  unknown: "That product is no longer on your store.",
  // A name that is neither a new upload nor this one's own picture (app/api/store/image, app/api/store/link-image): used
  // elsewhere, or an upload a failed try already took. Said neutrally, so it is true either way.
  in_use: "That picture could not be used here. Choose it from your device again.",
  none: "This account has no store yet.",
  signed_out: "Your session ended. Log in again.",
  store_full: "Your store has reached the most it can hold. Remove something, or shorten a long list of choices, first.",
  unavailable: "Stores are not switched on yet, so nothing was saved.",
  server_error: "Something went wrong on our side. Try again in a moment.",
};

function freshId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** A drawing of each card style, so the choice is seen rather than read. */
function StyleSketch({ style }: { style: DisplayStyle }) {
  const bar = "rounded-full bg-ink/15";
  if (style === "preview") {
    return (
      <span aria-hidden="true" className="block h-16 w-full overflow-hidden rounded-lg border border-line bg-white">
        <span className="block h-8 bg-gradient-to-br from-violet-brand/60 to-sky-brand/60" />
        <span className="block space-y-1 p-1.5">
          <span className={`block h-1.5 w-3/4 ${bar}`} />
          <span className="block h-2.5 w-full rounded bg-violet-brand/70" />
        </span>
      </span>
    );
  }
  if (style === "callout") {
    return (
      <span aria-hidden="true" className="block h-16 w-full rounded-lg border border-line bg-white p-1.5">
        <span className="flex gap-1.5">
          <span className="block h-7 w-7 shrink-0 rounded bg-gradient-to-br from-violet-brand/60 to-sky-brand/60" />
          <span className="block flex-1 space-y-1 pt-0.5">
            <span className={`block h-1.5 w-full ${bar}`} />
            <span className={`block h-1.5 w-2/3 ${bar}`} />
          </span>
        </span>
        <span className="mt-1.5 block h-2.5 w-full rounded bg-violet-brand/70" />
      </span>
    );
  }
  return (
    <span aria-hidden="true" className="block h-16 w-full rounded-lg border border-line bg-white p-1.5">
      <span className="flex items-center gap-1.5">
        <span className="block h-3.5 w-3.5 shrink-0 rounded bg-gradient-to-br from-violet-brand/60 to-sky-brand/60" />
        <span className={`block h-1.5 flex-1 ${bar}`} />
      </span>
      <span className="mt-1.5 block h-2.5 w-full rounded bg-violet-brand/70" />
      <span className="mt-1 block h-2 w-full" />
    </span>
  );
}

/** A product's picture, the words that describe it, and its card style. */
export function ProductImageEditor({
  product,
  folder,
  cover = null,
}: {
  product: Product;
  folder: string;
  /** The store's color, letters, name and language, for a cover made here (components/cover-maker.tsx); null hides the maker. */
  cover?: (CoverLook & { language: LanguageCode }) | null;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const image = product.image;
  const [alt, setAlt] = useState(image?.alt ?? "");
  const [busy, setBusy] = useState<"upload" | "remove" | "alt" | "display" | null>(null);
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [making, setMaking] = useState(false);

  async function post(payload: Record<string, unknown>): Promise<string | null> {
    try {
      const response = await fetch("/api/store/image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: product.id, ...payload }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      return data.ok ? null : (MESSAGES[data.error ?? ""] ?? MESSAGES.server_error);
    } catch {
      return MESSAGES.server_error;
    }
  }

  /** Sends a picture: one the creator picked, or a cover made here (with the words it shows as its description). */
  async function choose(file: File | undefined, describe: string | null = null) {
    if (!file || busy) return;
    setError(null);
    if (file.size > MAX_SOURCE_BYTES) {
      setError(MESSAGES.source);
      return;
    }
    setBusy("upload");
    setPercent(0);
    try {
      let shrunk: Awaited<ReturnType<typeof shrink>>;
      try {
        shrunk = await shrink(file);
      } catch (thrown) {
        setError(thrown instanceof Error && thrown.message === "too_big" ? MESSAGES.too_big : MESSAGES.unreadable);
        return;
      }
      const path = imagePath(folder, freshId(), shrunk.blob.type);
      await uploadPresigned(path, shrunk.blob, {
        access: "private",
        handleUploadUrl: "/api/store/image/upload",
        clientPayload: JSON.stringify({ productId: product.id }),
        contentType: shrunk.blob.type,
        onUploadProgress: (progress) => setPercent(progress.percentage),
      });
      // A second, smaller copy for phones, which the page lets the browser
      // choose (lib/product-image.ts, SMALL_LONG_SIDE). Only for a picture
      // bigger than that; and a copy that cannot be made or sent is simply
      // left out — the picture is attached without it, as it always was.
      let small: { path: string; width: number } | null = null;
      if (Math.max(shrunk.width, shrunk.height) > SMALL_LONG_SIDE) {
        try {
          const copy = await shrink(file, SMALL_LONG_SIDE);
          const smallPath = imagePath(folder, freshId(), copy.blob.type);
          await uploadPresigned(smallPath, copy.blob, {
            access: "private",
            handleUploadUrl: "/api/store/image/upload",
            clientPayload: JSON.stringify({ productId: product.id }),
            contentType: copy.blob.type,
          });
          small = { path: smallPath, width: copy.width };
        } catch {
          small = null;
        }
      }
      const described = describe ?? alt;
      // The picture's color, painted under it while it loads (Encanto 5b); none for one with transparency.
      const problem = await post({ action: "attach", path, width: shrunk.width, height: shrunk.height, alt: described, ...(small ? { small } : {}), ...(shrunk.tone ? { tone: shrunk.tone } : {}) });
      if (problem) {
        setError(problem);
        return;
      }
      if (describe !== null) {
        setAlt(describe);
        setMaking(false);
      }
      toast(describe !== null ? "Cover added." : image ? "Picture replaced." : "Picture added.");
      router.refresh();
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setBusy(null);
      setPercent(0);
      if (input.current) input.current.value = "";
    }
  }

  async function run(kind: "remove" | "alt" | "display", payload: Record<string, unknown>, done: string) {
    if (busy) return;
    setBusy(kind);
    setError(null);
    const problem = await post({ action: kind, ...payload });
    setBusy(null);
    if (problem) {
      setError(problem);
      return;
    }
    toast(done);
    router.refresh();
  }

  const altChanged = image !== null && alt.trim() !== image.alt;
  const altId = `alt-${product.id}`;

  return (
    <div className="mt-3 rounded-2xl bg-white p-3">
      <input
        ref={input}
        type="file"
        accept={IMAGE_ACCEPT}
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => choose(event.target.files?.[0])}
      />
      <div className="flex items-start gap-3 sm:gap-4">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl(image)}
            alt=""
            width={image.width}
            height={image.height}
            className="h-16 w-16 shrink-0 rounded-xl object-cover ring-1 ring-line sm:h-20 sm:w-20"
          />
        ) : (
          <span
            aria-hidden="true"
            className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl border-2 border-dashed border-ink/15 text-ink-soft sm:h-20 sm:w-20"
          >
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.6">
              <rect x="3" y="4" width="18" height="16" rx="3" />
              <circle cx="9" cy="10" r="1.8" />
              <path d="m4 18 5-5 4 4 3-3 4 4" strokeLinejoin="round" />
            </svg>
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-ink">{image ? "Picture" : "No picture yet"}</p>
          <p className="mt-1 text-sm text-ink-soft">
            {image
              ? `${image.width} × ${image.height}, shown on your page and on this product's own page.`
              : "A cover, a mock-up or a photo. It is shrunk in your browser before it is sent, so a large one is fine, up to 30 MB."}
          </p>
        </div>
      </div>
      {busy === "upload" ? (
        <div className="mt-2">
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-sand"
            role="progressbar"
            aria-label="Sending the picture"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full rounded-full bg-gradient-to-r from-violet-brand to-sky-brand transition-all"
              style={{ width: `${Math.max(percent, 4)}%` }}
            />
          </div>
          <p className="mt-1 text-sm text-ink-soft">Shrinking and sending…</p>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" onClick={() => input.current?.click()} className="btn btn-secondary btn-sm">
            {image ? "Replace the picture" : "Add a picture"}
          </button>
          {cover && !making ? (
            <button type="button" onClick={() => setMaking(true)} className="btn btn-secondary btn-sm">
              Make a cover
            </button>
          ) : null}
          {image ? (
            <button
              type="button"
              aria-busy={busy === "remove"}
              disabled={busy !== null}
              onClick={() => run("remove", {}, "Picture removed.")}
              className="btn btn-ghost btn-sm"
            >
              {busy === "remove" ? "Removing…" : "Remove it"}
            </button>
          ) : null}
        </div>
      )}

      {cover && making ? (
        <CoverMaker
          look={cover}
          defaults={{ title: product.title, label: coverLabel(product, cover.language), sub: product.summary }}
          busy={busy === "upload"}
          onUse={(file, words) => choose(file, words)}
          onClose={() => setMaking(false)}
        />
      ) : null}

      {image ? (
        <>
          <form
            className="mt-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (altChanged) run("alt", { alt: alt.trim() }, "Picture description saved.");
            }}
          >
            <label htmlFor={altId} className="field-label">
              What the picture shows, for people who cannot see it
            </label>
            <div className="mt-1 flex flex-wrap gap-2">
              <input
                id={altId}
                type="text"
                maxLength={MAX_ALT_LENGTH}
                value={alt}
                onChange={(event) => setAlt(event.target.value)}
                placeholder="The cover: a bowl of ramen on a blue table"
                className="field min-w-[12rem] flex-1"
              />
              <button type="submit" aria-busy={busy === "alt"} disabled={!altChanged || busy !== null} className="btn btn-secondary btn-sm self-center">
                {busy === "alt" ? "Saving…" : "Save"}
              </button>
            </div>
            <p className="mt-1 text-xs text-ink-soft">
              Read aloud by screen readers. Leave it empty if the picture only decorates the title.
            </p>
          </form>

          <fieldset className="mt-4">
            <legend className="field-label">How it looks on your page</legend>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {DISPLAY_STYLES.map((style) => {
                const chosen = product.display === style.id;
                return (
                  <label
                    key={style.id}
                    className={`relative flex min-h-[44px] cursor-pointer flex-col gap-2 rounded-xl border-2 p-2 transition focus-within:ring-2 focus-within:ring-violet-brand ${
                      chosen ? "border-violet-brand bg-violet-brand/5" : "border-line hover:border-violet-brand/50"
                    }`}
                  >
                    <input
                      type="radio"
                      name={`display-${product.id}`}
                      value={style.id}
                      checked={chosen}
                      disabled={busy !== null}
                      onChange={() => run("display", { display: style.id }, `Card style set to ${style.label}.`)}
                      className="sr-only"
                    />
                    <StyleSketch style={style.id} />
                    <span className="text-sm font-bold text-ink">{style.label}</span>
                  </label>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-ink-soft">
              {DISPLAY_STYLES.find((style) => style.id === product.display)?.description}
            </p>
          </fieldset>
        </>
      ) : null}

      {error ? (
        <p className="notice notice-error mt-3" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
