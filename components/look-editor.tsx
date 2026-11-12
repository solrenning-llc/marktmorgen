"use client";

import { useMemo, useRef, useState } from "react";
import { formatMoney } from "@/lib/money";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons";
import { toast } from "@/components/toast";
import {
  ACCENTS,
  BACKDROPS,
  type BackdropId,
  backdropStyle,
  FONTS,
  THEMES,
  type FontId,
  fontStyle,
  type StoreLook,
  type ThemeId,
  lookColours,
  lookStyle,
  normaliseHex,
} from "@/lib/store-look";
import { MAX_PHOTO_BYTES, PHOTO_SIDE, photoUrl } from "@/lib/photo-limits";
import { emailColourNotice } from "@/lib/email-theme";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  theme: "Pick one of the themes before saving.",
  accent: "That color could not be read. Pick one of the swatches or your own.",
  none: "This account has no store yet.",
  signed_out: "Your session ended. Log in again.",
  unavailable: "Stores are not switched on yet, so nothing was saved.",
  too_big: "That picture is still too big after shrinking. Try another one.",
  type: "That picture could not be read. Try a JPEG, PNG or WebP.",
  empty: "That picture could not be read. Try a JPEG, PNG or WebP.",
  unreadable: "That picture could not be read. Try a JPEG, PNG or WebP.",
  server_error: "Something went wrong on our side. Try again in a moment.",
};

type Status =
  | { kind: "idle" }
  | { kind: "working"; what: "look" | "photo" }
  | { kind: "error"; message: string };

/** Crops the middle square of a picture and shrinks it to a small file. */
async function shrink(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    const w = image.naturalWidth;
    const h = image.naturalHeight;
    const side = Math.min(w, h);
    if (!side) throw new Error("unreadable");

    const canvas = document.createElement("canvas");
    canvas.width = PHOTO_SIDE;
    canvas.height = PHOTO_SIDE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("unreadable");
    // A transparent picture saved as JPEG would turn black behind the face.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, PHOTO_SIDE, PHOTO_SIDE);
    context.imageSmoothingQuality = "high";
    context.drawImage(image, (w - side) / 2, (h - side) / 2, side, side, 0, 0, PHOTO_SIDE, PHOTO_SIDE);

    const encode = (type: string, quality: number) =>
      new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

    let blob = await encode("image/webp", 0.86);
    // Older Safari cannot write WebP and quietly hands back a PNG instead.
    if (!blob || blob.type !== "image/webp") blob = await encode("image/jpeg", 0.86);
    let quality = 0.86;
    while (blob && blob.size > MAX_PHOTO_BYTES && quality > 0.4) {
      quality -= 0.12;
      blob = await encode("image/jpeg", quality);
    }
    if (!blob) throw new Error("unreadable");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("unreadable"));
    reader.readAsDataURL(blob);
  });
}

/** The theme, the colour and the photo of the public page, with a live preview. */
export function LookEditor({
  look,
  photoId,
  name,
  handle,
  currency = "usd",
  canHideBadge = false,
  sample = null,
  linkTitle = null,
}: {
  look: StoreLook;
  photoId: string | null;
  name: string;
  handle: string;
  /** The store's currency, so the sample price reads like the real ones. */
  currency?: string;
  /** Whether this store's plan lets it take our name off the page. */
  canHideBadge?: boolean;
  /**
   * The store's own first product and first link, so the preview shows the
   * creator's page rather than a stand-in. Null when there is none yet, and
   * then the preview says it is an example.
   */
  sample?: { title: string; priceCents: number; free: boolean } | null;
  linkTitle?: string | null;
}) {
  const router = useRouter();
  const [theme, setTheme] = useState<ThemeId>(look.theme);
  const [accent, setAccent] = useState(look.accent);
  const [badge, setBadge] = useState(look.badge);
  const [sold, setSold] = useState(look.sold);
  const [font, setFont] = useState<FontId>(look.font);
  const [backdrop, setBackdrop] = useState<BackdropId>(look.backdrop);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const fileRef = useRef<HTMLInputElement>(null);

  const preset = ACCENTS.some((option) => option.hex === accent);
  const changed = theme !== look.theme || accent !== look.accent || badge !== look.badge || sold !== look.sold || font !== look.font || backdrop !== look.backdrop;
  const colours = useMemo(() => lookColours({ theme, accent }), [theme, accent]);
  // Said out loud when the page will not paint exactly what was picked, so the
  // creator is never left wondering why their button is darker than their logo.
  const adjusted = colours.accent !== accent;
  // Emails need 7:1 for every word, links included (369 [SU2]); when that moves the color, the creator is told which.
  const emailNotice = useMemo(() => emailColourNotice({ theme, accent, font }), [theme, accent, font]);

  async function post(path: string, body: unknown): Promise<{ ok?: boolean; error?: string }> {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  }

  async function saveLook() {
    if (status.kind === "working") return;
    setStatus({ kind: "working", what: "look" });
    try {
      const expected = { theme, accent: normaliseHex(accent), badge, sold, font, backdrop };
      const response = await fetch("/api/store/look", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(expected),
      });
      const raw: unknown = await response.json().catch(() => null);
      const data = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
      const snapshot = data?.look && typeof data.look === "object" && !Array.isArray(data.look) ? data.look as Record<string, unknown> : null;
      if (response.ok && data?.ok === true && !data.error && snapshot && Object.entries(expected).every(([key, value]) => snapshot[key] === value)) {
        setStatus({ kind: "idle" });
        toast("Look saved.");
        router.refresh();
        return;
      }
      const problem = data?.ok === true ? undefined : data?.error;
      setStatus({ kind: "error", message: typeof problem === "string" && Object.prototype.hasOwnProperty.call(MESSAGES, problem) ? MESSAGES[problem] : "We could not confirm this look. Reload this page to check before trying again." });
    } catch {
      setStatus({ kind: "error", message: "We could not confirm this look. Reload this page to check before trying again." });
    }
  }

  async function choosePhoto(file: File | undefined) {
    if (!file || status.kind === "working") return;
    setStatus({ kind: "working", what: "photo" });
    try {
      let data64: string;
      try {
        data64 = await toBase64(await shrink(file));
      } catch {
        setStatus({ kind: "error", message: MESSAGES.unreadable });
        return;
      }
      const data = await post("/api/store/photo", { photo: data64 });
      if (data.ok) {
        setStatus({ kind: "idle" });
        toast("Photo updated.");
        router.refresh();
        return;
      }
      setStatus({ kind: "error", message: MESSAGES[data.error ?? ""] ?? MESSAGES.server_error });
    } catch {
      setStatus({ kind: "error", message: MESSAGES.server_error });
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function removePhoto() {
    if (status.kind === "working") return;
    setStatus({ kind: "working", what: "photo" });
    try {
      const data = await post("/api/store/photo", { remove: true });
      if (data.ok) {
        setStatus({ kind: "idle" });
        toast("Photo removed.");
        router.refresh();
        return;
      }
      setStatus({ kind: "error", message: MESSAGES[data.error ?? ""] ?? MESSAGES.server_error });
    } catch {
      setStatus({ kind: "error", message: MESSAGES.server_error });
    }
  }

  const working = status.kind === "working";

  return (
    <section data-look-editor aria-busy={working} className="card mt-8 p-6 sm:p-8" aria-labelledby="look-title">
      <h2 id="look-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
        How your page looks
      </h2>
      <p className="mt-2 text-ink-soft">
        Your photo, a theme, your color and your letters. Every color is checked so that the words on your page stay easy to read.
      </p>

      <div className="mt-6 grid gap-8 md:grid-cols-[minmax(0,1fr)_15rem]">
        <div className="min-w-0 space-y-7">
          {/* Photo */}
          <div>
            <p className="field-label">Your photo</p>
            <div className="mt-3 flex flex-wrap items-center gap-4">
              {photoId ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={photoUrl(photoId)}
                  alt="Your photo as it shows on your page"
                  width={64}
                  height={64}
                  className="h-16 w-16 rounded-full object-cover ring-1 ring-line"
                />
              ) : (
                <span
                  aria-hidden="true"
                  className="grid h-16 w-16 place-items-center rounded-full bg-sand text-2xl font-semibold text-ink-mute"
                >
                  {name.slice(0, 1).toUpperCase()}
                </span>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <label className={`btn btn-secondary btn-sm cursor-pointer ${working ? "pointer-events-none opacity-60" : ""}`}>
                  <Icon name="camera" size={16} />
                  {photoId ? "Choose another photo" : "Choose a photo"}
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    disabled={working}
                    onChange={(event) => choosePhoto(event.target.files?.[0])}
                  />
                </label>
                {photoId ? (
                  <button
                    type="button"
                    onClick={removePhoto}
                    disabled={working}
                    className="btn btn-ghost btn-sm"
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            </div>
            <p className="field-hint mt-2">
              The middle square is used and shrunk to {PHOTO_SIDE} pixels before it leaves your device. It is saved as soon as you pick it.
            </p>
          </div>

          {/* Theme */}
          <fieldset disabled={working}>
            <legend className="field-label">Theme</legend>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {THEMES.map((option) => {
                const c = lookColours({ theme: option.id, accent });
                return (
                  <label
                    key={option.id}
                    className="flex cursor-pointer items-start gap-3 rounded-[var(--r-sm)] border border-line-strong bg-white p-3 transition hover:border-violet-brand has-[:checked]:border-violet-brand has-[:checked]:bg-lilac has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-violet-brand"
                  >
                    <input
                      type="radio"
                      name="theme"
                      value={option.id}
                      checked={theme === option.id}
                      onChange={() => setTheme(option.id)}
                      className="sr-only"
                    />
                    <span
                      aria-hidden="true"
                      className="mt-0.5 grid h-12 w-10 shrink-0 grid-rows-[1fr_auto] overflow-hidden rounded-[8px] ring-1 ring-line"
                      style={{ background: option.id === "bold" ? `linear-gradient(135deg, ${c.accent}, ${c.accent2})` : c.bg }}
                    >
                      <span />
                      <span className="m-1 h-2.5 rounded-[3px]" style={{ background: option.id === "bold" ? c.card : c.accent }} />
                    </span>
                    <span className="min-w-0">
                      <span className="block font-semibold text-ink">{option.label}</span>
                      <span className="mt-0.5 block text-sm text-ink-soft">{option.description}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {/* Colour */}
          <fieldset disabled={working}>
            <legend className="field-label">Your color</legend>
            <div className="mt-3 flex flex-wrap items-center gap-2.5">
              {ACCENTS.map((option) => (
                <label
                  key={option.hex}
                  title={option.label}
                  className="relative grid h-11 w-11 cursor-pointer place-items-center rounded-full ring-offset-2 transition has-[:checked]:ring-2 has-[:checked]:ring-ink has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-violet-brand"
                  style={{ background: option.hex }}
                >
                  <input
                    type="radio"
                    name="accent"
                    value={option.hex}
                    checked={accent === option.hex}
                    onChange={() => setAccent(option.hex)}
                    className="sr-only"
                  />
                  <span className="sr-only">{option.label}</span>
                  {accent === option.hex ? <Icon name="check" size={18} className="text-white" /> : null}
                </label>
              ))}
              <label
                className={`flex h-11 cursor-pointer items-center gap-2 rounded-full border px-3 text-sm font-semibold transition has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-violet-brand ${
                  preset ? "border-line-strong text-ink-soft" : "border-ink text-ink"
                }`}
              >
                <span aria-hidden="true" className="h-5 w-5 rounded-full ring-1 ring-line" style={{ background: accent }} />
                Your own
                <input
                  type="color"
                  value={accent}
                  onChange={(event) => {
                    const hex = normaliseHex(event.target.value);
                    if (hex) setAccent(hex);
                  }}
                  className="sr-only"
                />
              </label>
            </div>
            <p className="field-hint mt-2">
              {`${adjusted ? "Your color is darkened or lightened a little on buttons so that the words on them can be read. " : ""}${
                sample
                  ? "The preview shows your page's theme and color with your first product and link."
                  : "The preview shows your page's theme and color, with an example product until you add one."
              }`}
            </p>
            {emailNotice ? <p className="field-hint mt-2">{emailNotice}</p> : null}
          </fieldset>

          {/* Letters */}
          <fieldset disabled={working}>
            <legend className="field-label">Letters</legend>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {FONTS.map((option) => (
                <label
                  key={option.id}
                  className="flex cursor-pointer items-start gap-3 rounded-[var(--r-sm)] border border-line-strong bg-white p-3 transition hover:border-violet-brand has-[:checked]:border-violet-brand has-[:checked]:bg-lilac has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-violet-brand"
                >
                  <input type="radio" name="font" value={option.id} checked={font === option.id} onChange={() => setFont(option.id)} className="sr-only" />
                  {/* The pairing drawn in its own letters, as a page would show it. */}
                  <span aria-hidden="true" className="st-page mt-0.5 grid h-12 w-12 shrink-0 place-items-center rounded-[8px] bg-paper ring-1 ring-line" style={fontStyle(option.id) as React.CSSProperties}>
                    <span className="font-display text-2xl font-semibold leading-none text-ink">Aa</span>
                  </span>
                  <span className="min-w-0">
                    <span className="block font-semibold text-ink">{option.label}</span>
                    <span className="mt-0.5 block text-sm text-ink-soft">{option.description}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="field-hint mt-2">Every page of your store uses them: the store page, each product&apos;s page, the page after paying, their purchases and your community. Only the letters you pick are downloaded by a visitor.</p>
          </fieldset>

          {/* Backdrop */}
          <fieldset disabled={working}>
            <legend className="field-label">Background</legend>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {BACKDROPS.map((option) => (
                <label
                  key={option.id}
                  className="flex cursor-pointer items-start gap-3 rounded-[var(--r-sm)] border border-line-strong bg-white p-3 transition hover:border-violet-brand has-[:checked]:border-violet-brand has-[:checked]:bg-lilac has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-violet-brand"
                >
                  <input type="radio" name="backdrop" value={option.id} checked={backdrop === option.id} onChange={() => setBackdrop(option.id)} className="sr-only" />
                  {/* The backdrop drawn in the page's own colors, as the page would show it. */}
                  <span
                    aria-hidden="true"
                    className={`st-page st-theme-${theme} mt-0.5 h-12 w-12 shrink-0 rounded-[8px] ring-1 ring-line`}
                    style={{ ...(lookStyle({ theme, accent }) as React.CSSProperties), ...(backdropStyle(option.id) as React.CSSProperties) }}
                  />
                  <span className="min-w-0">
                    <span className="block font-semibold text-ink">{option.label}</span>
                    <span className="mt-0.5 block text-sm text-ink-soft">{option.description}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="field-hint mt-2">Drawn by the page in your colors: nothing to download, and your words keep their contrast. The Aurora moves only for visitors whose device has not asked for less motion.</p>
          </fieldset>

          {/*
            Our name at the foot of their page.

            Shown to everyone, not only to the stores that can turn it off.
            A control a creator cannot find is a feature they do not know
            they are paying for, and one that silently is not there on the
            cheaper plan is worse than one that says so. On Creator it is
            disabled and says what it costs; on Pro it is a switch.
          */}
          <fieldset disabled={working} className="mt-2">
            <legend className="field-label">Our name on your page</legend>
            <label className="mt-2 flex items-start gap-3">
              <input
                type="checkbox"
                checked={!badge}
                disabled={!canHideBadge}
                onChange={(event) => setBadge(!event.target.checked)}
                className="mt-1 h-4 w-4 shrink-0 accent-[var(--violet)] disabled:opacity-40"
              />
              <span>
                <span className="block text-[0.9375rem] font-medium text-ink">
                  Take &ldquo;Made with Marktmorgen&rdquo; off the foot of my page
                </span>
                <span className="field-hint mt-1 block">
                  {canHideBadge
                    ? "Your page carries your name and nothing of ours. Leaving Pro puts it back, and your choice here is kept for if you return."
                    : "On Pro. Every page keeps the line until then — it is how a store brings us the next creator, which is part of what the lower price is."}
                </span>
              </span>
            </label>
          </fieldset>

          {/*
            How many times each product was bought, on its card and its page
            (lib/sold-count.ts): read from the creator's own Stripe account,
            never typed, and only said from ten sales up.
          */}
          <fieldset disabled={working} className="mt-2">
            <legend className="field-label">How many times each product was bought</legend>
            <label className="mt-2 flex items-start gap-3">
              <input
                type="checkbox"
                checked={sold}
                onChange={(event) => setSold(event.target.checked)}
                className="mt-1 h-4 w-4 shrink-0 accent-[var(--violet)]"
              />
              <span>
                <span className="block text-[0.9375rem] font-medium text-ink">
                  Show &ldquo;Bought 120 times&rdquo; on products that have sold at least ten times
                </span>
                <span className="field-hint mt-1 block">
                  Counted from the sales on your own Stripe account, read again every few hours. Nothing can be typed in or rounded up, and a product with fewer than ten sales shows nothing. Each product&apos;s page also shows what its buyers also bought, &ldquo;5 buyers bought both&rdquo;, from three buyers of both up.
                </span>
              </span>
            </label>
          </fieldset>

          {status.kind === "error" ? (
            <p className="notice notice-error" role="alert">{status.message}</p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={saveLook}
              disabled={working || !changed}
              className="btn btn-primary"
            >
              {working && status.what === "look" ? "Saving…" : "Save the look"}
            </button>
            {changed ? (
              <button
                type="button"
                onClick={() => {
                  setTheme(look.theme);
                  setAccent(look.accent);
                  setBadge(look.badge);
                  setSold(look.sold);
                  setFont(look.font);
                  setBackdrop(look.backdrop);
                  setStatus({ kind: "idle" });
                }}
                disabled={working}
                className="btn btn-ghost"
              >
                Undo changes
              </button>
            ) : null}
            {working && status.what === "photo" ? (
              <span className="flex items-center gap-2 text-sm text-ink-soft" role="status">
                <span className="spinner" aria-hidden="true" /> Saving your photo…
              </span>
            ) : null}
          </div>
        </div>

        {/* Live preview, not interactive: a picture of the page, not the page. */}
        <div aria-hidden="true" className="min-w-0">
          <p className="field-label">Preview</p>
          <div
            className={`st-page st-theme-${theme} pointer-events-none mt-3 overflow-hidden rounded-[1.25rem] ring-1 ring-line`}
            style={lookStyle({ theme, accent, font, backdrop }) as React.CSSProperties}
          >
            <div className={theme === "bold" ? "st-band px-4 pb-6 pt-6 text-center" : "px-4 pb-1 pt-6 text-center"}>
              {photoId ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photoUrl(photoId)} alt="" width={56} height={56} className="st-avatar" style={{ width: 56, height: 56 }} />
              ) : (
                <span className="st-avatar st-avatar-initial" style={{ width: 56, height: 56, fontSize: "1.5rem" }}>
                  {name.slice(0, 1).toUpperCase()}
                </span>
              )}
              <span className="font-display mt-3 block text-base font-semibold">{name}</span>
              <span className="st-muted block text-xs font-semibold">@{handle}</span>
            </div>
            <div className="space-y-2.5 px-3 pb-4 pt-4">
              <div className="st-card p-3">
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-semibold">{sample ? sample.title : "Your product"}</span>
                  <span className="st-price text-xs">{sample?.free ? "Free" : formatMoney(sample ? sample.priceCents : 2700, currency)}</span>
                </div>
                <span className="btn st-btn btn-block btn-sm mt-3 text-sm">
                  {sample?.free ? "Get it free" : `Buy for ${formatMoney(sample ? sample.priceCents : 2700, currency)}`}
                </span>
              </div>
              {linkTitle || !sample ? (
                <div className="st-card truncate px-3 py-2.5 text-center text-sm font-semibold">{linkTitle ?? "A link of yours"}</div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
