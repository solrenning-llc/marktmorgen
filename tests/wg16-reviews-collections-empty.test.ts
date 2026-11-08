/**
 * 656 [WG16], unit 10: the review summaries and the collections editor draw
 * their empty lists with the studio's shared empty state, not a bare line.
 * The reviews action jumps to "Asking for reviews" on the same page and is
 * drawn only for a role that can switch the email on; the collections action
 * jumps to the "Add a collection" button, drawn only when it can be used.
 * The one-line hint inside a single collection row stays a line.
 */
import { readFileSync } from "node:fs";
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
    '<StudioEmptyState title="No product has reviews yet" body="A summary appears here for each product once buyers review it." action={canAsk ? { href: "#asking-for-reviews", label: "Ask buyers for a review" } : undefined} className="mt-3" />',
  ),
  true,
);
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
  "no collections: shared empty state with a jump drawn only when the button works",
  editor.includes(
    '<StudioEmptyState title="No collections yet" body="A collection groups products under one name and gets a page of its own." action={unavailable ? undefined : { href: "#add-collection", label: "Add the first collection" }} className="mt-5" />',
  ),
  true,
);
is("the jump target exists on the add button", editor.includes('id="add-collection"'), true);
is("the list is drawn only when there are collections", editor.includes("{rows.length > 0 ? ("), true);
is("the per-row hint stays a line", editor.includes('<p className="mt-1 text-sm text-ink-soft">Nothing yet. Add a product below.</p>'), true);

done();
