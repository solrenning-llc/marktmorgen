/**
 * WCAG 2.2.5 Re-authenticating (AAA, AX274 item 4): when a session ends in the middle of a change, the person can
 * log in again and carry on without losing what they typed. A session lasts 30 days from logging in
 * (lib/auth.ts SESSION_TTL_SECONDS), so it can end while a page is open. 66 studio files then said only
 * "Your session ended. Log in again.", and logging in again in the same tab leaves the page and what was typed on
 * it. The email studio already said the way that keeps it: log in again in a new tab and come back to this one.
 *
 * SESSION_ENDED (lib/studio-messages.ts) says that once, for every file. The 28 that no open pull request touched
 * on 13 November 2026 use it here; the other 38 are listed in docs/a11y-time-backlog-2026-11-13.md. The session
 * itself does not change.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";
import { SESSION_ENDED } from "@/lib/studio-messages";

part("The words say how to keep what was typed");
is("they say it stays on the page", SESSION_ENDED.includes("stays on this page"), true);
is("they say to log in again in a new tab and come back", SESSION_ENDED.includes("new tab") && SESSION_ENDED.includes("come back to this tab"), true);

part("The 28 files say it");
const FILES = [
  "components/bundle-editor.tsx",
  "components/checkout-script-editor.tsx",
  "components/community-approval-studio.tsx",
  "components/course-work-studio.tsx",
  "components/custom-range.tsx",
  "components/discord-studio.tsx",
  "components/domain-editor.tsx",
  "components/dunning-editor.tsx",
  "components/leave-editor.tsx",
  "components/mail-picture-button.tsx",
  "components/meeting-connections.tsx",
  "components/nudge-editor.tsx",
  "components/numbers-links-editor.tsx",
  "components/passkey-manager.tsx",
  "components/pause-editor.tsx",
  "components/payments-panel.tsx",
  "components/phone-alerts-panel.tsx",
  "components/quiz-editor.tsx",
  "components/recovery-address-manager.tsx",
  "components/resend-purchase.tsx",
  "components/review-studio.tsx",
  "components/save-offer-editor.tsx",
  "components/team-two-step-switch.tsx",
  "components/thanks-note-editor.tsx",
  "components/two-step-manager.tsx",
  "components/welcome-offer-editor.tsx",
  "components/winback-editor.tsx",
  "components/yearly-ask-editor.tsx",
];
for (const file of FILES) {
  const text = readFileSync(file, "utf8");
  is(`${file}: no bare "Log in again."`, text.includes('"Your session ended. Log in again."'), false);
  is(`${file}: says SESSION_ENDED`, /\bSESSION_ENDED\b/.test(text) && /import \{[^}]*\bSESSION_ENDED\b[^}]*\} from "@\/lib\/studio-messages";/.test(text), true);
}
done();
