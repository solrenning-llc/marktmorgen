"use client";

import { pixelSettingsConfirmed } from "@/lib/marketing-settings-response";

import { useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { PIXEL_INFO, PIXEL_KINDS, type PixelField, type Pixels, hasPixels, readPixels } from "@/lib/pixels";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  none: "This account has no store yet.",
  signed_out: "Your session ended. Log in again.",
  unavailable: "Stores are not switched on yet, so nothing was saved.",
  server_error: "Something went wrong on our side. Try again in a moment.",
};

/** X's two event IDs, under the X pixel (613 [WP12]). */
const X_EVENT_FIELDS: { field: "xPurchase" | "xLead"; label: string }[] = [
  { field: "xPurchase", label: "X Purchase event ID" },
  { field: "xLead", label: "X Lead event ID" },
];

const subscribeReady = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

/** The creator's Meta, Google, TikTok, Pinterest and X ids, on their store's pages. */
export function PixelEditor({ pixels, canViewAttribution = false }: { pixels: Pixels; canViewAttribution?: boolean }) {
  const router = useRouter();
  const ready = useSyncExternalStore(subscribeReady, clientReady, serverReady);
  const disclosure = useRef<HTMLDetailsElement>(null);
  const [draft, setDraft] = useState<Record<Exclude<PixelField, "redditMatching">, string>>(() => ({
    meta: pixels.meta ?? "",
    google: pixels.google ?? "",
    tiktok: pixels.tiktok ?? "",
    pinterest: pixels.pinterest ?? "",
    x: pixels.x ?? "",
    xPurchase: pixels.xEvents?.purchase ?? "",
    xLead: pixels.xEvents?.lead ?? "",
    reddit: pixels.reddit ?? "",
  }));
  // The creator's word that Reddit's Automated Advanced Matching is off (613 [WP12] unit 2, lib/pixels.ts).
  const [redditOff, setRedditOff] = useState(pixels.redditMatchingOff === true);
  const [busy, setBusy] = useState(false);
  const [bad, setBad] = useState<PixelField | null>(null);
  const [error, setError] = useState<string | null>(null);
  const on = PIXEL_KINDS.filter((kind) => pixels[kind]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    setError(null);
    const local = readPixels({ ...draft, redditMatchingOff: redditOff });
    if (!local.ok) {
      setBad(local.bad);
      return;
    }
    setBad(null);
    setBusy(true);
    try {
      const response = await fetch("/api/store/pixels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pixels: local.pixels }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: unknown; pixels?: unknown; error?: string; bad?: PixelField };
      if (pixelSettingsConfirmed(response.ok, data, local.pixels)) {
        if (disclosure.current) disclosure.current.open = false;
        toast("Pixels saved.");
        router.refresh();
        return;
      }
      if (data.error === "format" && data.bad && (data.bad === "redditMatching" || X_EVENT_FIELDS.some((f) => f.field === data.bad) || PIXEL_KINDS.some((kind) => kind === data.bad))) setBad(data.bad);
      else setError((typeof data.error === "string" && Object.prototype.hasOwnProperty.call(MESSAGES, data.error) ? MESSAGES[data.error] : undefined) ?? "Your pixel IDs are still here. Saving could not be confirmed. Reload to check the saved IDs before trying again.");
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card mt-8 p-6 sm:p-8" aria-labelledby="pixels-title">
      <h2 id="pixels-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
        Ad pixels
      </h2>
      <p className="mt-2 text-ink-soft">
        Put your Meta, Google, TikTok, Pinterest, X or Reddit pixel on your store, so the ads you run can see who visits, who
        starts to pay and who buys, with the amount. Included in your plan.
      </p>

      <nav aria-label="Pixels and attribution" className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
        <a href="#pixels-title" className="link inline-flex min-h-11 items-center">Pixel IDs</a>
        {canViewAttribution ? <a href="#numbers" className="link inline-flex min-h-11 items-center">Attribution by channel</a> : null}
      </nav>
      <p className="mt-3 text-sm text-ink-soft" data-pixel-consent>Saving an ID does not override consent. Visitors in the configured consent regions, including Brazil, or with an unknown country are asked first. A browser’s Global Privacy Control signal prevents advertising pixels. Attribution is a separate reading of existing payment records; it is not proof that an ad caused a sale.</p>
      <p className="mt-4 text-sm font-semibold text-ink">
        {hasPixels(pixels)
          ? `On: ${on.map((kind) => `${PIXEL_INFO[kind].name} (${pixels[kind]})`).join(", ")}`
          : "No pixel on your store."}
      </p>
      <details ref={disclosure} className="mt-4">
        <summary role="button" aria-disabled={!ready} onClick={(event) => { if (!ready) event.preventDefault(); }} className="btn btn-secondary w-fit cursor-pointer list-none [&::-webkit-details-marker]:hidden">
          {hasPixels(pixels) ? "Change pixels" : "Add a pixel"}
        </summary>
        <form onSubmit={save} className="mt-5" noValidate aria-busy={busy}>
          <fieldset disabled={!ready || busy} className="min-w-0 space-y-4"><legend className="sr-only">Advertising pixel IDs</legend>
          {PIXEL_KINDS.map((kind) => {
            const info = PIXEL_INFO[kind];
            const invalid = bad === kind;
            return (
              <div key={kind} className="block">
                <label htmlFor={`px-${kind}`} className="field-label">{info.label}</label>
                <input
                  id={`px-${kind}`}
                  type="text"
                  inputMode={kind === "meta" || kind === "pinterest" ? "numeric" : "text"}
                  autoComplete="off"
                  spellCheck={false}
                  value={draft[kind]}
                  placeholder={info.example}
                  aria-invalid={invalid}
                  aria-describedby={`px-${kind}-help`}
                  onChange={(e) => setDraft({ ...draft, [kind]: e.target.value })}
                  className="field font-mono"
                />
                <span id={`px-${kind}-help`} className={`mt-1 block text-xs ${invalid ? "font-semibold text-danger" : "text-ink-soft"}`}>
                  {invalid ? `That is not ${kind === "x" ? "an" : "a"} ${info.label}. ${kind === "x" ? "It has only letters and numbers." : `A ${info.label} looks like ${info.example}.`} ${info.where}` : `${info.where} Leave it empty to turn it off.`}
                </span>
                {kind === "x" ? (
                  <fieldset className="mt-3 rounded-[10px] px-4 py-3 ring-1 ring-line">
                    <legend className="px-1 text-sm font-semibold text-ink">X events (optional)</legend>
                    <p className="text-xs text-ink-soft">
                      X counts page views by itself. For purchases and leads, create a Purchase event and a Lead event in X
                      Events Manager and paste each one&apos;s ID here; an event left empty is not sent to X.
                    </p>
                    {X_EVENT_FIELDS.map(({ field, label }) => {
                      const wrong = bad === field;
                      return (
                        <div key={field} className="mt-3">
                          <label htmlFor={`px-${field}`} className="field-label">{label}</label>
                          <input
                            id={`px-${field}`}
                            type="text"
                            autoComplete="off"
                            spellCheck={false}
                            value={draft[field]}
                            aria-invalid={wrong}
                            aria-describedby={`px-${field}-help`}
                            onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
                            className="field font-mono"
                          />
                          <span id={`px-${field}-help`} className={`mt-1 block text-xs ${wrong ? "font-semibold text-danger" : "text-ink-soft"}`}>
                            {wrong
                              ? "That is not an X event ID. Paste the ID from X Events Manager: letters and numbers, or the whole tw-… name X shows."
                              : "The event's ID, or the whole tw-… name X shows. Leave it empty to not send this event."}
                          </span>
                        </div>
                      );
                    })}
                  </fieldset>
                ) : null}
                {kind === "reddit" ? (
                  <div className="mt-3">
                    <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm text-ink">
                      <input
                        type="checkbox"
                        className="mt-0.5 h-5 w-5 shrink-0"
                        checked={redditOff}
                        onChange={(e) => setRedditOff(e.target.checked)}
                        aria-invalid={bad === "redditMatching"}
                        aria-describedby="px-redditMatching-help"
                      />
                      <span>
                        <span className="font-semibold">Automated Advanced Matching is switched off for this pixel in Reddit.</span>
                      </span>
                    </label>
                    <span id="px-redditMatching-help" className={`mt-1 block text-xs ${bad === "redditMatching" ? "font-semibold text-danger" : "text-ink-soft"}`}>
                      {bad === "redditMatching"
                        ? "Switch it off in your Reddit pixel's settings first, then check this box. Your store's pages show buyers' email addresses, which that setting would read."
                        : "Reddit can read email addresses shown or typed on a page with it. Your store's pages show buyers' own, so switch it off in your Reddit pixel's settings; Marktmorgen never sends Reddit an email address."}
                    </span>
                  </div>
                ) : null}
              </div>
            );
          })}

          <div className="rounded-[10px] bg-paper px-4 py-3 text-sm text-ink-soft ring-1 ring-line">
            <p>
              Sent to them: a page view on every page of your store, a checkout started when someone presses buy or
              books, a lead when someone asks for something free, and a purchase with its amount once it is paid. X
              gets page views, and purchases and leads only for the events you give it an ID for; X is never told about
              a checkout started. Reddit gets page visits, purchases and leads, and nothing when a checkout starts.
            </p>
            <p className="mt-2">
              These platforms set cookies, so visitors in the EU, Iceland, Liechtenstein, Norway, the UK, Switzerland and
              Brazil, and visitors whose country is not known, are asked first and nothing loads unless they say yes.
              Everywhere else the pixels load unless the visitor&apos;s browser sends a Global Privacy Control signal. The ads, and what you do with what they measure, are yours: say in your own privacy
              notice that you use them.
            </p>
          </div>

          {error ? <p className="notice notice-error" role="alert">{error}</p> : null}
          <div className="flex flex-wrap gap-3">
            <button type="submit" aria-busy={busy} disabled={busy} className="btn btn-primary">
              {busy ? "Saving…" : "Save pixels"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                if (disclosure.current) disclosure.current.open = false;
                setBad(null);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
          </fieldset>
        </form>
      </details>
    </section>
  );
}
