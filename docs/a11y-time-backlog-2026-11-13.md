# Accessibility backlog: time, motion and understanding (13 November 2026)

What the AX274 item 4 sweep of 13 November 2026 left for later, and why. Each item is open until a commit closes it.

## Session ended mid-change (WCAG 2.2.5)

A session lasts 30 days from logging in (`SESSION_TTL_SECONDS` in `lib/auth.ts`), so it can end while a page is open. A studio form that then says only "Your session ended. Log in again." invites logging in again in the same tab, which leaves the page and what was typed on it. [`SESSION_ENDED`](../lib/studio-messages.ts) says how to keep it: log in again in a new tab, then come back. The 28 files no open pull request touched use it ([`tests/session-ended-words.test.ts`](../tests/session-ended-words.test.ts)). These 38 still say the short words; each moves over once its open pull requests are in, by replacing the string with `SESSION_ENDED` and adding the file to that test.

| File | Open PRs on 13 Nov |
| --- | ---: |
| `components/affiliate-studio.tsx` | 6 |
| `components/api-key-editor.tsx` | 2 |
| `components/calendar-editor.tsx` | 1 |
| `components/call-editor.tsx` | 1 |
| `components/checkout-extras.tsx` | 2 |
| `components/community-events-studio.tsx` | 1 |
| `components/community-studio.tsx` | 4 |
| `components/course-editor.tsx` | 13 |
| `components/course-toggle.tsx` | 2 |
| `components/details-form.tsx` | 2 |
| `components/discount-editor.tsx` | 3 |
| `components/email-sync-editor.tsx` | 1 |
| `components/funnel-editor.tsx` | 2 |
| `components/handle-form.tsx` | 1 |
| `components/host-calendar.tsx` | 1 |
| `components/import-tool.tsx` | 10 |
| `components/licence-key-editor.tsx` | 2 |
| `components/link-editor.tsx` | 8 |
| `components/link-picture.tsx` | 1 |
| `components/look-editor.tsx` | 8 |
| `components/mark-shipped.tsx` | 2 |
| `components/old-addresses.tsx` | 2 |
| `components/outreach-studio.tsx` | 8 |
| `components/pdf-stamp-toggle.tsx` | 1 |
| `components/pixel-editor.tsx` | 1 |
| `components/podcast-toggle.tsx` | 1 |
| `components/product-editor.tsx` | 27 |
| `components/product-image-editor.tsx` | 6 |
| `components/product-update-box.tsx` | 2 |
| `components/recovery-editor.tsx` | 1 |
| `components/rename-form.tsx` | 1 |
| `components/shipping-editor.tsx` | 1 |
| `components/socials-editor.tsx` | 6 |
| `components/task-editor.tsx` | 2 |
| `components/tax-editor.tsx` | 1 |
| `components/team-event-editor.tsx` | 2 |
| `components/team-manager.tsx` | 3 |
| `components/webhook-editor.tsx` | 6 |

## Email typed twice before paying (WCAG 3.3.7): a product decision, not a code change

A buyer who checks "Email me a reminder if I don't finish this order" types their email on the store's page, and Stripe's checkout then asks for an email again. Passing that address to Stripe as `customer_email` would fill it in, but Stripe then locks the field, ties the customer and the receipt to that address, and a buyer may want to pay with another one. It is a money path and the gain is a level AAA criterion, so it stays as it is until the owner decides (coordinator's decision, 13 November 2026).

## Left to open pull requests

- The sales page countdown's pause and its less-motion behaviour (2.2.2, 2.3.3): #4104. The welcome offer's countdown is done separately.
- The promotion planner's smooth scroll (2.3.3): #4094 and #3921 change that line.
