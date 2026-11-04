/**
 * Empty screens say what to do next (487 [IT4], pattern 5, first pass;
 * added 1 November 2026; docs/ease-patterns-audit.md).
 */
import { readFileSync } from "node:fs";
import { done, is } from "./check";

const email = readFileSync("components/email-studio.tsx", "utf8");
is("an empty email history says where the first email comes from, for who can send and who cannot", email.includes('canSend ? "Your first email shows here once you send or schedule it with the editor above." : "An email shows here once the owner or an Admin sends or schedules it."'), true);
const events = readFileSync("components/community-events-studio.tsx", "utf8");
is("no event scheduled says what an event can be and where to start one", events.includes("Nothing scheduled yet. A live call, a workshop or a Q&amp;A: press &ldquo;Schedule an event&rdquo; to put one on your community&rsquo;s calendar.") && events.includes('canManage && editing !== "new" ?'), true);
const reviews = readFileSync("app/studio/reviews/page.tsx", "utf8");
is("no review yet offers the way to ask buyers for one, on the same page", reviews.includes('href="#asking-for-reviews"') && reviews.includes('id="asking-for-reviews"'), true);
is("the place it leads to is a heading that takes the focus, so a keyboard or screen reader lands there", reviews.includes('<h2 id="asking-for-reviews" tabIndex={-1}'), true);
is("offered only when the store has no review at all, on either tab, and to a role that can switch it on", reviews.includes('current.total === 0 && numbers.size === 0 && can(view.role, "settings")'), true);
const deals = readFileSync("components/deals-board.tsx", "utf8");
is("an empty deals board says what it is for and names its button", deals.includes("No deals yet. When someone asks about something you sell outside a checkout, press &ldquo;New deal&rdquo;") && deals.includes("pipelineDeals.length === 0 && draft === null"), true);
done();
