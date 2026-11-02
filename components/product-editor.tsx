"use client";

import { PackageEditor } from "@/components/package-editor";
import { PodcastToggle } from "@/components/podcast-toggle";
import { WaitlistPanel } from "@/components/waitlist-panel";
import type { PreorderView } from "@/lib/preorders";
import { hasContent, preorderProblem } from "@/lib/preorder-rules";
import type { WaitlistView } from "@/lib/waitlist";
import { useRef, useState, useSyncExternalStore } from "react";
import { useLeaveGuard } from "@/components/leave-guard";
import { UrlField } from "@/components/url-field";
import { useRouter } from "next/navigation";
import { TeamEventEditor } from "@/components/team-event-editor";
import { CallEditor, type MeetAccount } from "@/components/call-editor";
import { CourseToggle } from "@/components/course-toggle";
import { BundleToggle } from "@/components/bundle-toggle";
import { CheckoutExtras, bumpChoices } from "@/components/checkout-extras";
import { PairsEditor } from "@/components/pairs-editor";
import type { ExtraNotes } from "@/lib/extras-notes";
import type { BumpChoice, ProductPaging } from "@/lib/catalog";
import { ProductUpdateBox } from "@/components/product-update-box";
import { ShippingEditor } from "@/components/shipping-editor";
import { MAX_SHIPPING_SKU } from "@/lib/shipping";
import { confirmsOptionWrite } from "@/lib/option-confirmation";
import { CheckoutFieldsEditor } from "@/components/checkout-fields-editor";
import { ProductImageEditor } from "@/components/product-image-editor";
import type { CoverLook } from "@/components/cover-maker";
import { LANGUAGES, type LanguageCode } from "@/lib/store-language";
import { LicenceKeyEditor } from "@/components/licence-key-editor";
import { PdfStampToggle } from "@/components/pdf-stamp-toggle";
import { PdfPreviewToggle } from "@/components/pdf-preview-toggle";
import { toast } from "@/components/toast";
import { uploadReason, uploadSoldFile } from "@/lib/sold-file-upload";
import {
  MAX_PRODUCTS,
  MAX_SUMMARY_LENGTH,
  MAX_TITLE_LENGTH,
  isFree,
  type Product,
} from "@/lib/store-field-rules";
import { type Currency, fieldPrefix, formatMoney, moneyField, priceExample, priceBounds, rangeWords, readMoney } from "@/lib/money";
import { StoreCurrency, useStoreCurrency } from "@/components/store-currency";
import { AiAssist, AiOn } from "@/components/ai-assist";
import {
  ACCEPT_ATTRIBUTE,
  MAX_FILE_BYTES,
  maxFileLabel,
  readableSize,
  type ProductFile,
} from "@/lib/product-file";
import {
  MAX_OPTIONS,
  MAX_OPTION_DETAILS,
  MAX_OPTION_DETAIL_LENGTH,
  MAX_OPTION_LABEL_LENGTH,
  MAX_STORE_OPTIONS,
} from "@/lib/product-option";
import { LINK_PROBLEMS, type LinkProblem, linkHost } from "@/lib/product-link";
import {
  INTERVALS,
  type Interval,
  MAX_MEMBER_PAYMENTS,
  MAX_TRIAL_DAYS,
  MIN_MEMBER_PAYMENTS,
  MIN_TRIAL_DAYS,
  everyLabel,
  intervalAdjective,
  intervalName,
  membershipPrice,
} from "@/lib/product-recurring";
import { MAX_INTRO_COUNT, introLineEnglish } from "@/lib/intro-price";
import { MAX_ABOUT_LENGTH, aboutBlocks } from "@/lib/product-about";
import { ProductAbout } from "@/components/product-about-view";
import { type StoreLook, lookStyle } from "@/lib/store-look";
import { imageUrl } from "@/lib/product-image";
import { StoreField, useStudioHref, useStudioStore } from "@/components/studio-store-pin";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { productSegment } from "@/lib/product-slug";
import { feeWords } from "@/lib/fee-words";
import { COMMISSION_LIVE } from "@/lib/plan";
import { NewTab } from "@/components/new-tab";
import { TermsCheckPanel } from "@/components/terms-check-panel";
import { fastMoneyMessage } from "@/lib/terms-check-rules";
import { deliversDigitally } from "@/lib/digital-consent";

/** The sentences about amounts, in the store's own currency (lib/money.ts). */
const optionPrice = (currency: Currency) => `Type an amount ${rangeWords(currency)}, like ${priceExample(currency, 39)}.`;
const productPrice = (currency: Currency) =>
  `Type 0 to give it away, or an amount ${rangeWords(currency)}, like ${priceExample(currency)}.`;
const pwywFree = (currency: Currency) =>
  `Something free has no price to choose. Give it a lowest price of at least ${formatMoney(priceBounds(currency).min, currency)}.`;
const pwywSuggested = (currency: Currency) =>
  `Type a suggested price between the lowest price and ${formatMoney(priceBounds(currency).max, currency)}, like ${priceExample(currency, 15)}.`;

/** What to say when a price option is refused, over and above the shared set. */
const OPTION_MESSAGES: Record<string, string> = {
  sku: "Use up to 64 characters for the inventory reference, without line breaks or control characters.",
  sku_kind: "Inventory references are available for physical products that you ship.",
  free: "This one is free, so it has no prices to add. Give it a price first.",
  unknown: "That price is no longer on this product.",
  none: "This account has no store yet.",
  signed_out: "Your session ended. Log in again.",
  unavailable: "Stores are not switched on yet, so nothing was saved.",
  call: "This is a paid call, so it has one price. Stop selling it as a call first to add others.",
  course: "A course or podcast sold as a membership charges one amount each time, so it cannot have several prices.",
  store_too_many: `Your store holds ${MAX_STORE_OPTIONS.toLocaleString("en-US")} prices across all its products, which is the most it can. Remove a price you no longer use to add this one.`,
  bundle: "A bundle has one price for everything in it, so it cannot have several.",
  store_full: "Your store has reached the most it can hold. Remove something, or shorten a long list of choices, to make room.",
};

export { fastMoneyMessage } from "@/lib/terms-check-rules";


/** Why a price the buyer chooses was refused, in words the creator can act on. */
const PWYW_MESSAGES: Record<string, string> = {
  recurring: "A membership charges the same amount each time, so its buyers cannot choose it. Stripe lets a buyer choose the amount of a one-off payment only.",
  options: "This product has several prices already. Take them off first: the buyer would be choosing twice.",
  call: "A paid call is booked for a time at a set price, so it cannot be pay what you want.",
  plan: "This product offers a payment plan. Stop offering it first: a plan needs a set total to divide.",
  bump: "This product offers another one at checkout. Stop offering it first: Stripe lets a chosen amount be the only thing in its checkout.",
};

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  title: "Give it a name before saving.",
  // A course from a ready structure, published before its example titles were replaced (540 [CU1]).
  course_examples: 'This course still has example titles. Open the course, replace each with your own, then publish it.',
  trial: `Type a free trial of ${MIN_TRIAL_DAYS} to ${MAX_TRIAL_DAYS} days, or leave it empty for none.`,
  payments: `Type ${MIN_MEMBER_PAYMENTS} to ${MAX_MEMBER_PAYMENTS} payments, or leave it empty for a membership that runs until it is canceled.`,
  store_full: "Your store has reached the most it can hold. Remove something, or shorten a long list of choices, to make room.",
  intro_membership: "An introductory price is for a membership. Pick how often it charges first.",
  intro_trial: "A membership starts with one offer: a free trial or an introductory price. Empty one of them.",
  intro_payments: "An introductory price is for a membership that runs until it is canceled. Empty \u201cEnds after\u201d, or the introductory price.",
  intro_options: "This membership has several prices, so one introductory price cannot fit them all. Take the options off first.",
  intro_pwyw: "A membership charges a set price, so its buyers cannot choose it.",
  intro_tiers: "Members can switch to and from this plan, and a fixed amount off could follow them to a cheaper one. Take it out of the plans members switch between first.",
  intro_price: "Type an introductory price below the regular price, and at least the least your currency can charge.",
  intro_count: "A monthly membership's introductory price lasts 1 to 12 months; any other only the first payment.",
  intro_yearly: "A membership starts with one offer: an introductory price or a yearly price. Empty one of them.",
  yearly_membership: "A yearly price goes beside a monthly membership. Pick Monthly first.",
  yearly_month: "A yearly price goes beside a monthly membership.",
  yearly_payments: "A yearly price is for a membership that runs until it is canceled. Empty \u201cEnds after\u201d, or the yearly price.",
  yearly_options: "This membership has several prices, so one yearly price cannot fit them all. Take the options off first.",
  yearly_pwyw: "A membership charges a set price, so its buyers cannot choose it.",
  yearly_tiers: "Members can switch between this plan and others, at one price each. Take it out of the plans members switch between first.",
  yearly_intro: "A membership starts with one offer: an introductory price or a yearly price. Empty one of them.",
  yearly_price: "Type a yearly price below twelve monthly payments, so paying yearly saves something, and at least the least your currency can charge.",
  free: "Something free is given once, for an email address, so it cannot be a membership or have several prices. Take those off first.",
  unknown: "That is no longer on your store.",
  preorders: "Buyers have pre-ordered this and are waiting for it. Put it on sale, which hands it to them, or refund their pre-orders in your Stripe dashboard first.",
  call: "This is a paid call, so it has one price, charged once, and delivers a time rather than a file. Stop selling it as a call first to change that.",
  course: "This is a course: it cannot be free, and it delivers its lessons rather than a file or a link of its own. Its lessons are changed from its own page.",
  shipped: "This is a physical product you ship: sold once, at one price, with nothing else to hand over. Under Shipping, stop shipping it first to change that.",
  ship_free: "A product you ship needs a price.",
  ship_membership: "A product you ship is sold once, not as a membership.",
  ship_call: "A call delivers a time, so it cannot be shipped.",
  ship_options: "A product you ship has one price. Take its options off first.",
  ship_pwyw: "A product you ship has a set price, so buyers cannot choose it.",
  ship_plan: "A product you ship is paid in full. Stop its payment plan first.",
  ship_delivery: "This product already hands over a file, a link, a course, a podcast or a bundle. Take that off first, or make a new product to ship.",
  ship_price: "Type a shipping cost of 0 for free shipping, or at least the least your currency can charge.",
  bundle: "This is a bundle: one sale, at one price, of the products in it. It cannot be free, a membership, pay what you want, have several prices or a file of its own. Change what is in it on its bundle page.",
  too_big: `That file is over ${maxFileLabel()}, the largest one file can be.`,
  storage_full: "This file does not fit within your store's remaining storage. Delete a file you no longer sell to make room — nothing already bought is affected.",
  wrong_type: "That kind of file is not one a store can sell here.",
  none: "This account has no store yet.",
  signed_out: "Your session ended. Log in again.",
  unavailable: "Stores are not switched on yet, so nothing was saved.",
  server_error: "Something went wrong on our side. Try again in a moment.",
};

type Draft = {
  title: string;
  summary: string;
  price: string;
  /** "" means a single sale. Anything else is how often it charges. */
  every: "" | Interval;
  /** Days free before a membership's first payment. "" is none. */
  trial: string;
  /** Payments before a membership ends by itself. "" is until cancelled. */
  payments: string;
  /** What a membership's first payments cost (lib/intro-price.ts). "" is none. */
  introPrice: string;
  /** How many payments cost that, as typed: "1" to "12" on a monthly membership. */
  introCount: string;
  /** What a year costs, for a monthly membership paid yearly (lib/yearly-price.ts). "" is none. */
  yearlyPrice: string;
  /** Whether the buyer chooses the price, from `price` up. */
  pwyw: boolean;
  /** The amount suggested to a buyer who chooses. */
  suggested: string;
  /** The long description, on the product's own page. */
  about: string;
};

const EMPTY: Draft = {
  title: "",
  summary: "",
  price: "",
  every: "",
  trial: "",
  payments: "",
  introPrice: "",
  introCount: "1",
  yearlyPrice: "",
  pwyw: false,
  suggested: "",
  about: "",
};

/** What the form sends for a draft, add or edit alike. */
function payloadOf(draft: Draft): Record<string, unknown> {
  return {
    title: draft.title,
    summary: draft.summary,
    price: draft.price,
    every: draft.every,
    trial: draft.every ? draft.trial.trim() : "",
    payments: draft.every ? draft.payments.trim() : "",
    // Always sent from here, so taking it off, or the membership away, clears it.
    intro: draft.every && draft.introPrice.trim() ? { price: draft.introPrice.trim(), count: draft.every === "month" ? Number(draft.introCount) || 1 : 1 } : null,
    yearly: draft.every === "month" && draft.yearlyPrice.trim() ? { price: draft.yearlyPrice.trim() } : null,
    pwyw: draft.pwyw && !draft.every ? draft.suggested.trim() || draft.price.trim() : null,
    about: draft.about,
  };
}

/** Whether what was typed in the price field means free. */
function typedFree(price: string): boolean {
  return /^0+(\.0{1,2})?$/.test(price.trim());
}

/**
 * Saves a change, and brings back both what was wrong and what went quiet.
 *
 * `quiet` is the part that is new: a saved change can stop buyers being shown
 * something on a *different* product — a checkout box that offered the product
 * whose price just came down, an after-paying offer, a payment plan the new
 * price outgrew. The server works out which, because it takes the whole store
 * to know (app/api/store/product/route.ts), and the creator is told here rather
 * than finding out from the takings.
 */
async function send(
  payload: Record<string, unknown>,
  currency: Currency,
): Promise<{ problem: string | null; quiet: string[] }> {
  const wrong = (message: string) => ({ problem: message, quiet: [] });
  try {
    const response = await fetch("/api/store/product", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await response.json()) as {
      ok?: boolean;
      error?: string;
      limit?: number;
      reason?: string;
      quiet?: string[];
    };
    if (data.ok) return { problem: null, quiet: Array.isArray(data.quiet) ? data.quiet : [] };
    if (data.error === "link") {
      // The server says which way the link was wrong; the creator gets that
      // sentence rather than a generic failure they cannot act on.
      return wrong(LINK_PROBLEMS[data.reason as LinkProblem] ?? LINK_PROBLEMS.shape);
    }
    if (data.error === "too_many") {
      return wrong(`A store lists up to ${(data.limit ?? MAX_PRODUCTS).toLocaleString("en-US")} things, and yours is full. Remove one to add another.`);
    }
    if (data.error === "pwyw") {
      const why = (data as { pwyw?: string }).pwyw ?? "";
      if (why === "free") return wrong(pwywFree(currency));
      return wrong(why === "suggested" || !PWYW_MESSAGES[why] ? pwywSuggested(currency) : PWYW_MESSAGES[why]);
    }
    if (data.error === "price") return wrong(productPrice(currency));
    if (data.error === "fast_money") return wrong(fastMoneyMessage((data as { passage?: unknown }).passage, payload.action === "visibility" ? "publish" : payload.action === "add" ? "add" : "save"));
    return wrong(MESSAGES[data.error ?? ""] ?? MESSAGES.server_error);
  } catch {
    return wrong(MESSAGES.server_error);
  }
}

/** The form used both for adding something and for changing it. */
function ProductForm({
  draft,
  setDraft,
  busy,
  error,
  submitLabel,
  onSubmit,
  onCancel,
  product,
  loadingAbout = false,
  ownHosts = [],
  preview = null,
}: {
  draft: Draft;
  setDraft: (draft: Draft) => void;
  busy: boolean;
  error: string | null;
  submitLabel: string;
  onSubmit: () => void;
  onCancel: () => void;
  /** The product being changed; absent when adding one. */
  product?: Product;
  /** Whether the long description is still being read. */
  loadingAbout?: boolean;
  /** The store's own hosts besides its marktmorgen.com address (its own domain), not warned as "another site". */
  ownHosts?: string[];
  /** The store's look and language, so the product's own words are previewed as buyers see them (487 [IT4], pattern 7). */
  preview?: { look: StoreLook; language: LanguageCode } | null;
}) {
  const id = product?.id ?? "new";
  // The preview starts at a phone's width, where most product pages are read.
  const [phone, setPhone] = useState(true);
  const toggle = (on: boolean) => `inline-flex min-h-11 items-center rounded-full px-4 text-sm font-semibold ${on ? "bg-white text-ink shadow-sm" : "text-ink-soft"}`;
  // The title, summary and description as the product page draws them (components/product-about-view.tsx), from what is typed now.
  const pagePreview = preview ? (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-soft">As buyers see it</p>
        <div role="group" aria-label="Preview width" className="inline-flex rounded-full bg-sand p-1">
          <button type="button" className={toggle(phone)} aria-pressed={phone} onClick={() => setPhone(true)}>
            Phone
          </button>
          <button type="button" className={toggle(!phone)} aria-pressed={!phone} onClick={() => setPhone(false)}>
            Wide
          </button>
        </div>
      </div>
      <p className="mt-1 text-xs text-ink-soft">The same words as in the form, laid out as your product&apos;s page shows them. The price and the Buy button aren&apos;t shown here: your page adds them from what you save. Nothing in it can be pressed here.</p>
      <div className="mt-1 overflow-hidden rounded-2xl ring-1 ring-line">
        <div
          // Inert: its links stay out of the Tab order and out of reach of a click that would leave the form.
          inert
          // In the store's language, as the page is, so a screen reader would read its words in the right language (3.1.2).
          lang={LANGUAGES[preview.language]?.locale ?? "en-US"}
          className={`st-page st-theme-${preview.look.theme} mx-auto px-4 pb-8 pt-6`}
          // Wide is the product page's own width (max-w-2xl, 672 px); the card and the title follow Phone or Wide, as the page does.
          style={{ ...(lookStyle(preview.look) as React.CSSProperties), maxWidth: phone ? 390 : 672 }}
        >
          <div className={`st-card ${phone ? "p-6" : "p-8"}`}>
            <p className={`font-display font-semibold leading-tight tracking-[-0.02em] ${phone ? "text-2xl" : "text-3xl"}`}>{draft.title.trim() || "Your product's name"}</p>
            {draft.summary.trim() ? <p className="st-muted mt-4 text-lg leading-relaxed">{draft.summary}</p> : null}
            {draft.about.trim() ? <ProductAbout blocks={aboutBlocks(draft.about)} language={preview.language} /> : null}
          </div>
        </div>
      </div>
    </div>
  ) : null;
  const currency = useStoreCurrency();
  const prefix = fieldPrefix(currency);
  const free = typedFree(draft.price);
  // Said before the box is ticked rather than after saving: what else on the
  // product would stop a buyer from choosing the price.
  const pwywBlocked = product
    ? product.options.length > 0
      ? PWYW_MESSAGES.options
      : product.call
        ? PWYW_MESSAGES.call
        : product.plan
          ? PWYW_MESSAGES.plan
          : product.bumps.length
            ? PWYW_MESSAGES.bump
            : null
    : null;
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) onSubmit();
      }}
      className="space-y-4 rounded-2xl border-2 border-violet-brand/30 bg-white p-4"
    >
      <div>
        <label
          htmlFor={`product-title-${id}`}
          className="field-label"
        >
          What you are selling
        </label>
        <input
          id={`product-title-${id}`}
          name="title"
          type="text"
          required
          maxLength={MAX_TITLE_LENGTH}
          value={draft.title}
          onChange={(event) =>
            setDraft({ ...draft, title: event.target.value })
          }
          placeholder="The Weeknight Recipe Pack"
          className="field mt-2"
        />
      </div>

      <AiAssist<{ summary: string; about: string }>
        title="Write the description with AI"
        hint="A few words in your own voice: what it is, who it is for, what is inside. A draft of both descriptions below is written from them."
        placeholder="40 weeknight recipes, each on one page, for busy parents who cook for picky kids. Shopping lists included."
        payload={() => ({
          kind: "product",
          title: draft.title,
          price: draft.price,
          productKind: product?.course
            ? "course"
            : product?.call
              ? "call"
              : product?.recurring
                ? "membership"
                : product?.bundle
                  ? "bundle"
                  : product?.link
                    ? "link"
                    : "download",
        })}
        onResult={(value) => setDraft({ ...draft, summary: value.summary, about: value.about })}
        done="Both descriptions below are filled in. Read them, change anything, then save."
      />

      <div>
        <label
          htmlFor={`product-summary-${id}`}
          className="field-label"
        >
          What the buyer gets, in short
        </label>
        <textarea
          id={`product-summary-${id}`}
          name="summary"
          rows={3}
          maxLength={MAX_SUMMARY_LENGTH}
          value={draft.summary}
          onChange={(event) =>
            setDraft({ ...draft, summary: event.target.value })
          }
          placeholder="Forty recipes, each one on a single page, as a PDF."
          className="field mt-2"
        />
        <p className="mt-1 text-sm text-ink-soft">
          {`On the card on your page. ${MAX_SUMMARY_LENGTH - draft.summary.length} characters left.`}
        </p>
      </div>

      <div className={pagePreview ? "grid min-w-0 gap-4 xl:grid-cols-2" : "min-w-0"}>
      <div className="min-w-0">
        <label htmlFor={`product-about-${id}`} className="field-label">
          The full description <span className="font-normal text-ink-soft">(optional)</span>
        </label>
        <textarea
          id={`product-about-${id}`}
          name="about"
          rows={7}
          maxLength={MAX_ABOUT_LENGTH}
          value={draft.about}
          disabled={loadingAbout}
          aria-busy={loadingAbout}
          onChange={(event) => setDraft({ ...draft, about: event.target.value })}
          placeholder={"What is inside, who it is for, and what happens after they buy.\n\n- One point per line, starting with a dash, makes a list.\n- Web addresses become links."}
          className="field mt-2"
        />
        <p className="mt-1 text-sm text-ink-soft">
          {loadingAbout
            ? "Reading what you wrote…"
            : `On this product's own page, which the card links to. A blank line starts a new paragraph. ${(MAX_ABOUT_LENGTH - draft.about.length).toLocaleString("en-US")} characters left.`}
        </p>
        {loadingAbout ? null : (
          <TermsCheckPanel
            id={id}
            fieldId={`product-about-${id}`}
            input={{
              text: draft.about,
              ownHosts,
              // The checkout's one price: none to compare for a membership, a choose-your-price, a product sold by its
              // options (the single price is then not charged) or a free one.
              priceCents: !draft.every && !draft.pwyw && !product?.options.length && !free ? readMoney(draft.price, currency) : null,
              currency,
              // The consent the checkout will ask for once this is saved: a new product is plain digital content until
              // a call or shipping is set on it (lib/digital-consent.ts, deliversDigitally).
              immediateAccessConsent: !draft.every && deliversDigitally(product ?? {}),
              // No end date exists on a product, so no deadline is ever real here.
              realDeadline: false,
              realStockLimit: product?.stock != null,
              resaleLicense: false,
            }}
            onChange={(about) => setDraft({ ...draft, about })}
          />
        )}
      </div>
      {pagePreview ? (
        <>
          {/* Beside the description on a wide screen; on a narrow one, folded. */}
          <div className="hidden xl:block">{pagePreview}</div>
          <details className="xl:hidden">
            <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-semibold text-ink underline underline-offset-4">See it as buyers see it</summary>
            <div className="mt-2">{pagePreview}</div>
          </details>
        </>
      ) : null}
      </div>

      <div>
        <label
          htmlFor={`product-price-${id}`}
          className="field-label"
        >
          {draft.pwyw && !draft.every && !free ? "Lowest price" : "Price"}
        </label>
        <div className="card mt-2 flex items-center pl-4 transition focus-within:border-violet-brand">
          <span className="whitespace-nowrap text-ink-soft">{prefix}</span>
          <input
            id={`product-price-${id}`}
            name="price"
            type="text"
            inputMode={currency === "jpy" ? "numeric" : "decimal"}
            required
            value={draft.price}
            onChange={(event) =>
              setDraft({
                ...draft,
                price: event.target.value,
                // Free is given once, so a schedule would be left behind
                // pointing at nothing. It goes when the price goes to zero.
                every: typedFree(event.target.value) ? "" : draft.every,
                pwyw: typedFree(event.target.value) ? false : draft.pwyw,
              })
            }
            placeholder={currency === "jpy" ? "2700" : "27"}
            className="w-full rounded-r-2xl bg-transparent px-2 py-3 text-ink outline-none placeholder:text-ink-soft/50"
          />
        </div>
        <p className="mt-1 text-sm text-ink-soft">
          {typedFree(draft.price)
            ? "Free. A visitor types their email and we send them a link to it; their address joins your list once they use that link, marked with whether they agreed to hear from you."
            : `Your store charges in ${currency.toUpperCase()}: buyers pay exactly this, in ${currency.toUpperCase()}. The currency is chosen under Ways to pay. Type 0 to give it away for an email address instead.`}
        </p>
      </div>

      {free || draft.every ? null : (
        <div className="rounded-2xl border border-line bg-paper p-4">
          <label htmlFor={`product-pwyw-${id}`} className="flex min-h-11 cursor-pointer items-start gap-3">
            <input
              id={`product-pwyw-${id}`}
              type="checkbox"
              checked={draft.pwyw}
              disabled={Boolean(pwywBlocked) && !draft.pwyw}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  pwyw: event.target.checked,
                  suggested: draft.suggested || draft.price,
                })
              }
              className="mt-1 h-4 w-4 shrink-0 accent-[var(--violet)]"
            />
            <span>
              <span className="block font-semibold text-ink">Let buyers pay what they want</span>
              <span className="mt-0.5 block text-sm text-ink-soft">
                {pwywBlocked && !draft.pwyw
                  ? pwywBlocked
                  : "The price above becomes the lowest they can pay. They type the amount on Stripe's payment page."}
              </span>
            </span>
          </label>
          {draft.pwyw ? (
            <div className="mt-3 pl-7">
              <label htmlFor={`product-suggested-${id}`} className="field-label">
                Suggested price
              </label>
              <div className="card mt-2 flex max-w-[14rem] items-center pl-4 transition focus-within:border-violet-brand">
                <span className="whitespace-nowrap text-ink-soft">{prefix}</span>
                <input
                  id={`product-suggested-${id}`}
                  type="text"
                  inputMode={currency === "jpy" ? "numeric" : "decimal"}
                  value={draft.suggested}
                  onChange={(event) => setDraft({ ...draft, suggested: event.target.value })}
                  placeholder={currency === "jpy" ? "1500" : "15"}
                  className="w-full rounded-r-2xl bg-transparent px-2 py-3 text-ink outline-none placeholder:text-ink-soft/50"
                />
              </div>
              <p className="mt-2 text-sm text-ink-soft">
                {`What the amount box starts at. Buyers can pay up to ${formatMoney(priceBounds(currency).max, currency)}.`} Discount codes are not offered on it, and it
                cannot have several prices, a payment plan or a product offered at checkout: Stripe lets a buyer choose
                the amount of one item, paid once. A limited quantity, an offer after paying, sales tax and questions at
                checkout all work with it.
              </p>
            </div>
          ) : null}
        </div>
      )}

      {typedFree(draft.price) ? null : (
      <div>
        <label
          htmlFor={`product-every-${id}`}
          className="field-label"
        >
          How often it charges
        </label>
        <select
          id={`product-every-${id}`}
          name="every"
          value={draft.every}
          onChange={(event) =>
            setDraft({
              ...draft,
              every: event.target.value as "" | Interval,
              // A membership charges a set amount, so nobody chooses it.
              pwyw: event.target.value ? false : draft.pwyw,
            })
          }
          className="field mt-2"
        >
          <option value="">Once — a single sale</option>
          {INTERVALS.map((interval) => (
            <option key={interval} value={interval}>
              {`${intervalName(interval)} \u2014 charged once ${everyLabel(interval)}`}
            </option>
          ))}
        </select>
        <p className="mt-1 text-sm text-ink-soft">
          {draft.every
            ? `A membership. The member is charged once ${everyLabel(
                draft.every,
              )} on your own Stripe account until it is canceled. Members can cancel it themselves from your store's membership page, linked in their confirmation email and under the membership on your page, and you can cancel it in your Stripe dashboard. A file or course delivered here closes when the membership ends; access to a link that leads somewhere else is yours to take back.`
            : "Most things are sold once. Pick a schedule to make this a membership instead."}
        </p>
        {draft.every ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`product-trial-${id}`} className="field-label">
                Free trial, in days <span className="font-normal text-ink-soft">(optional)</span>
              </label>
              <input
                id={`product-trial-${id}`}
                type="number"
                inputMode="numeric"
                min={MIN_TRIAL_DAYS}
                max={MAX_TRIAL_DAYS}
                step={1}
                value={draft.trial}
                onChange={(event) => setDraft({ ...draft, trial: event.target.value })}
                placeholder="None"
                className="field mt-2"
              />
              <p className="mt-1 text-sm text-ink-soft">
                {`${MIN_TRIAL_DAYS} to ${MAX_TRIAL_DAYS}. The card is asked for at the start and nothing is charged until the trial ends.`}
              </p>
            </div>
            <div>
              <label htmlFor={`product-payments-${id}`} className="field-label">
                Ends after, in payments <span className="font-normal text-ink-soft">(optional)</span>
              </label>
              <input
                id={`product-payments-${id}`}
                type="number"
                inputMode="numeric"
                min={MIN_MEMBER_PAYMENTS}
                max={MAX_MEMBER_PAYMENTS}
                step={1}
                value={draft.payments}
                onChange={(event) => setDraft({ ...draft, payments: event.target.value })}
                placeholder="Until canceled"
                className="field mt-2"
              />
              <p className="mt-1 text-sm text-ink-soft">
                {`${MIN_MEMBER_PAYMENTS} to ${MAX_MEMBER_PAYMENTS}. After the last one it stops by itself; members can still cancel sooner.`}
              </p>
            </div>
            <div className="sm:col-span-2">
              <label htmlFor={`product-intro-${id}`} className="field-label">
                Introductory price <span className="font-normal text-ink-soft">(optional)</span>
              </label>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                <div className="card flex w-40 items-center pl-4 transition focus-within:border-violet-brand">
                  <span className="whitespace-nowrap text-ink-soft">{prefix}</span>
                  <input
                    id={`product-intro-${id}`}
                    type="text"
                    inputMode={currency === "jpy" ? "numeric" : "decimal"}
                    value={draft.introPrice}
                    onChange={(event) => setDraft({ ...draft, introPrice: event.target.value })}
                    placeholder="None"
                    aria-describedby={`product-intro-hint-${id}`}
                    className="w-full rounded-r-2xl bg-transparent px-2 py-3 text-ink outline-none placeholder:text-ink-soft/50"
                  />
                </div>
                {draft.every === "month" ? (
                  <>
                    <label htmlFor={`product-intro-count-${id}`} className="text-sm text-ink-soft">
                      for the first
                    </label>
                    <select
                      id={`product-intro-count-${id}`}
                      value={draft.introCount}
                      onChange={(event) => setDraft({ ...draft, introCount: event.target.value })}
                      className="field w-36"
                    >
                      {Array.from({ length: MAX_INTRO_COUNT }, (_, i) => i + 1).map((n) => (
                        <option key={n} value={String(n)}>
                          {n === 1 ? "1 month" : `${n} months`}
                        </option>
                      ))}
                    </select>
                  </>
                ) : (
                  <span className="text-sm text-ink-soft">{`for the first ${draft.every}`}</span>
                )}
              </div>
              <p id={`product-intro-hint-${id}`} className="mt-1 text-sm text-ink-soft">
                Less than the regular price. Stripe takes the difference off the first payments by itself, and the regular price starts after. Your page, its button and the checkout say both prices. Not beside a free trial or a set number of payments, and a come-back offer replaces it.
              </p>
            </div>
            {draft.every === "month" ? (
              <div className="sm:col-span-2">
                <label htmlFor={`product-yearly-${id}`} className="field-label">
                  Or pay yearly <span className="font-normal text-ink-soft">(optional)</span>
                </label>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                  <div className="card flex w-40 items-center pl-4 transition focus-within:border-violet-brand">
                    <span className="whitespace-nowrap text-ink-soft">{prefix}</span>
                    <input
                      id={`product-yearly-${id}`}
                      type="text"
                      inputMode={currency === "jpy" ? "numeric" : "decimal"}
                      value={draft.yearlyPrice}
                      onChange={(event) => setDraft({ ...draft, yearlyPrice: event.target.value })}
                      placeholder="None"
                      aria-describedby={`product-yearly-hint-${id}`}
                      className="w-full rounded-r-2xl bg-transparent px-2 py-3 text-ink outline-none placeholder:text-ink-soft/50"
                    />
                  </div>
                  <span className="text-sm text-ink-soft">a year</span>
                </div>
                <p id={`product-yearly-hint-${id}`} className="mt-1 text-sm text-ink-soft">
                  {(() => {
                    const monthly = readMoney(draft.price, currency);
                    const year = draft.yearlyPrice.trim() ? readMoney(draft.yearlyPrice, currency) : null;
                    const saves = monthly !== null && year !== null && year < monthly * 12 ? formatMoney(monthly * 12 - year, currency) : null;
                    return `Buyers pick Monthly or Yearly before paying${saves ? `, and Yearly says it saves ${saves} against twelve monthly payments` : ", and Yearly says what it saves against twelve monthly payments"}. Members already paying monthly can switch to it from their membership page. Less than twelve monthly payments. Not beside an introductory price or a set number of payments.`;
                  })()}
                </p>
              </div>
            ) : null}
            {/^\d+$/.test(draft.trial.trim()) || /^\d+$/.test(draft.payments.trim()) || draft.introPrice.trim() ? (
              <p className="rounded-xl bg-sand px-3 py-2 text-sm text-ink sm:col-span-2">
                {(() => {
                  const typed = readMoney(draft.price, currency);
                  const price = typed === null ? `${prefix} ${draft.price.trim() || "0"}` : formatMoney(typed, currency);
                  const regular = membershipPrice(
                    {
                      interval: draft.every,
                      trialDays: Number(draft.trial.trim()) || 0,
                      payments: Number(draft.payments.trim()) || 0,
                    },
                    price,
                  );
                  const intro = draft.introPrice.trim() ? readMoney(draft.introPrice, currency) : null;
                  const count = draft.every === "month" ? Number(draft.introCount) || 1 : 1;
                  return `Your page will say: ${intro !== null ? introLineEnglish(formatMoney(intro, currency), count, draft.every, regular) : regular}.`;
                })()}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      )}

      {error ? (
        <p
          className="notice notice-error "
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          aria-busy={busy} disabled={busy}
          className="btn btn-primary"
        >
          {busy ? "Saving…" : submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="btn btn-ghost"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * The several prices one product may be sold at.
 *
 * Kept below the product rather than inside its form, because adding a price
 * is not editing the product: the title and the description stay as they are
 * while the creator works out what to charge. Each option carries its own
 * file or link, so the block that attaches one is the same block a product
 * without options uses.
 */
function OptionsBlock({
  product,
  fileBusyId,
  percent,
  fileError,
  onPick,
  onDetach,
  onLink,
  onUnlink,
}: {
  product: Product;
  fileBusyId: string | null;
  percent: number;
  fileError: { id: string; message: string } | null;
  onPick: (id: string, file: File) => void;
  onDetach: (id: string) => void;
  onLink: (id: string, url: string) => void;
  onUnlink: (id: string) => void;
}) {
  const router = useRouter();
  const currency = useStoreCurrency();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [price, setPrice] = useState("");
  const [details, setDetails] = useState("");
  const [sku, setSku] = useState("");
  const [best, setBest] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  // A course or private podcast is its own delivery: every price opens it,
  // and a file or link on one is something extra that price includes.
  const opens = Boolean(product.course || product.podcast || product.shipping);
  // Shipped by the creator (lib/shipping.ts): each price is a size or a version of the same thing, with nothing to attach.
  const shipped = Boolean(product.shipping);
  const [error, setError] = useState<string | null>(null);

  async function run(payload: Record<string, unknown>, done: () => void, confirmation?: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/option", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data: unknown = await response.json().catch(() => null);
      if (!confirmsOptionWrite(data, response.ok)) {
        const refusal = typeof data === "object" && data !== null && !Array.isArray(data)
          && Object.hasOwn(data, "ok") && (data as { ok?: unknown }).ok === false;
        const reason = refusal && typeof data === "object" && data !== null
          && Object.hasOwn(data, "error") && typeof (data as { error?: unknown }).error === "string"
          ? (data as { error: string }).error : null;
        setError(
          reason === "fast_money"
            ? fastMoneyMessage((data as { passage?: unknown }).passage, "save")
            : reason === "too_many"
            ? `A product carries up to ${MAX_OPTIONS} prices.`
            : reason === "label"
              ? "Give this price a name the buyer will read, like “5 weeks.”"
              : reason === "price"
                ? optionPrice(currency)
                : reason && Object.hasOwn(OPTION_MESSAGES, reason)
                  ? OPTION_MESSAGES[reason]
                  : "The price change was not confirmed. Reload to check its status before trying again.",
        );
        return;
      }
      done();
      if (confirmation) toast(confirmation);
      router.refresh();
    } catch {
      setError("The price change was not confirmed. Reload to check its status before trying again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const form = (submitLabel: string, onSubmit: () => void, onCancel: () => void) => (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) onSubmit();
      }}
      className="mt-2 space-y-3 rounded-2xl border-2 border-violet-brand/30 bg-white p-4"
    >
      <div className="flex flex-wrap gap-3">
        <div className="min-w-[10rem] flex-1">
          <label
            htmlFor={`option-label-${product.id}`}
            className="field-label"
          >
            What this one is
          </label>
          <input
            id={`option-label-${product.id}`}
            type="text"
            required
            maxLength={MAX_OPTION_LABEL_LENGTH}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="5 weeks"
            className="field mt-1"
          />
        </div>
        <div className="w-28">
          <label
            htmlFor={`option-price-${product.id}`}
            className="field-label"
          >
            {`Price, ${fieldPrefix(currency)}`}
          </label>
          <input
            id={`option-price-${product.id}`}
            type="text"
            inputMode={currency === "jpy" ? "numeric" : "decimal"}
            required
            value={price}
            onChange={(event) => setPrice(event.target.value)}
            placeholder={currency === "jpy" ? "3900" : "39"}
            className="field mt-1"
          />
        </div>
      </div>

      {shipped ? <div>
        <label htmlFor={`option-sku-${product.id}`} className="field-label">Inventory reference (SKU, optional)</label>
        <input id={`option-sku-${product.id}`} type="text" maxLength={MAX_SHIPPING_SKU} value={sku} onChange={event => setSku(event.target.value)} aria-describedby={`option-sku-help-${product.id}`} className="field mt-1" />
        <p id={`option-sku-help-${product.id}`} className="mt-1 text-sm text-ink-soft">Your code for this size or version. Its price ID stays the same; this does not set a stock quantity.</p>
      </div> : null}

      <div>
        <label htmlFor={`option-details-${product.id}`} className="field-label">
          What this one includes <span className="font-normal text-ink-soft">(optional, one per line)</span>
        </label>
        <textarea
          id={`option-details-${product.id}`}
          rows={4}
          maxLength={MAX_OPTION_DETAILS * (MAX_OPTION_DETAIL_LENGTH + 1)}
          value={details}
          onChange={(event) => setDetails(event.target.value)}
          placeholder={"Everything in 1 week\nA shopping list for each week\nSwap any recipe you dislike"}
          className="field mt-1"
        />
        <p className="mt-1 text-sm text-ink-soft">
          {`Up to ${MAX_OPTION_DETAILS} lines. When any price has some, your page shows the prices side by side, so the buyer sees what each one adds.`}
        </p>
      </div>

      <label htmlFor={`option-best-${product.id}`} className="flex min-h-11 cursor-pointer items-start gap-3 text-sm font-semibold text-ink">
        <input
          id={`option-best-${product.id}`}
          type="checkbox"
          checked={best}
          onChange={(event) => setBest(event.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-violet-brand"
        />
        <span>
          Recommend this one
          <span className="block font-normal text-ink-soft">
            Chosen when the page opens and marked “Recommended.” One per product: picking it here unpicks any other.
          </span>
        </span>
      </label>

      {error ? (
        <p
          role="alert"
          className="rounded-2xl bg-danger-soft px-4 py-3 text-sm font-semibold text-ink"
        >
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          aria-busy={busy} disabled={busy}
          className="btn btn-primary btn-sm"
        >
          {busy ? "Saving…" : submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="btn btn-secondary btn-sm"
        >
          Cancel
        </button>
      </div>
    </form>
  );

  return (
    <fieldset disabled={busy} aria-busy={busy} className="mt-3 min-w-0 rounded-2xl border-2 border-dashed border-ink/10 p-3">
      <legend className="sr-only">Product prices</legend>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-bold text-ink">
          {product.options.length === 0
            ? "One price, or several"
            : "What this is sold at"}
        </p>
        {product.options.length > 0 ? (
          <p className="text-sm text-ink-soft">
            {product.options.length} of {MAX_OPTIONS}
          </p>
        ) : null}
      </div>

      {product.options.length === 0 ? (
        <p className="mt-1 text-sm text-ink-soft">
          {shipped
            ? "Right now this sells at the one price above. Add sizes or versions — S, M, L, or signed and unsigned — each at its own price, and the buyer picks one before paying. Every one ships the same way."
            : opens
            ? "Right now this sells at the one price above. Add a second and the buyer picks — the course alone, or with a live Q&A — and every price opens it. A file or link on a price is what that one adds."
            : "Right now this sells at the one price above. Add a second and the buyer picks — one week or five, personal or commercial — and each one hands over its own file."}
        </p>
      ) : (
        <p className="mt-1 text-sm text-ink-soft">
          The buyer picks one of these. While they are here, the single price on
          the product above is not charged and not shown.
        </p>
      )}

      <ul className="mt-3 space-y-2">
        {product.options.map((option, index) => (
          <li key={option.id} className="rounded-2xl bg-sand p-3">
            {editingId === option.id ? (
              form(
                "Save",
                () =>
                  run(
                    { action: "edit", id: option.id, label, price, details, best, ...(shipped ? { sku } : {}) },
                    () => setEditingId(null),
                    "Price saved.",
                  ),
                () => {
                  setEditingId(null);
                  setError(null);
                },
              )
            ) : (
              <>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-bold text-ink">
                    {option.label}
                    {option.best ? (
                      <span className="ml-2 rounded-full bg-lilac px-2 py-0.5 text-xs font-bold text-violet-deep">Recommended</span>
                    ) : null}
                  </p>
                  <p className="font-semibold tabular-nums text-ink">
                    {formatMoney(option.priceCents, currency)}
                  </p>
                </div>

                {shipped && option.sku ? <p className="mt-1 break-all text-sm text-ink-soft">SKU: {option.sku}</p> : null}

                {option.details.length > 0 ? (
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-ink-soft">
                    {option.details.map((line, at) => (
                      <li key={at}>{line}</li>
                    ))}
                  </ul>
                ) : null}

                {!opens && !option.file && !option.link ? (
                  /*
                    Said here rather than discovered by a buyer. An option with
                    nothing behind it is left off the store page entirely, and
                    the creator is the one who can fix that.
                  */
                  <p className="mt-1 text-sm font-semibold text-danger">
                    Nothing to hand over yet, so this one is hidden from your
                    page.
                  </p>
                ) : null}

                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm font-bold">
                  <button
                    type="button"
                    onClick={() => {
                      setSku(option.sku ?? "");
                      setLabel(option.label);
                      setPrice(moneyField(option.priceCents, currency));
                      setDetails(option.details.join("\n"));
                      setBest(option.best);
                      setError(null);
                      setAdding(false);
                      setEditingId(option.id);
                    }}
                    className="text-ink-soft underline underline-offset-4 transition hover:text-violet-deep"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={busy || index === 0}
                    onClick={() =>
                      run({ action: "move", id: option.id, direction: "up" }, () => {})
                    }
                    className="inline-flex min-h-12 items-center text-ink-soft underline underline-offset-4 transition hover:text-violet-deep disabled:no-underline disabled:opacity-40"
                  >
                    Move up
                  </button>
                  <button
                    type="button"
                    disabled={busy || index === product.options.length - 1}
                    onClick={() =>
                      run(
                        { action: "move", id: option.id, direction: "down" },
                        () => {},
                      )
                    }
                    className="inline-flex min-h-12 items-center text-ink-soft underline underline-offset-4 transition hover:text-violet-deep disabled:no-underline disabled:opacity-40"
                  >
                    Move down
                  </button>
                  {removingId === option.id ? null : (
                    <button
                      type="button"
                      onClick={() => {
                        setRemovingId(option.id);
                        setError(null);
                      }}
                      className="inline-flex min-h-12 items-center text-ink-soft underline underline-offset-4 transition hover:text-danger"
                    >
                      Remove
                    </button>
                  )}
                </div>

                {shipped ? null : (
                <FileBlock
                  target={option}
                  busy={fileBusyId === option.id}
                  percent={percent}
                  error={
                    fileError && fileError.id === option.id
                      ? fileError.message
                      : null
                  }
                  onPick={(chosen) => onPick(option.id, chosen)}
                  onDetach={() => onDetach(option.id)}
                  onLink={(url) => onLink(option.id, url)}
                  onUnlink={() => onUnlink(option.id)}
                  membership={product.recurring !== null}
                />
                )}

                {removingId === option.id ? (
                  <div className="mt-2 rounded-2xl border-2 border-pink-brand/30 bg-white p-3">
                    <p className="text-sm text-ink-soft">
                      Remove <strong className="text-ink">{option.label}</strong>
                      {option.file
                        ? ". The file on it is deleted with it."
                        : ". Nothing else on the product changes."}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        aria-busy={busy} disabled={busy}
                        onClick={() =>
                          run(
                            { action: "remove", id: option.id },
                            () => setRemovingId(null),
                            "Price removed.",
                          )
                        }
                        className="btn btn-danger-solid btn-sm"
                      >
                        {busy ? "Removing…" : "Remove it"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setRemovingId(null)}
                        className="btn btn-secondary btn-sm"
                      >
                        Keep it
                      </button>
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </li>
        ))}
      </ul>

      {adding
        ? form(
            "Add this price",
            () =>
              run(
                { action: "add", id: product.id, label, price, details, best, ...(shipped ? { sku } : {}) },
                () => setAdding(false),
                "Price added.",
              ),
            () => {
              setAdding(false);
              setError(null);
            },
          )
        : product.options.length >= MAX_OPTIONS
          ? null
          : (
            <button
              type="button"
              onClick={() => {
                setSku("");
                setLabel("");
                setPrice("");
                setDetails("");
                setBest(false);
                setError(null);
                setEditingId(null);
                setAdding(true);
              }}
              className="btn btn-secondary btn-sm mt-2"
            >
              {product.options.length === 0
                ? "Sell it at several prices"
                : "Add another price"}
            </button>
          )}

      {error && !adding && !editingId ? (
        <p
          role="alert"
          className="mt-2 rounded-2xl bg-danger-soft px-4 py-3 text-sm font-semibold text-ink"
        >
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

/**
 * What something delivers: a product, or one price option of one.
 *
 * Both hold a file or a link the same way and under the same folder rule, so
 * they are edited by the same block rather than by two that drift apart.
 */
type Delivers = {
  id: string;
  file: ProductFile | null;
  link: string | null;
};

/** The file something delivers: what is there, and how to change it. */
function FileBlock({
  target,
  busy,
  percent,
  error,
  onPick,
  onDetach,
  onLink,
  onUnlink,
  membership = false,
}: {
  target: Delivers;
  busy: boolean;
  percent: number;
  error: string | null;
  onPick: (file: File) => void;
  onDetach: () => void;
  onLink: (url: string) => void;
  onUnlink: () => void;
  /** Sold as a membership: a file closes when it ends, a link cannot. */
  membership?: boolean;
}) {
  const studioHref = useStudioHref();
  const input = useRef<HTMLInputElement>(null);
  const [typing, setTyping] = useState(false);
  const [url, setUrl] = useState("");
  const file = target.file;
  const link = target.link;

  return (
    <div className="mt-3 rounded-2xl bg-white p-3">
      <input
        ref={input}
        type="file"
        accept={ACCEPT_ATTRIBUTE}
        className="hidden"
        onChange={(event) => {
          const chosen = event.target.files?.[0];
          event.target.value = "";
          if (chosen) onPick(chosen);
        }}
      />

      {busy ? (
        <div>
          <p className="text-sm font-bold text-ink">Sending the file…</p>
          <div
            className="mt-2 h-2 w-full overflow-hidden rounded-full bg-sand"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full rounded-full bg-gradient-to-r from-violet-brand to-sky-brand transition-all"
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="mt-1 text-sm text-ink-soft">{percent}%</p>
        </div>
      ) : file ? (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="text-sm font-bold text-ink">{file.name}</p>
            <p className="font-mono text-sm text-ink-soft">
              {readableSize(file.bytes)}
            </p>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm font-bold">
            <a
              href={studioHref(`/api/store/file/download?id=${encodeURIComponent(target.id)}`)}
              className="text-ink-soft underline underline-offset-4 transition hover:text-violet-deep"
            >
              Open it to check
            </a>
            <button
              type="button"
              onClick={() => input.current?.click()}
              className="text-ink-soft underline underline-offset-4 transition hover:text-violet-deep"
            >
              Replace it
            </button>
            <button
              type="button"
              onClick={onDetach}
              className="inline-flex min-h-12 items-center text-ink-soft underline underline-offset-4 transition hover:text-danger"
            >
              Take it off
            </button>
          </div>
          {membership ? (
            <p className="mt-2 text-xs text-ink-soft">
              Members download it only while their membership runs. When it ends, the download closes and they are shown a
              page to renew.
            </p>
          ) : null}
        </>
      ) : link ? (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="text-sm font-bold text-ink">
              {`Delivered from ${linkHost(link)}`}
            </p>
          </div>
          <p className="mt-1 break-all font-mono text-xs text-ink-soft">
            {link}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm font-bold">
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="text-ink-soft underline underline-offset-4 transition hover:text-violet-deep"
            >
              Open it to check
            <NewTab /></a>
            <button
              type="button"
              onClick={() => {
                setUrl(link);
                setTyping(true);
              }}
              className="text-ink-soft underline underline-offset-4 transition hover:text-violet-deep"
            >
              Change it
            </button>
            <button
              type="button"
              onClick={onUnlink}
              className="inline-flex min-h-12 items-center text-ink-soft underline underline-offset-4 transition hover:text-danger"
            >
              Take it off
            </button>
          </div>
          {membership ? (
            <p className="notice notice-warn mt-2 text-sm">
              A link cannot be taken back when a membership ends: whoever has the address keeps it. To close access when
              members stop paying, upload the file here instead, or turn off sharing where the link points.
            </p>
          ) : null}
        </>
      ) : (
        <>
          <p className="text-sm font-bold text-ink">
            Nothing on this yet
          </p>
          <p className="mt-1 text-sm text-ink-soft">
            {`Upload the file the buyer downloads, up to ${maxFileLabel()} \u2014 or point at where it already lives, if it is bigger than that or is not a file at all.`}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => input.current?.click()}
              className="btn btn-secondary btn-sm"
            >
              Choose the file
            </button>
            <button
              type="button"
              onClick={() => setTyping(true)}
              className="btn btn-secondary btn-sm"
            >
              Use a link instead
            </button>
          </div>
        </>
      )}

      {typing ? (
        <form
          className="mt-3"
          onSubmit={(event) => {
            event.preventDefault();
            onLink(url);
            setTyping(false);
          }}
        >
          <label
            htmlFor={`link-${target.id}`}
            className="field-label"
          >
            Where the buyer should be sent
          </label>
          <UrlField
            id={`link-${target.id}`}
            value={url}
            autoFocus
            onChange={setUrl}
            describedBy={`link-${target.id}-help`}
            className="field mt-1"
          />
          <p id={`link-${target.id}-help`} className="mt-1 text-sm text-ink-soft">
            A Google Drive folder, a private video page, a Notion page — anything
            with an https address. Check that anyone with the link can open it.
            {membership
              ? " A link cannot be taken back when a membership ends: a file uploaded here can, and closes by itself when a member stops paying."
              : ""}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="submit"
              className="btn btn-primary btn-sm"
            >
              Save the link
            </button>
            <button
              type="button"
              onClick={() => setTyping(false)}
              className="btn btn-secondary btn-sm"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {error ? (
        <p
          className="notice notice-error mt-2"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Above this many products, each opens on its own rather than all at once. */
const COLLAPSE_ABOVE = 3;
/** Above this many, the list gets a box to find one by name. */
const SEARCH_ABOVE = 6;

/** The few words that say what a closed row holds, so it need not be opened. */
function badges(product: Product): string[] {
  const out: string[] = [];
  if (product.hidden) out.push("Draft, not on your store");
  if (product.bundle) out.push(`Bundle of ${product.bundle.length}`);
  if (product.call) out.push("Call");
  if (product.course) out.push("Course");
  if (product.recurring) {
    out.push("Membership");
    if (product.recurring.trialDays) out.push(`${product.recurring.trialDays}-day trial`);
    if (product.recurring.payments) out.push(`${product.recurring.payments} ${intervalAdjective(product.recurring.interval)} payments`);
    if (product.intro) out.push(product.intro.count > 1 ? `Introductory price, ${product.intro.count} months` : "Introductory price");
    if (product.yearly) out.push("Or yearly");
  }
  if (product.pwyw) out.push("Pay what you want");
  if (product.options.length) out.push(`${product.options.length} prices`);
  if (product.shipping) out.push("Shipped");
  if (!isFree(product) && !product.call && !product.course && !product.bundle && !product.shipping && !product.file && !product.link && !product.options.some((o) => o.file || o.link)) {
    out.push("Nothing to hand over yet");
  }
  if (product.image) out.push(product.display === "preview" ? "Preview" : product.display === "callout" ? "Callout" : "Button");
  if (product.fields.length) out.push(`${product.fields.length} ${product.fields.length === 1 ? "question" : "questions"}`);
  if (product.stock !== null) out.push(`Limited to ${product.stock.toLocaleString("en-US")}`);
  return out;
}

/** The list of what the store offers, and every way to change it. */
/** The studio's list at one page, found by one search, on the store this page is for. */
function pageHref(page: number, query: string, sid: string): string {
  const params = new URLSearchParams();
  if (sid) params.set("store", sid);
  if (query) params.set("q", query);
  if (page > 1) params.set("pp", String(page));
  const search = params.toString();
  return `/studio${search ? `?${search}` : ""}#products`;
}

/**
 * Finding one product in a long list, and moving through it a page at a
 * time. A plain form and plain links: the search runs on the server over
 * every product's name, so nothing depends on which page is open.
 */
function PagedSearch({ paging, total }: { paging: ProductPaging; total: number }) {
  const { query, matches, from, size } = paging;
  const upTo = Math.min(from + size, matches);
  const sid = useStudioStore();
  return (
    <div className="mt-5">
      <form action="/studio#products" method="get" role="search" className="flex flex-wrap items-center gap-3">
        <label htmlFor="product-find" className="sr-only">
          Find a product by its name
        </label>
        <StoreField />
        <input
          id="product-find"
          type="search"
          name="q"
          defaultValue={query}
          maxLength={80}
          placeholder="Find a product by its name"
          className="field field-search min-w-[12rem] flex-1"
        />
        <button type="submit" className="btn btn-secondary btn-sm">
          Find
        </button>
        {query ? (
          <a href={pageHref(1, "", sid)} className="text-sm font-bold text-ink-soft underline underline-offset-4 hover:text-violet-deep">
            Show all
          </a>
        ) : null}
      </form>
      <p className="mt-2 text-sm text-ink-soft" role="status">
        {query
          ? matches === 0
            ? `Nothing on your store has “${query}” in its name.`
            : `${matches.toLocaleString("en-US")} ${matches === 1 ? "has" : "have"} “${query}” in the name. Showing ${from + 1}–${upTo}. Moving one moves it in the whole list.`
          : `Showing ${from + 1}–${upTo} of ${total.toLocaleString("en-US")}, in the order your store shows them.`}
      </p>
      <Pager paging={paging} />
    </div>
  );
}

/** Previous and next page of the studio's list, when there is more than one. */
function Pager({ paging }: { paging: ProductPaging }) {
  const sid = useStudioStore();
  if (paging.pages <= 1) return null;
  const link =
    "inline-flex min-h-[44px] items-center gap-1 rounded-full border border-line bg-white px-4 text-sm font-bold text-ink transition hover:border-violet-brand focus-visible:outline-2 focus-visible:outline-violet-brand";
  const off = "inline-flex min-h-[44px] items-center gap-1 rounded-full px-4 text-sm font-bold text-ink-mute opacity-50";
  return (
    <nav aria-label="Pages of your products" className="mt-3 flex items-center justify-between gap-3">
      {paging.page > 1 ? (
        <a href={pageHref(paging.page - 1, paging.query, sid)} rel="prev" className={link}>
          <span aria-hidden="true">&larr;</span> Previous
        </a>
      ) : (
        <span className={off} aria-hidden="true">&larr; Previous</span>
      )}
      <p className="text-sm font-semibold text-ink-soft" aria-current="page">{`Page ${paging.page} of ${paging.pages}`}</p>
      {paging.page < paging.pages ? (
        <a href={pageHref(paging.page + 1, paging.query, sid)} rel="next" className={link}>
          Next <span aria-hidden="true">&rarr;</span>
        </a>
      ) : (
        <span className={off} aria-hidden="true">Next &rarr;</span>
      )}
    </nav>
  );
}

const subscribeEditorReady = () => () => {};
const editorClientReady = () => true;
const editorServerReady = () => false;

export function ProductEditor({
  products,
  total: totalGiven,
  positions,
  paging = null,
  choices,
  named = {},
  notes = {},
  folder,
  imageFolder,
  handle,
  selling,
  testMode,
  email,
  currency = "usd",
  meetings = [],
  ai = { on: false, left: 0 },
  newComments = {},
  waitlists = {},
  preorders = {},
  mailAddress = "",
  cover = null,
  look = null,
  pairChoices = [],
  ownHosts = [],
}: {
  /** The products shown: every one, or one page of a long list. */
  products: Product[];
  /** How many products the store has in all. */
  total?: number;
  /** Where each product shown stands in the store's whole list, from 0. */
  positions?: Record<string, number>;
  paging?: ProductPaging | null;
  /** Every product another can offer in a box at checkout (lib/product-extras.ts). */
  choices?: BumpChoice[];
  /** The names of the products the ones shown offer at checkout now. */
  named?: Record<string, string>;
  /**
   * Per product, whichever of its extras buyers are not being shown, and why
   * (lib/extras-notes.ts). Worked out on the server, because the reason often
   * lies in a product that is not on this page.
   */
  notes?: Record<string, ExtraNotes>;
  folder: string;
  /** The store's own folder for product pictures (lib/store.ts imageFolder). */
  imageFolder: string;
  /** The store's address, for the link to each product's own page. */
  handle: string;
  /** The creator's sign-in address, which booking replies go to. */
  email: string;
  /** Whether this store can actually take a card right now. */
  selling: boolean;
  /** Whether the platform is pointed at Stripe's test mode. */
  testMode: boolean;
  /** What the store charges in: every price here is written in it. */
  currency?: Currency;
  /** The Google Calendar or Zoom accounts calls can make meetings on (lib/meet-connect.ts). */
  meetings?: MeetAccount[];
  /** Whether the writing help is on for this person, and what is left of the month (lib/ai.ts). */
  ai?: { on: boolean; left: number };
  /** Per course product, the comments under its lessons since its studio page was last opened. */
  newComments?: Record<string, number>;
  /** Per product with a waitlist, where it stands (lib/waitlist.ts). */
  waitlists?: Record<string, WaitlistView>;
  /** Each product's pre-orders, when it takes or took any (lib/preorders.ts). */
  preorders?: Record<string, PreorderView>;
  /** The store's postal address for email, offered for a launch email's foot. */
  mailAddress?: string;
  /** The store's color, letters, name and language, for the cover maker (components/cover-maker.tsx). */
  cover?: (CoverLook & { language: LanguageCode }) | null;
  /** The store's look, for the preview of a product's own words. */
  look?: StoreLook | null;
  /** The store's published products, by name: what a product's "Goes well with" can pick (lib/store-collections.ts). */
  pairChoices?: { id: string; title: string }[];
  /** The store's own domain, if it has one: not warned as "another site" in what the creator writes (493 [DE2]). */
  ownHosts?: string[];
}) {
  const router = useRouter();
  const sid = useStudioStore();
  const editorReady = useSyncExternalStore(subscribeEditorReady, editorClientReady, editorServerReady);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  // The form as it was opened: leaving with changes to it asks first (487 [IT4], item 6), an untouched one never.
  const [opened, setOpened] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useLeaveGuard((adding || editingId !== null) && JSON.stringify(draft) !== JSON.stringify(opened) && !busy);
  // A new price on a product buyers can see is shown, old and new, before it is saved (487 [IT4], pattern 8): the id under review.
  const [priceReview, setPriceReview] = useState<string | null>(null);
  function changePrice(productId: string) {
    setPriceReview(null);
    requestAnimationFrame(() => document.getElementById(`product-price-${productId}`)?.focus());
  }
  const [fileBusyId, setFileBusyId] = useState<string | null>(null);
  const [percent, setPercent] = useState(0);
  const [fileError, setFileError] = useState<{ id: string; message: string } | null>(
    null,
  );
  /**
   * What the last save stopped buyers being shown, one sentence per thing.
   * Empty on every ordinary save, which is nearly all of them.
   */
  const [silenced, setSilenced] = useState<string[]>([]);

  const total = totalGiven ?? products.length;
  const full = total >= MAX_PRODUCTS;
  const offerable = choices ?? bumpChoices(products);
  const at = (product: Product) => positions?.[product.id] ?? products.indexOf(product);
  // A short list is shown open, as it always was. A long one is shown as rows
  // that open one at a time, and a list longer than a page is shown a page
  // at a time (lib/catalog.ts, studioShelf), so two thousand products stay a
  // page and not a scroll through two thousand forms.
  const [openIds, setOpenIds] = useState<Set<string>>(
    () => new Set(total <= COLLAPSE_ABOVE ? products.map((product) => product.id) : []),
  );
  const [query, setQuery] = useState("");
  const [loadingAbout, setLoadingAbout] = useState(false);
  // Which opening of the form the description being read belongs to, and
  // whether it could not be read: then saving leaves the stored one alone.
  const aboutFor = useRef(0);
  const [aboutUnread, setAboutUnread] = useState(false);
  // A long list is searched on the server (paging); a short one right here.
  const shown = query.trim() && !paging
    ? products.filter((product) => product.title.toLowerCase().includes(query.trim().toLowerCase()))
    : products;

  function toggle(id: string, open?: boolean) {
    setOpenIds((current) => {
      const next = new Set(current);
      if (open ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  /** Tells the store which file a product delivers, once it is really there. */
  async function attach(payload: Record<string, unknown>): Promise<string | null> {
    try {
      const response = await fetch("/api/store/file/attach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as { ok?: boolean; error?: string };
      if (data.ok) return null;
      return MESSAGES[data.error ?? ""] ?? MESSAGES.server_error;
    } catch {
      return MESSAGES.server_error;
    }
  }

  /**
   * Sends one file straight from this browser to the private store.
   *
   * It never passes through our server, which is why a large file is possible
   * at all. The size and the kind are checked here so an impossible upload
   * fails in a second rather than after a long climb, and checked again by the
   * signature on the way in, because a check in a browser is a courtesy and
   * not a defence.
   */
  async function upload(id: string, chosen: File) {
    setFileError(null);
    if (chosen.size > MAX_FILE_BYTES) {
      setFileError({ id, message: MESSAGES.too_big });
      return;
    }

    setFileBusyId(id);
    setPercent(0);
    try {
      // To the file store that takes new files (lib/sold-file-upload.ts), in
      // parts, so a dropped connection costs one part and not the upload.
      const pathname = await uploadSoldFile(chosen, { folder, ownerId: id }, setPercent);

      const problem = await attach({
        id,
        pathname,
        name: chosen.name,
      });
      if (problem) {
        setFileError({ id, message: problem });
        return;
      }
      router.refresh();
    } catch (thrown) {
      setFileError({ id, message: MESSAGES[uploadReason(thrown)] ?? MESSAGES.server_error });
    } finally {
      setFileBusyId(null);
      setPercent(0);
    }
  }

  async function detach(id: string) {
    setFileError(null);
    setFileBusyId(id);
    const problem = await attach({ id, detach: true });
    setFileBusyId(null);
    if (problem) {
      setFileError({ id, message: problem });
      return;
    }
    router.refresh();
  }

  async function linkTo(id: string, url: string) {
    setFileError(null);
    setFileBusyId(id);
    const { problem } = await send({ action: "link", id, link: url }, currency);
    setFileBusyId(null);
    if (problem) {
      setFileError({ id, message: problem });
      return;
    }
    router.refresh();
  }

  async function unlink(id: string) {
    setFileError(null);
    setFileBusyId(id);
    const { problem } = await send({ action: "unlink", id }, currency);
    setFileBusyId(null);
    if (problem) {
      setFileError({ id, message: problem });
      return;
    }
    router.refresh();
  }

  async function run(payload: Record<string, unknown>, done: () => void, confirmation?: string) {
    setBusy(true);
    setError(null);
    const { problem, quiet } = await send(payload, currency);
    setBusy(false);
    if (problem) {
      setError(problem);
      return;
    }
    done();
    // Kept on the page rather than in a toast: each line names a product to go
    // and change, which is not something to read in three seconds.
    setSilenced(quiet);
    if (confirmation) toast(confirmation);
    router.refresh();
  }

  function startAdding() {
    aboutFor.current += 1;
    setLoadingAbout(false);
    setAboutUnread(false);
    setDraft(EMPTY);
    setOpened(EMPTY);
    setError(null);
    setEditingId(null);
    setAdding(true);
  }

  async function startEditing(product: Product) {
    const form: Draft = {
      title: product.title,
      summary: product.summary,
      price: moneyField(product.priceCents, currency),
      every: product.recurring ? product.recurring.interval : "",
      trial: product.recurring?.trialDays ? String(product.recurring.trialDays) : "",
      payments: product.recurring?.payments ? String(product.recurring.payments) : "",
      introPrice: product.intro ? moneyField(product.intro.cents, currency) : "",
      introCount: String(product.intro?.count ?? 1),
      yearlyPrice: product.yearly ? moneyField(product.yearly.cents, currency) : "",
      pwyw: product.pwyw !== null,
      suggested: product.pwyw ? moneyField(product.pwyw.suggestedCents, currency) : "",
      about: "",
    };
    setDraft(form);
    setOpened(form);
    setPriceReview(null);
    setError(null);
    setAdding(false);
    setEditingId(product.id);
    toggle(product.id, true);
    const opening = ++aboutFor.current;
    setAboutUnread(false);
    setLoadingAbout(false);
    if (!product.about) return;
    // The long description lives in a record of its own; it is read when the
    // form opens, and the box waits for it so nothing is saved over it. An
    // answer that arrives after another product was opened is dropped.
    setLoadingAbout(true);
    let about: string | null = null;
    try {
      const response = await fetch(`/api/store/product?about=${encodeURIComponent(product.id)}`);
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; about?: string };
      if (data.ok && typeof data.about === "string") about = data.about;
    } catch {
      about = null;
    }
    if (aboutFor.current !== opening) return;
    setLoadingAbout(false);
    if (about !== null) {
      const read = about;
      setDraft((current) => ({ ...current, about: read }));
      setOpened((current) => ({ ...current, about: read }));
    } else {
      setAboutUnread(true);
      setError("Your description could not be read just now, so it is not shown. Anything else you change is saved and the description is kept as it is.");
    }
  }

  const quiet = "inline-flex min-h-12 items-center text-ink-soft underline underline-offset-4 transition hover:text-violet-deep disabled:no-underline disabled:opacity-40";

  return (
    <StoreCurrency value={currency}>
    <AiOn value={ai}>
    <div data-product-editor className="card mt-8 p-6 sm:p-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="text-lg font-semibold tracking-[-0.02em] text-ink">
          What you are selling
        </p>
        <p className="text-sm text-ink-soft">
          {total === 1 ? "1 product" : `${total.toLocaleString("en-US")} products`}
        </p>
      </div>

      {/* Keep creation ahead of product rows so expanding rows cannot displace its pointer target. */}
      {adding ? (
        <div className="mt-5">
          <ProductForm
            ownHosts={ownHosts}
            preview={look && cover ? { look, language: cover.language } : null}
            draft={draft}
            setDraft={setDraft}
            busy={busy}
            error={error}
            submitLabel="Add it"
            onSubmit={() =>
              run(
                { action: "add", ...payloadOf(draft) },
                () => {
                  setAdding(false);
                  setDraft(EMPTY);
                  // A new product goes to the end of the list: on a long one,
                  // the page it lands on is opened so it can be seen.
                  if (paging) router.push(pageHref(Math.ceil((total + 1) / paging.size), "", sid));
                },
                "Product added.",
              )
            }
            onCancel={() => {
              setAdding(false);
              setError(null);
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          disabled={full || !editorReady}
          onClick={startAdding}
          className="btn btn-primary mt-5"
        >
          Add something to sell
        </button>
      )}

      {total === 0 ? (
        <p className="mt-2 text-ink-soft">
          Your page is live and it is empty. Add the first thing and it shows up
          on it right away.
        </p>
      ) : null}

      {paging ? (
        <PagedSearch paging={paging} total={total} />
      ) : null}
      {!paging && products.length > SEARCH_ABOVE ? (
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <label htmlFor="product-search" className="sr-only">
            Find a product by its name
          </label>
          <input
            id="product-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a product by its name"
            className="field field-search min-w-[12rem] flex-1"
          />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() =>
              setOpenIds(openIds.size > 0 ? new Set() : new Set(products.map((product) => product.id)))
            }
          >
            {openIds.size > 0 ? "Close all" : "Open all"}
          </button>
        </div>
      ) : null}
      {query.trim() && !paging ? (
        <p className="mt-2 text-sm text-ink-soft" role="status">
          {shown.length === 0
            ? "Nothing on your store has that in its name."
            : `${shown.length} of ${products.length} shown. Moving one moves it in the whole list.`}
        </p>
      ) : null}

      <ul className="mt-5 space-y-3">
        {shown.map((product) => {
          const index = at(product);
          const open = openIds.has(product.id) || editingId === product.id;
          const panel = `product-panel-${product.id}`;
          return (
          <li
            key={product.id}
            className="rounded-2xl border border-line bg-paper p-4"
          >
            {editingId === product.id ? (() => {
              // Only a product bought once, at one price, with no lowest price chosen by the buyer: there the field is what buyers pay.
              const newPrice = readMoney(draft.price, currency);
              const priceChanged = !product.hidden && !product.options.length && !draft.every && !draft.pwyw && newPrice !== null && newPrice !== product.priceCents;
              const save = () => {
                const payload = payloadOf(draft);
                if (aboutUnread && !draft.about) delete payload.about;
                run(
                  { action: "edit", id: product.id, ...payload },
                  () => {
                    setEditingId(null);
                    setPriceReview(null);
                  },
                  "Product saved.",
                );
              };
              return (
              <>
              <ProductForm
                ownHosts={ownHosts}
                preview={look && cover ? { look, language: cover.language } : null}
                draft={draft}
                setDraft={(next) => {
                  setDraft(next);
                  if (next.price !== draft.price) setPriceReview(null);
                }}
                busy={busy}
                error={error}
                submitLabel="Save"
                product={product}
                loadingAbout={loadingAbout}
                onSubmit={() => {
                  if (loadingAbout) return;
                  if (priceChanged && priceReview !== product.id) {
                    setPriceReview(product.id);
                    requestAnimationFrame(() => document.getElementById(`product-${product.id}-price-review-title`)?.focus());
                    return;
                  }
                  save();
                }}
                onCancel={() => {
                  setEditingId(null);
                  setPriceReview(null);
                  setError(null);
                }}
              />
              {priceReview === product.id && priceChanged && newPrice !== null ? (
                <div className="mt-3 rounded-[var(--r-md)] bg-sand p-4 text-sm text-ink">
                  <h3 id={`product-${product.id}-price-review-title`} tabIndex={-1} className="font-semibold">Check the new price</h3>
                  {/* A summary list (GOV.UK "Check answers"): the price buyers see changes as soon as it is saved. */}
                  <dl className="mt-2 divide-y divide-line">
                    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2">
                      <dt className="basis-full font-semibold sm:basis-28 sm:shrink-0">Price</dt>
                      <dd className="min-w-0 basis-full break-words sm:basis-0 sm:flex-1">{`${formatMoney(product.priceCents, currency)} now, ${formatMoney(newPrice, currency)} once you save.`}</dd>
                      <dd><button type="button" className="inline-flex min-h-11 items-center font-bold underline underline-offset-4" onClick={() => changePrice(product.id)}>Change<span className="sr-only"> price</span></button></dd>
                    </div>
                  </dl>
                  <p className="mt-2">Your store shows the new price as soon as you save.</p>
                  {/* The confirmation is here, after what it confirms, so the reading and the focus order end on it. */}
                  <button type="button" className="btn btn-primary btn-sm mt-3" disabled={busy} aria-busy={busy} onClick={save}>
                    Yes, save the new price
                  </button>
                </div>
              ) : null}
              </>
              );
            })() : (
              <>
                <div className="flex items-start gap-3">
                  {product.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={imageUrl(product.image)}
                      alt=""
                      width={product.image.width}
                      height={product.image.height}
                      className="mt-0.5 h-11 w-11 shrink-0 rounded-lg object-cover ring-1 ring-line"
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => toggle(product.id)}
                        aria-expanded={open}
                        aria-controls={panel}
                        className="group -m-1 flex min-h-11 min-w-0 items-baseline gap-2 rounded-lg p-1 text-left font-bold text-ink focus-visible:outline-2 focus-visible:outline-violet-brand"
                      >
                        <span
                          aria-hidden="true"
                          className={`inline-block text-ink-soft transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
                        >
                          ›
                        </span>
                        <span className="min-w-0 group-hover:underline group-hover:underline-offset-4">{product.title}</span>
                      </button>
                      <p className="font-semibold tabular-nums text-ink">
                        {isFree(product)
                          ? "Free"
                          : product.recurring
                            ? `${formatMoney(product.priceCents, currency)} ${everyLabel(product.recurring.interval)}`
                            : product.pwyw
                              ? `${formatMoney(product.priceCents, currency)}+`
                              : formatMoney(product.priceCents, currency)}
                      </p>
                    </div>
                    <p className="mt-1 flex flex-wrap gap-1.5 text-xs font-semibold text-ink-soft">
                      {badges(product).map((badge) => (
                        <span key={badge} className="rounded-full bg-sand px-2 py-0.5">
                          {badge}
                        </span>
                      ))}
                    </p>
                  </div>
                </div>

                {open && product.summary ? (
                  <p className="mt-2 text-sm text-ink-soft">
                    {product.summary}
                  </p>
                ) : null}

                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm font-bold">
                  <button
                    type="button"
                    onClick={() => startEditing(product)}
                    className={quiet}
                  >
                    Edit
                  </button>
                  {product.hidden ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        run({ action: "visibility", id: product.id, hidden: false }, () => {}, "Published. It is on your store now.")
                      }
                      className="font-bold text-violet-deep underline underline-offset-4 transition hover:text-violet-ink disabled:opacity-40"
                    >
                      Publish it
                    </button>
                  ) : (
                    <>
                      <a href={`/@${handle}/p/${productSegment(product)}`} target="_blank" rel="noopener noreferrer" className={quiet}>
                        Its page
                      <NewTab /></a>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          run({ action: "visibility", id: product.id, hidden: true }, () => {}, "Taken off your store. It is kept here as a draft.")
                        }
                        className={quiet}
                      >
                        Unpublish
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    disabled={busy || index === 0}
                    onClick={() =>
                      run(
                        { action: "move", id: product.id, direction: "up" },
                        () => {},
                      )
                    }
                    className={quiet}
                  >
                    Move up
                  </button>
                  <button
                    type="button"
                    disabled={busy || index === total - 1}
                    onClick={() =>
                      run(
                        { action: "move", id: product.id, direction: "down" },
                        () => {},
                      )
                    }
                    className={quiet}
                  >
                    Move down
                  </button>
                  {total > 3 ? (
                    <>
                      <button
                        type="button"
                        disabled={busy || index === 0}
                        onClick={() => run({ action: "move", id: product.id, direction: "top" }, () => {}, "Moved to the top.")}
                        className={quiet}
                      >
                        To the top
                      </button>
                      <button
                        type="button"
                        disabled={busy || index === total - 1}
                        onClick={() => run({ action: "move", id: product.id, direction: "bottom" }, () => {}, "Moved to the end.")}
                        className={quiet}
                      >
                        To the end
                      </button>
                    </>
                  ) : null}
                  {removingId === product.id ? null : (
                    <button
                      type="button"
                      onClick={() => {
                        setRemovingId(product.id);
                        setError(null);
                      }}
                      className="inline-flex min-h-12 items-center text-ink-soft underline underline-offset-4 transition hover:text-danger"
                    >
                      Remove
                    </button>
                  )}
                </div>

                {removingId === product.id ? (
                  <div className="mt-3 rounded-2xl border-2 border-pink-brand/30 bg-white p-4">
                    <p className="text-sm text-ink-soft">
                      Remove{" "}
                      <strong className="text-ink">{product.title}</strong> from
                      your store. Its files, picture, description, page, reviews
                      and any course lessons are deleted with it and cannot be
                      brought back; sales already made stay in your Stripe account.
                      {product.hidden ? null : " To take it off your store but keep it, unpublish it instead."}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        aria-busy={busy} disabled={busy}
                        onClick={() =>
                          run(
                            { action: "remove", id: product.id },
                            () => setRemovingId(null),
                            "Product removed.",
                          )
                        }
                        className="btn btn-danger-solid btn-sm"
                      >
                        {busy ? "Removing…" : "Yes, remove it"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setRemovingId(null)}
                        className="btn btn-ghost btn-sm"
                      >
                        Keep it
                      </button>
                    </div>
                  </div>
                ) : null}

                {open ? (
                <div id={panel}>
                <ProductImageEditor product={product} folder={imageFolder} cover={cover} />

                {/*
                  With price options there is nothing to attach to the product
                  itself: each option delivers its own thing, and a file here
                  would be one nobody is ever sent. So the block moves inside
                  the options rather than sitting above them unused.
                */}
                {product.course || product.bundle || product.shipping ? null : <CallEditor product={product} email={email} meetings={meetings} />}
                {product.call?.kind === "weekly" && product.call.seats === 1 ? <TeamEventEditor product={product} /> : null}
                {product.call?.kind === "weekly" ? (
                  <PackageEditor productId={product.id} singleCents={product.priceCents} currency={currency} initial={product.callPackage ?? null} />
                ) : null}
                {product.call || product.bundle || product.podcast || product.shipping ? null : <CourseToggle product={product} newComments={newComments[product.id] ?? 0} />}
                {product.call || product.bundle || product.course || product.shipping ? null : <PodcastToggle product={product} />}
                {product.priceCents > 0 && !product.hidden ? (
                  <WaitlistPanel
                    productId={product.id}
                    initial={waitlists[product.id] ?? null}
                    suggestedAddress={mailAddress}
                    preorders={preorders[product.id] ?? null}
                    preorderBlocked={preorderProblem(product)}
                    hasContent={hasContent(product)}
                    price={formatMoney(product.priceCents, currency)}
                  />
                ) : null}
                {product.call || product.course || product.shipping ? null : <BundleToggle product={product} />}
                {/* A physical product the creator ships (lib/shipping.ts), on one that hands over nothing else. */}
                <ShippingEditor product={product} />
                {/* Shipped at several prices: sizes or versions, each shipped the same way. */}
                {product.shipping ? (
                  <OptionsBlock
                    product={product}
                    fileBusyId={fileBusyId}
                    percent={percent}
                    fileError={fileError}
                    onPick={upload}
                    onDetach={detach}
                    onLink={linkTo}
                    onUnlink={unlink}
                  />
                ) : null}

                {product.call || product.course || product.bundle || product.shipping ? null : (
                <>
                {product.options.length === 0 ? (
                  <FileBlock
                    target={product}
                    busy={fileBusyId === product.id}
                    percent={percent}
                    error={
                      fileError && fileError.id === product.id
                        ? fileError.message
                        : null
                    }
                    onPick={(chosen) => upload(product.id, chosen)}
                    onDetach={() => detach(product.id)}
                    onLink={(url) => linkTo(product.id, url)}
                    onUnlink={() => unlink(product.id)}
                    membership={product.recurring !== null}
                  />
                ) : null}

                {/* Several prices would put a price on something free, and a chosen price is chosen once. */}
                {(isFree(product) || product.pwyw) && product.options.length === 0 ? null : (
                <OptionsBlock
                  product={product}
                  fileBusyId={fileBusyId}
                  percent={percent}
                  fileError={fileError}
                  onPick={upload}
                  onDetach={detach}
                  onLink={linkTo}
                  onUnlink={unlink}
                />
                )}
                <PdfStampToggle product={product} />
                <PdfPreviewToggle product={product} />
                <LicenceKeyEditor product={product} handle={handle} />
                </>
                )}

                {/*
                  A course or private podcast at several prices: each opens it,
                  and a file or link on one is what that one adds. Not for one
                  sold as a membership, which charges one amount each time.
                */}
                {(product.course || product.podcast) && !product.recurring && !isFree(product) && !product.pwyw ? (
                  <OptionsBlock
                    product={product}
                    fileBusyId={fileBusyId}
                    percent={percent}
                    fileError={fileError}
                    onPick={upload}
                    onDetach={detach}
                    onLink={linkTo}
                    onUnlink={unlink}
                  />
                ) : null}

                <CheckoutExtras product={product} choices={offerable} named={named} notes={notes[product.id]} />
                {!product.hidden ? <PairsEditor productId={product.id} initial={product.pairs ?? []} choices={pairChoices} /> : null}
                <div className="mt-2">
                  <CheckoutFieldsEditor product={product} />
                </div>
                <ProductUpdateBox product={product} />
                </div>
                ) : null}
              </>
            )}
          </li>
          );
        })}
      </ul>
      {paging ? <Pager paging={paging} /> : null}

      {full && !adding ? (
        <p className="mt-3 text-sm text-ink-soft">
          {`Your store is holding ${MAX_PRODUCTS.toLocaleString("en-US")} products, the most it can list. Remove one to add another.`}
        </p>
      ) : null}

      {error && !adding && editingId === null && removingId === null ? (
        <p
          className="notice notice-error mt-3"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {/*
        What the save just silenced. Every one of these is a change to some
        other product than the one the creator was looking at, which is why it
        has to be said here and not left to be noticed: a checkout box that
        offered the product whose price came down, an offer after paying, a
        payment plan a raised price outgrew. It stays until it is dismissed,
        because each line names a product to go and change.
      */}
      {silenced.length ? (
        <div className="notice notice-warn mt-3" role="status">
          <p className="font-semibold">
            {silenced.length === 1
              ? "That change stopped buyers being shown one thing:"
              : `That change stopped buyers being shown ${silenced.length} things:`}
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {silenced.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <button
            type="button"
            className="mt-2 text-sm font-bold underline underline-offset-4"
            onClick={() => setSilenced([])}
          >
            Got it
          </button>
        </div>
      ) : null}

      {/*
        Three states, because there are three truths and the wrong one is a
        lie the moment the other becomes true. A line hard-coded to "nobody
        can pay you" goes stale the hour Stripe clears an account; a line
        hard-coded to "you can be paid" is worse, because somebody sets a
        price on it.
      */}
      <p className="mt-5 rounded-2xl bg-sand px-4 py-3 text-sm text-ink-soft">
        {!selling ? (
          <>
            <strong className="text-ink">Nobody can pay you yet.</strong> What
            you write here is on your page the moment you save it, with the
            price, and the page says plainly that it cannot take a payment.
          </>
        ) : testMode ? (
          <>
            <strong className="text-ink">
              Your page can take a card, in Stripe&apos;s test mode.
            </strong>{" "}
            What you write here is on your page the moment you save it, and the
            checkout on it is real — but it is running against Stripe in test
            mode, so no real money moves and no real card is charged.
          </>
        ) : (
          <>
            <strong className="text-ink">
              Your page can take a card for this.
            </strong>{" "}
            What you write here is on your page the moment you save it, and a
            buyer can pay for it right away, on your own Stripe account.
            {feeWords(COMMISSION_LIVE).editor}
          </>
        )}{" "}
        Your file is kept private to your store, and it is never named or
        linked on the public page.
      </p>
    </div>
    </AiOn>
    </StoreCurrency>
  );
}
