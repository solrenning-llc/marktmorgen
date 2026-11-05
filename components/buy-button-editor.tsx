"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { toast } from "@/components/toast";
import {
  CARD_HEIGHTS,
  CARD_WIDTH,
  DEFAULT_PLACE,
  MAX_BUTTON_TEXT,
  MAX_PLACE,
  buttonCode,
  buttonColors,
  buttonStyle,
  buttonText,
  cardCode,
  embedPath,
  embedPlace,
  tagged,
} from "@/lib/embed-rules";
import { productSegment } from "@/lib/product-slug";
import { NewTab } from "@/components/new-tab";

type Kind = "card" | "button";

/**
 * The code that sells one product from the creator's own website
 * (lib/embed-rules.ts): pick the product, a card or a plain button, and the
 * name of the place it goes, see it as it will look, and copy it.
 *
 * Nothing is saved. The code is built here from what is on the screen, and
 * the card it points to is drawn fresh on every visit, so changing the
 * product later in the studio changes it everywhere it was pasted.
 */
export function BuyButtonEditor({
  handle,
  products,
  fill,
  onFill,
}: {
  handle: string;
  /** The store's published products, in its own order. A draft is not on sale, so it has no card. */
  products: { id: string; title: string }[];
  /** The store's button colour and the colour of the words on it (lib/store-look.ts). */
  fill: string;
  onFill: string;
}) {
  const [productId, setProductId] = useState(products[0]?.id ?? "");
  const [kind, setKind] = useState<Kind>("card");
  const [place, setPlace] = useState("");
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);
  const [previewShown, setPreviewShown] = useState(false);
  // The height the card asks for, read off the preview as soon as its page
  // has arrived (it is this site's own page, so the studio may read it).
  // Not on its load event: that waits for the picture to arrive as well.
  const [heights, setHeights] = useState<Record<string, number>>({});
  const preview = useRef<HTMLIFrameElement>(null);
  const product = products.find((p) => p.id === productId) ?? products[0];
  const measuring = previewShown && kind === "card" && product && !(product.id in heights) ? product.id : null;
  useEffect(() => {
    if (!measuring) return;
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      let asked = 0;
      try {
        asked = Number(preview.current?.contentDocument?.querySelector("[data-card-height]")?.getAttribute("data-card-height"));
      } catch {
        // Not readable: the code keeps the smaller height, which the card still fits.
      }
      if (Number.isInteger(asked) && asked > 0) setHeights((all) => ({ ...all, [measuring]: asked }));
      if ((Number.isInteger(asked) && asked > 0) || tries >= 50) window.clearInterval(timer);
    }, 150);
    return () => window.clearInterval(timer);
  }, [measuring]);

  if (!product) {
    return (
      <div className="card min-w-0 p-6 sm:p-8">
        <p className="text-lg font-semibold tracking-[-0.02em] text-ink">Sell from your own website</p>
        <p className="mt-2 text-ink-soft">Add a product and you can put a card or a buy button for it on any website of yours.</p>
      </div>
    );
  }

  const words = buttonText(text, product.title);
  const colorsChanged = buttonColors(fill, onFill).changed;
  const height = heights[product.id] ?? CARD_HEIGHTS.plain;
  const code =
    kind === "card"
      ? cardCode({ handle, productId: product.id, title: product.title, place, height })
      : buttonCode({ handle, productId: product.id, text: words, place, fill, onFill });

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      toast("Copied. Paste it into your website.");
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      toast("Select the code and copy it.");
    }
  }

  return (
    <div className="card min-w-0 p-6 sm:p-8" id="buy-button">
      <p className="text-lg font-semibold tracking-[-0.02em] text-ink">Sell from your own website</p>
      <p className="mt-2 text-ink-soft">
        Put one of your products on your blog, portfolio or any other site: a card with its picture, price and buy button, or a plain button
        in your color. Paste the code into a block that takes HTML, called Embed, Code or Custom HTML in most website builders.
      </p>

      <div className="mt-6 grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="min-w-0">
          <span className="field-label">Product</span>
          <span className="relative mt-1 block min-w-0">
              <select className="field min-w-0 max-w-full appearance-none overflow-hidden pr-10" value={product.id} onChange={(event) => setProductId(event.target.value)}>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
              <span aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2"><Icon name="chevron-down" size={16} /></span>
            </span>
        </label>
        <label className="min-w-0">
          <span className="flex items-baseline justify-between gap-3">
            <span className="field-label">Where it goes</span>
            <span className="text-xs text-ink-mute">Optional</span>
          </span>
          <input
            className="field mt-1"
            maxLength={MAX_PLACE}
            value={place}
            placeholder={`For example: blog (empty: ${DEFAULT_PLACE})`}
            onChange={(event) => setPlace(event.target.value)}
          />
        </label>
      </div>
      <p className="mt-2 text-sm text-ink-soft">
        {`Sales made through it are listed as “${embedPlace(place)}” under Where the money came from, in your numbers, so two codes on two sites can be told apart.`}
      </p>

      <fieldset className="mt-5 min-w-0">
        <legend className="field-label">What to put there</legend>
        <div className="mt-2 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
          {(
            [
              ["card", "A card", "Picture, price, rating and the buy button. A new price, a sale or a sell-out shows on your site at once."],
              ["button", "A button", "One link in your color to the product's page, for a site that does not take cards."],
            ] as const
          ).map(([value, title, body]) => (
            <label key={value} className={`flex cursor-pointer gap-3 rounded-2xl p-4 ${kind === value ? "bg-lilac ring-2 ring-violet-brand" : "bg-paper ring-1 ring-line"}`}>
              <input type="radio" name="embed-kind" value={value} checked={kind === value} onChange={() => setKind(value)} className="mt-1 h-4 w-4 shrink-0" />
              <span>
                <span className="block font-semibold text-ink">{title}</span>
                <span className="mt-0.5 block text-sm text-ink-soft">{body}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {kind === "button" ? (
        <label className="mt-4 block">
          <span className="flex items-baseline justify-between gap-3">
            <span className="field-label">What the button says</span>
            <span className="text-xs tabular-nums text-ink-mute">{`${text.length}/${MAX_BUTTON_TEXT}`}</span>
          </span>
          <input className="field mt-1" maxLength={MAX_BUTTON_TEXT} value={text} placeholder={`Buy ${product.title}`} onChange={(event) => setText(event.target.value)} />
        </label>
      ) : null}

      {kind === "button" && colorsChanged ? (
        <p className="mt-3 text-sm text-ink-soft">
          These colors are hard to read. The code uses dark and white so the words are clear.{" "}
          <a href="/studio#look" className="font-semibold underline underline-offset-4">Choose another store color</a>.
        </p>
      ) : null}

      <div className="mt-6">
        <p className="field-label">How it looks</p>
        <div className="mt-2 rounded-2xl bg-paper p-4 ring-1 ring-line">
          {kind === "card" ? (
            <div>
              <button type="button" className="btn btn-secondary btn-sm mb-3" aria-expanded={previewShown} aria-controls="buy-card-preview" onClick={() => setPreviewShown((shown) => !shown)}>
                {previewShown ? "Hide card preview" : "Show card preview"}
              </button>
              <div id="buy-card-preview">
              {previewShown ? <iframe
              key={product.id}
              ref={preview}
              src={embedPath(handle, product.id)}
              title={`Buy ${product.title}`}
              width={CARD_WIDTH}
              height={height}
              style={{ display: "block", width: "100%", maxWidth: CARD_WIDTH, height, border: 0, borderRadius: 24 }}
            /> : null}
              </div>
            </div>
          ) : (
            <a href={tagged(`/@${handle}/p/${productSegment(product)}`, place)} target="_blank" rel="noopener" style={buttonStyle(fill, onFill)}>
              {words}
            <NewTab /></a>
          )}
        </div>
      </div>

      <label className="mt-6 block">
        <span className="field-label">The code to paste</span>
        <textarea className="field mt-1 font-mono text-xs" rows={kind === "card" ? 4 : 5} readOnly value={code} onFocus={(event) => event.currentTarget.select()} />
      </label>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void copy()}>
          <Icon name={copied ? "check" : "window"} size={15} />
          {copied ? "Copied" : "Copy the code"}
        </button>
        <a href={kind === "card" ? embedPath(handle, product.id) : `/@${handle}/p/${productSegment(product)}`} target="_blank" rel="noopener" className="btn btn-secondary btn-sm">
          <Icon name="external" size={15} />
          {kind === "card" ? "Open the card" : "Open where it leads"}
        <NewTab /></a>
      </div>
      <p className="mt-4 text-sm text-ink-soft">
        The buy button opens Stripe&apos;s checkout in a new tab, on your own Stripe account, with the same price, sale and discount codes as your
        store. A product with options to pick, a time to book or an email to give opens its own page instead. Nothing is counted as a visit and
        no cookie is set on your site.
      </p>
    </div>
  );
}
