/**
 * Rule 23 (CX-123), found while doing 656 [WG16] unit 11: the studio's site
 * page editor (app/studio/site/page.tsx) read the chosen page with readPage,
 * which answers an empty page for a reply it cannot read, and on top of that
 * caught a failed read as an empty page. The editor then opened blank, and
 * saving it would have written an empty page over the creator's blocks.
 * Now the page is read with readPageExact: only Redis's own "no such key" is a
 * new, empty page; a reply that cannot be read shows a status note and no
 * editor, so nothing can be saved over a page nobody could read.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const page = readFileSync("app/studio/site/page.tsx", "utf8");

part("The chosen page is read exactly");
is("readPageExact is used", page.includes('import { readPageExact } from "@/lib/sales-page-store";'), true);
is("the forgiving reader is gone from this page", /\breadPage\(/.test(page), false);
is("a failed read is never turned into an empty page", page.includes(".catch(() => ({ ...EMPTY_PAGE, blocks: [] }))"), false);
is("only Redis's own empty answer is a new page", page.includes("kept.page ?? { ...EMPTY_PAGE, blocks: [] }"), true);

part("An unread page shows a note and no editor");
is("the editor is drawn only for a page that was read", page.includes("{selected && page ? ("), true);
is(
  "an unread page says so, in a status region",
  page.includes(
    '{selected && page === undefined ? (\n                <p role="status" className="notice">\n                  This page could not be read just now. Reload in a moment; nothing was changed, and its blocks are still kept.\n                </p>\n              ) : null}',
  ),
  true,
);
is("the empty state is only for a store with no pages", page.includes(") : selected ? null : (\n                <StudioEmptyState title=\"No pages yet\""), true);

done();
