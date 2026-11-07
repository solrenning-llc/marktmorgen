import type { PageAction } from "@/components/sales-blocks";

/**
 * What a draft product's own page adds when its owner or a team member who
 * may edit products previews it (app/[handle]/p/[product]/page.tsx,
 * lib/draft-view.ts previewsDrafts; 601 [KB22] U7). The words are the
 * studio's, in plain US English and marked so, whatever the store's
 * language: the people reading them are the store's own team, not buyers.
 *
 * Nothing here can be pressed except the way back to the studio.
 */

const STUDIO_PRODUCTS = "/studio#products";

/**
 * Hides the store's chat or Store assistant, which the store's layout draws in
 * a corner of every page (app/[handle]/layout.tsx, data-store-corner): nobody
 * on the team spends the assistant's replies or writes to the inbox from a
 * draft. Hidden with display: none, so it is out of the page for a screen
 * reader and the keyboard too. React puts the rule in the document's head.
 */
const HIDE_CORNER = "[data-store-corner]{display:none!important}";

/** The notice at the top of the preview, in a landmark of its own named "Preview". */
export function DraftPreviewBar() {
  return (
    <>
      <style href="draft-preview-corner" precedence="default">
        {HIDE_CORNER}
      </style>
      <section lang="en-US" aria-label="Preview" className="st-note relative mx-auto mt-4 w-[calc(100%-2rem)] max-w-2xl text-base leading-relaxed">
        <p>
          <strong>Preview.</strong> This product is a draft. Only you and your team can see this page. Buyers cannot find it. Buying is
          off here, and nothing on this page is counted or emailed.
        </p>
        <p className="mt-2">
          <a href={STUDIO_PRODUCTS} className="st-footer-link inline-flex min-h-11 items-center font-semibold underline underline-offset-4">
            Back to your products in the studio
          </a>
        </p>
      </section>
    </>
  );
}

/**
 * Where the buy box is on the page buyers will see: the button drawn as
 * they will see it, never pressed (no form, no link), with a line that says
 * so. Where buyers would see no button (sold out, not on sale), they see
 * the same words here.
 */
export function DraftPreviewBuy({ action, label }: { action: PageAction; label: string }) {
  return (
    <div className="mt-2">
      <p lang="en-US" className="st-note text-sm">
        <strong>Buy button preview.</strong> Buyers see a working button here once you publish. It does nothing on this preview.
      </p>
      {action.kind === "none" ? (
        <p className="st-muted mt-3 text-sm font-semibold">{action.text}</p>
      ) : (
        <span className="btn st-btn btn-lg mt-3 w-full">{label}</span>
      )}
    </div>
  );
}

/** Drawn instead of the preview when the studio's requests for this window are used up: nothing of the draft is read. */
export function DraftPreviewRefused({ message }: { message: string }) {
  return (
    <main id="content" lang="en-US" className="mx-auto max-w-xl px-4 py-16 text-base leading-relaxed">
      <h1 className="font-display text-2xl font-semibold">Preview not available</h1>
      <p className="mt-4">{message}</p>
      <p className="mt-4">
        <a href={STUDIO_PRODUCTS} className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4">
          Back to your products in the studio
        </a>
      </p>
    </main>
  );
}
