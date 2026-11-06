# AI store builder (219 [OP5], with 488 [IT5] and the owner's complement of 31 October 2026, 23h42/23h44)

Design written by Claude 2 on 1 November 2026, from the code on main. Nothing is built by this document. It records what the builder can reuse, what is missing against the item, and the units, so nothing is built twice.

## Competitors: not rechecked

The item asks for every competitor fact to be rechecked on its official page, with the date read, before building (Kajabi Cofounder first, from kajabi.com/pricing). In this session the network policy refuses outside sites, so **no competitor fact is rechecked here**. The 21 October 2026 survey in the queue item stays the only record. It is history to recheck, not a fact this document asserts. No public page may compare the builder with a competitor until the recheck is done (VR 7, AX274 item 7).

## What already exists (reuse, do not rebuild)

| Piece | Where | What it does today |
| --- | --- | --- |
| First draft of a store by AI | `writeStoreSetup` in `lib/ai.ts`, `lib/store-setup.ts` (`keepStoreSetup`), `components/store-setup-ai.tsx` | From a few sentences ("about", "selling"): three one-line introductions, up to three products and the FAQ. What the creator keeps goes up as **drafts**, never on sale; one AI job of the month, counted before the call |
| Imports | `lib/imports.ts` (`ImportKind`: contacts, products, purchases, members; sources CSV and ClickFunnels exports) | Brings a list, products and past buyers from a file, within monthly row limits |
| Funnel starters | `lib/funnel-starters.ts` (`FUNNEL_STARTERS`, `funnelStarter`) | Ready funnels: pages, offers and their automation |
| Email starters | `lib/mail-starters.ts` (`welcome`, `bought`) | A welcome sequence and an after-purchase sequence, made inactive until switched on |
| Next steps | Marktmorgen Path (`lib/path-*.ts`, `components/path-*.tsx`) | Missions and the next step from the store's real numbers |
| Honesty filters | `heldToFacts` (store assistant), the terms checks in `lib/terms-check-rules.ts` (including fast-money promises) | A model's text is shown only when it states nothing the creator did not publish |
| AI cost control | the AI jobs of the month and the spend policy (`lib/ai.ts`, `counted`; `lib/ai-spend-policy`) | Every call is counted or reserved before it is made |

## Gaps against the item (each a unit, tests first)

1. **No invented price.** `writeStoreSetup` asks for a price "as a suggestion". The item says that without a price the creator already charges, the field stays empty. Unit: the prompt and the kept draft carry a price only when the creator's own words or an imported product give one; otherwise empty. Test: a setup with no price in the input keeps every product without a price.
2. **One input, real content.** One field, "Paste your link or tell us what you sell". A public link-in-bio page (Linktree, Stan, Beacons and the like) is read through `lib/safe-fetch.ts` (public hosts only, no redirects), with a per-store and per-day read limit and a byte cap. "Continue with Instagram" needs Meta's official login and an app registration. **That depends on the owner** (no app, account or terms by an agent) and stays behind a switch that is off, in the pattern of `ZOOM_APPROVED`.
3. **At most three questions, as buttons**, only for what is indispensable.
4. **The whole business as one hidden draft.** Products (prices as above), sales pages from the funnel starters, checkout with the extra offer, a free gift for the email when it makes sense, the welcome sequence (`mail-starters`, inactive), the FAQ, the refund policy choice, the first Path steps, and the languages the creator picks among those the site offers. Reuses the pieces above; nothing new is stored but the draft.
5. **Real progress, resumable.** Each step is written as it finishes; closing the browser does not stop it; the creator is told when it ends. No fake progress bar.
6. **Review.** Phone-width preview beside the creator's old page; "Keep", "Change" and "Remove" on every piece; "Change" by hand or in plain words; "Undo" on everything and a version history.
7. **One "Publish my store".** It shows what is still missing (Stripe, a product's file) and links to each step. Nothing goes live and no email is sent without the creator's explicit approval.
8. **Measured ease.** An automated run with simulated providers counts the time, clicks and decisions from the sources to the reviewable store and to publishing, recorded in the PR. It joins the plan of tests with real people (item 202). No public "faster or easier than" claim without the dated comparison.
9. **Quality and beauty (complement of 23h44).** Every piece uses the Marktmorgen morning look of 571 [VS1]: the light palette at 7:1, Unbounded and Figtree, varied shapes and colors, no repeated image. 571 [VS1] belongs to Claude 1 and is not in this lane, so this unit waits on its tokens and does not invent a second look.
10. **Privacy.** Only what enters the approved store is kept; everything else that was read is deleted after the review. The privacy policy says so, in force with the feature.
11. **Cost.** Each AI call is reserved before it is made, inside the existing AI budgets; page reads are limited per store and per day. The worst month of each plan, monthly and yearly, with the builder used in full, goes into the plan's cost before the switch can be turned on (MR, 27 October 2026). Unknown is not zero. No price, visible limit or commission changes.

## Order

Unit 1 (no invented price) is small and changes what a creator gets today, so it comes first. Then 2 (link reading, with its limits), 4–7 (the draft, progress, review and publish), 8 (measurement), 10 (privacy text, in force with the feature) and 11 (cost) before the switch, and 9 once 571 [VS1] has its tokens. The Instagram half of 2 waits on the owner.
