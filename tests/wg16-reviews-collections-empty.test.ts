/**
 * 656 [WG16], unit 10: the review summaries and the collections editor draw
 * their empty lists with the studio's shared empty state, not a bare line.
 * The reviews action jumps to "Asking for reviews" on the same page and is
 * drawn only for a role that can switch the email on; the collections action
 * The collections card has no action of its own: its "Add a collection" button is right below (Claude 6 on #3167,
 * LOW 2), and "No collections yet" shows only when the store has none saved and none being added (LOW 1: an unsaved
 * removal leaves a saved collection live). The reviews sentence says what is true: a product shows once reviewed, and
 * a summary needs MIN_SUMMARY_REVIEWS reviews with words and is made by the creator (LOW 3).
 * The one-line hint inside a single collection row stays a line.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReviewAiSummaries } from "@/components/review-ai-summaries";
import { MIN_SUMMARY_REVIEWS } from "@/lib/review-ai-summary-rules";
import { done, is, part } from "./check";

const read = (path: string) => readFileSync(path, "utf8");
const summaries = read("components/review-ai-summaries.tsx");
const editor = read("components/collections-editor.tsx");
const reviewsPage = read("app/studio/reviews/page.tsx");

part("Review summaries: shared empty state");
is("imports StudioEmptyState", summaries.includes('import { StudioEmptyState } from "@/components/empty-state";'), true);
is("old bare line is gone", summaries.includes('<p className="mt-2 text-sm text-ink-soft">No product has reviews yet.</p>'), false);
is(
  "new empty state with the action only for who can use it",
  summaries.includes(
    '<StudioEmptyState title="No product has reviews yet" body={`Each product shows here once buyers review it. A summary needs at least ${MIN_SUMMARY_REVIEWS} reviews with words, and you make it when you are ready.`} action={canAsk ? { href: "#asking-for-reviews", label: "Ask buyers for a review" } : undefined} className="mt-3" />',
  ),
  true,
);
// Drawn, not only matched in the source (Claude 6's note on #3167).
const none = renderToStaticMarkup(createElement(ReviewAiSummaries, { products: [], now: 2_000_000_000, canAsk: true }));
is("rendered: the heading, the true sentence and the jump", none.includes(">No product has reviews yet<") && none.includes(`A summary needs at least ${MIN_SUMMARY_REVIEWS} reviews with words, and you make it when you are ready.`) && none.includes('href="#asking-for-reviews"'), true);
is("rendered: no promise that a summary appears on its own", none.includes("A summary appears here"), false);
is("the page passes who can switch the email on", reviewsPage.includes('<ReviewAiSummaries products={aiSummaries} now={Math.floor(now / 1000)} canAsk={can(view.role, "settings")} />'), true);
is("the jump target exists on the page", reviewsPage.includes('id="asking-for-reviews"'), true);

part("Collections editor: shared empty state");
is("imports StudioEmptyState", editor.includes('import { StudioEmptyState } from "@/components/empty-state";'), true);
is("old bare no-products line is gone", editor.includes('<p className="mt-4 text-sm text-ink-soft">Publish a product and you can start a collection.</p>'), false);
is(
  "no products: shared empty state without an action",
  editor.includes('<StudioEmptyState title="No products to group yet" body="Publish a product and you can start a collection." className="mt-4" />'),
  true,
);
is(
  "no collections: shared empty state with no action, the add button being right below",
  editor.includes(
    ') : saved.length === 0 ? (\n            <StudioEmptyState title="No collections yet" body="A collection groups products under one name and gets a page of its own." className="mt-5" />\n          ) : null}',
  ),
  true,
);
is("no link that only moves the focus to the button below", editor.includes("Add the first collection") || editor.includes('href: "#add-collection"'), false);
is("the list is drawn only when there are collections", editor.includes("{rows.length > 0 ? ("), true);
is("the per-row hint stays a line", editor.includes('<p className="mt-1 text-sm text-ink-soft">Nothing yet. Add a product below.</p>'), true);

done();
