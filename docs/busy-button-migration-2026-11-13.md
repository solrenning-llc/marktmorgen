# BusyButton migration (13 November 2026)

A button disabled while it waits on the server drops the keyboard focus to the top of the page (WCAG 2.4.3): the browser cannot keep the focus on a disabled element. On 13 November 2026, 442 such buttons were counted in 151 studio files: every `<button>` with `disabled={…}` naming `busy`, `saving`, `sending`, `working`, `pending` or `loading`, and a `type="submit"` or an `onClick`.

[`BusyButton`](../components/busy-button.tsx) is the one way to wait: `busy` for its own work, `off` for any other reason it cannot be used now, `announce={false}` when the page already says the same in a status region. It is marked `aria-disabled` and `aria-busy` instead of `disabled`, keeps the focus, does nothing on a click or Enter while busy or off (so a submit button also stops Enter in a field from sending its form again), and says its own words in a status region while busy. [`tests/busy-button-browser.test.ts`](../tests/busy-button-browser.test.ts) proves it in Chromium.

## How to move a file

1. Check that no open pull request changes the lines (rules MV and PV).
2. Replace `<button … disabled={busy …} aria-busy={…}>` with `<BusyButton … busy={…} off={…}>`: `busy` is this button's own work; everything else that `disabled` named goes in `off`.
3. A button whose words do not change while it waits, or whose page already has a status line saying it, takes `announce={false}`.
4. Payment screens move last, each with its own review: a wrong guard there is a second charge.
5. Add the file to [`tests/busy-button-pilot.test.ts`](../tests/busy-button-pilot.test.ts) so it cannot go back.

## The files

`PRs` is how many open pull requests changed the file on 13 November 2026, to plan around; check again before starting. The two marked *pilot* are done in the branch that adds BusyButton.

| File | Buttons | PRs |
| --- | ---: | ---: |
| `components/course-editor.tsx` | 23 | 13 |
| `components/affiliate-studio.tsx` | 21 | 6 |
| `components/community-studio.tsx` | 20 | 4 |
| `components/email-studio.tsx` | 16 | 15 |
| `components/product-editor.tsx` | 14 | 27 |
| `components/outreach-studio.tsx` | 11 | 8 |
| `components/review-studio.tsx` | 10 | 0 |
| `components/agreements-studio.tsx` | 7 | 1 |
| `components/licence-key-editor.tsx` | 7 | 2 |
| `components/funnel-share-panel.tsx` (pilot) | 7 | 0 |
| `components/checkout-extras.tsx` | 6 | 2 |
| `components/custom-range.tsx` (pilot) | 6 | 0 |
| `components/faq-editor.tsx` | 6 | 1 |
| `components/community-events-studio.tsx` | 6 | 1 |
| `components/payment-requests-studio.tsx` | 6 | 3 |
| `components/course-shelf-studio.tsx` | 6 | 195 |
| `components/host-calendar.tsx` | 5 | 1 |
| `components/link-editor.tsx` | 5 | 8 |
| `components/inbox-studio.tsx` | 5 | 7 |
| `components/community-approval-studio.tsx` | 5 | 0 |
| `components/paypal-payouts.tsx` | 5 | 3 |
| `components/workflow-tools.tsx` | 5 | 5 |
| `components/saved-sections.tsx` | 5 | 1 |
| `components/email-sync-editor.tsx` | 5 | 1 |
| `components/site-pages-editor.tsx` | 5 | 3 |
| `components/ad-spend-editor.tsx` | 4 | 5 |
| `components/discount-editor.tsx` | 4 | 3 |
| `components/companies-editor.tsx` | 4 | 37 |
| `components/recovery-address-manager.tsx` | 4 | 0 |
| `components/team-manager.tsx` | 4 | 3 |
| `components/agent-proposals.tsx` | 4 | 0 |
| `components/affiliate-leads-studio.tsx` | 4 | 0 |
| `components/two-step-manager.tsx` | 4 | 0 |
| `components/form-response-deal.tsx` | 3 | 0 |
| `components/person-tasks.tsx` | 3 | 0 |
| `components/discord-studio.tsx` | 3 | 0 |
| `components/server-events-editor.tsx` | 3 | 0 |
| `components/team-two-step-switch.tsx` | 3 | 0 |
| `components/call-editor.tsx` | 3 | 1 |
| `components/quiz-editor.tsx` | 3 | 0 |
| `components/domain-editor.tsx` | 3 | 0 |
| `components/import-tool.tsx` | 3 | 10 |
| `components/task-editor.tsx` | 3 | 2 |
| `components/waitlist-panel.tsx` | 3 | 4 |
| `components/bulk-labels.tsx` | 3 | 0 |
| `components/shipping-editor.tsx` | 3 | 1 |
| `components/course-comments-studio.tsx` | 3 | 1 |
| `components/person-company.tsx` | 3 | 36 |
| `components/page-editor.tsx` | 3 | 173 |
| `components/letter-publish-control.tsx` | 3 | 0 |
| `components/winback-editor.tsx` | 2 | 0 |
| `components/thanks-note-editor.tsx` | 2 | 0 |
| `components/numbers-notes.tsx` | 2 | 0 |
| `components/community-push-toggle.tsx` | 2 | 1 |
| `components/passkey-manager.tsx` | 2 | 0 |
| `components/person-erase.tsx` | 2 | 0 |
| `components/block-rewrite.tsx` | 2 | 1 |
| `components/bundle-editor.tsx` | 2 | 0 |
| `components/look-editor.tsx` | 2 | 8 |
| `components/studio-help.tsx` | 2 | 1 |
| `components/save-offer-editor.tsx` | 2 | 0 |
| `components/tier-editor.tsx` | 2 | 0 |
| `components/course-work-studio.tsx` | 2 | 0 |
| `components/funnel-editor.tsx` | 2 | 2 |
| `components/sales-goal-card.tsx` | 2 | 1 |
| `components/store-assistant.tsx` | 2 | 4 |
| `components/cover-maker.tsx` | 2 | 0 |
| `components/lesson-notes.tsx` | 2 | 1 |
| `components/webhook-editor.tsx` | 2 | 6 |
| `components/intro-editor.tsx` | 2 | 0 |
| `components/short-links.tsx` | 2 | 0 |
| `components/person-notes.tsx` | 2 | 1 |
| `components/numbers-links-editor.tsx` | 2 | 0 |
| `components/phone-alerts-panel.tsx` | 2 | 0 |
| `components/sale-editor.tsx` | 2 | 0 |
| `components/team-event-editor.tsx` | 2 | 2 |
| `components/socials-editor.tsx` | 2 | 6 |
| `components/chat-summary-editor.tsx` | 2 | 0 |
| `components/blog-editor.tsx` | 2 | 1 |
| `components/clickfunnels-funnel.tsx` | 2 | 1 |
| `components/product-image-editor.tsx` | 2 | 6 |
| `components/community-composer.tsx` | 2 | 1 |
| `components/link-picture.tsx` | 2 | 1 |
| `components/course-template-picker.tsx` | 2 | 0 |
| `components/package-editor.tsx` | 2 | 0 |
| `components/creator-card-editor.tsx` | 2 | 2 |
| `components/forms-editor.tsx` | 2 | 0 |
| `components/payments-panel.tsx` | 2 | 0 |
| `components/member-discount.tsx` | 2 | 2 |
| `components/welcome-offer-editor.tsx` | 2 | 0 |
| `components/path-board.tsx` | 2 | 1 |
| `components/heard-ask.tsx` | 1 | 0 |
| `components/visit-us-editor.tsx` | 1 | 0 |
| `components/kit-editor.tsx` | 1 | 2 |
| `components/pixel-editor.tsx` | 1 | 1 |
| `components/api-key-editor.tsx` | 1 | 2 |
| `components/ask-box.tsx` | 1 | 0 |
| `components/rename-form.tsx` | 1 | 1 |
| `components/checkout-script-editor.tsx` | 1 | 0 |
| `components/email-code-form.tsx` | 1 | 1 |
| `components/tax-editor.tsx` | 1 | 1 |
| `components/course-toggle.tsx` | 1 | 2 |
| `components/funnel-starter-gallery.tsx` | 1 | 1 |
| `components/lesson-task.tsx` | 1 | 1 |
| `components/older-purchases.tsx` | 1 | 0 |
| `components/podcast-toggle.tsx` | 1 | 1 |
| `components/store-chat.tsx` | 1 | 3 |
| `components/dunning-editor.tsx` | 1 | 0 |
| `components/faq-from-inbox.tsx` | 1 | 0 |
| `components/path-ai-wording.tsx` | 1 | 0 |
| `components/contact-box-editor.tsx` | 1 | 1 |
| `components/yearly-ask-editor.tsx` | 1 | 0 |
| `components/cart-deal-editor.tsx` | 1 | 0 |
| `components/funnel-issue-explain.tsx` | 1 | 121 |
| `components/confirm-action.tsx` | 1 | 0 |
| `components/signin-form.tsx` | 1 | 6 |
| `components/join-box-editor.tsx` | 1 | 1 |
| `components/attribution-table.tsx` | 1 | 0 |
| `components/sequence-import-box.tsx` | 1 | 1 |
| `components/product-update-box.tsx` | 1 | 2 |
| `components/mark-shipped.tsx` | 1 | 2 |
| `components/resend-purchase.tsx` | 1 | 0 |
| `components/nudge-editor.tsx` | 1 | 0 |
| `components/store-guide-box.tsx` | 1 | 1 |
| `components/no-count-toggle.tsx` | 1 | 0 |
| `components/store-language-editor.tsx` | 1 | 0 |
| `components/store-cart.tsx` | 1 | 0 |
| `components/handle-form.tsx` | 1 | 1 |
| `components/buyer-paths.tsx` | 1 | 0 |
| `components/report-form.tsx` | 1 | 7 |
| `components/tips-editor.tsx` | 1 | 1 |
| `components/leave-editor.tsx` | 1 | 0 |
| `components/stats-panel.tsx` | 1 | 7 |
| `components/store-setup-ai.tsx` | 1 | 1 |
| `components/details-form.tsx` | 1 | 2 |
| `components/pause-editor.tsx` | 1 | 0 |
| `components/affiliate-kit.tsx` | 1 | 0 |
| `components/path-social-scripts.tsx` | 1 | 0 |
| `components/creator-research-form.tsx` | 1 | 1 |
| `components/page-answers.tsx` | 1 | 1 |
| `components/certificate-validity.tsx` | 1 | 0 |
| `components/checkout-fields-editor.tsx` | 1 | 1 |
| `components/person-find.tsx` | 1 | 0 |
| `components/numbers-ask.tsx` | 1 | 1 |
| `components/old-addresses.tsx` | 1 | 2 |
| `components/path-reminder-button.tsx` | 1 | 0 |
| `components/closing-refunds-confirm.tsx` | 1 | 0 |
| `components/recent-sales-switch.tsx` | 1 | 0 |
| `components/calendar-editor.tsx` | 1 | 1 |
| `components/recovery-editor.tsx` | 1 | 1 |
| `components/community-room.tsx` | 1 | 1 |

Total: 442 buttons in 151 files.
