/**
 * 656 [WG16], unit 11: the studio's "Your pages" list uses the shared studio
 * empty state when the store has no page yet, at level 2 (the page's h1 is
 * above it and the box stands beside the other h2 boxes), with an in-page jump
 * to the field that starts a page. Two spots stay as they are, because a
 * heading would be wrong there: "No credit yet" is one value in a row of the
 * invited list, and "No lessons yet." is a line under a module's own h3 in the
 * day preview.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const site = readFileSync("app/studio/site/page.tsx", "utf8");
const list = readFileSync("components/site-pages-editor.tsx", "utf8");
const invite = readFileSync("app/studio/invite/page.tsx", "utf8");
const preview = readFileSync("components/course-day-preview.tsx", "utf8");

part("The pages list: shared studio empty state with a working jump");
is("the page imports StudioEmptyState", site.includes('import { StudioEmptyState } from "@/components/empty-state";'), true);
is(
  "the empty list draws the shared state at level 2",
  site.includes('<StudioEmptyState title="No pages yet" body="Pick a starter from the list, such as About or Start here, or type a title of your own." action={{ href: "#new-page-title", label: "Start a page" }} level={2} className="card p-6 sm:p-8" />'),
  true,
);
is("the bare heading-like paragraph is gone", site.includes('<p className="text-lg font-semibold tracking-[-0.02em] text-ink">No pages yet</p>'), false);
is("the jump target exists on the page", list.includes('id="new-page-title"'), true);
is("the list renders the target while there is room for a page", list.includes("pages.length < MAX_SITE_PAGES"), true);

part("Spots left as they are");
is("invite: the credit line is one value in a row, unchanged", invite.includes('<span className="block text-sm text-ink-soft">No credit yet</span>'), true);
is("preview: the module line is unchanged", preview.includes('<p className="text-sm text-ink-soft">No lessons yet.</p>'), true);

done();
