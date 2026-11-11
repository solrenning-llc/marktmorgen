/**
 * 26 [E9], unit 1, the studio side: the "Explain this with AI" control beside
 * each funnel check (components/funnel-issue-explain.tsx), drawn inside the
 * funnel's review (components/funnel-sharing-review.tsx). Server markup only;
 * what the route does is in tests/funnel-explain.test.ts.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FunnelSharingReview } from "@/components/funnel-sharing-review";
import { EXPLAIN_LABEL, explainErrorText, FunnelIssueExplain } from "@/components/funnel-issue-explain";
import { is, done, part } from "./check";

const issue = { code: "disabled" as const, title: "The funnel address is disabled", detail: "Review its settings." };
const review = (change: Partial<Parameters<typeof FunnelSharingReview>[0]> = {}) => renderToStaticMarkup(createElement(FunnelSharingReview, {
  issues: [issue], editors: [], locked: false, settingsDisabled: false, onSettings() {}, onNavigate() {}, ...change,
}));

part("Only where the plan has AI writing and the role may edit pages");
is("no explain control without AI writing", review().includes("Explain this with AI"), false);
const on = review({ explain: { funnelId: "abcdefghij", left: 3 } });
is("one control per check with AI writing on", on.split("Explain this with AI").length - 1, 1);

part("It says what it costs and that the check decides, before it is pressed");
const one = renderToStaticMarkup(createElement(FunnelIssueExplain, { funnelId: "abcdefghij", issue, left: 3, onLeft() {} }));
const described = /aria-describedby="([^"]+)"/.exec(one)?.[1] ?? "";
is("the button names its cost and its limit through a description", [described.length > 0, one.includes(`id="${described}"`), one.includes("Uses 1 of your 3 AI writing jobs left this month."), one.includes("The check above stays as it is.")], [true, true, true, true]);
is("a 44-pixel target, a real button", [/<button type="button"[^>]*min-h-11/.test(one), one.includes("Explain this with AI")], [true, true]);
is("a polite live region is there before anything is said", /role="status"[^>]*aria-live="polite"|aria-live="polite"[^>]*role="status"/.test(one), true);
const none = renderToStaticMarkup(createElement(FunnelIssueExplain, { funnelId: "abcdefghij", issue, left: 0, onLeft() {} }));
is("nothing left: disabled, and it says why", [/<button[^>]*disabled=""/.test(none), none.includes("No AI writing jobs are left this month.")], [true, true]);
is("the label drawn by the page, never by the model", EXPLAIN_LABEL, "AI explanation: written by AI from this check. The check decides; this only explains it.");

part("Every refusal is said plainly");
is("each reason has its own sentence", ["used", "off", "stale", "gone", "unknown", "failed", "slow", "studio", "invalid", "anything"].map(explainErrorText), [
  "You have used this month's AI writing jobs. They come back when your plan's month renews.",
  "AI writing is not part of this store's plan right now.",
  "This check has changed since the page loaded. Reload the page to see the current checks.",
  "This funnel no longer exists. Reload the page.",
  "The funnel could not be checked just now. Nothing was used. Try again in a moment.",
  "No explanation could be written this time. The attempt used one AI writing job.",
  "Too many requests right now. Try again in a minute.",
  "Too many requests right now. Try again in a minute.",
  "Something went wrong. Reload the page and try again.",
  "Something went wrong. Reload the page and try again.",
]);

done();
