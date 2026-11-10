# Meta requirements for AutoDM, comment replies, inbox and WhatsApp

Queue item 39 [G1] (study part). Written November 6, 2026. Document only: no Meta app, account, App Review submission, Business Verification, terms acceptance, payment or contact was made, and no code changed. `AUTODM_LIVE` stays `false`. The code already written for 480 [SB3] is described in section 8.

## 0. How the sources were read, and what that means

The session's network refuses `developers.facebook.com` and `business.whatsapp.com` (proxy `connect_rejected` and DNS `ENOTFOUND`, November 6, 2026, the same block recorded in 480 [SB3] on November 4 and 5). So **no Meta page was opened directly**. Every fact below comes from the search engine's index of Meta's own official pages (the URL in the sources table), seen on November 6, 2026. Search summaries can be stale or merged across versions, and several indexed pages carried an age of about 550–654 days. Therefore:

- Every number here is **"seen in search, not read on the page"** and must be re-read on Meta's page, dated, before any channel code uses it.
- Where two official pages disagreed, both are given and the stricter one is the working assumption.
- Nothing here certifies a cost, a limit or an approval. Unknown stays unknown; it is never zero.

After the study was written, Codex T's independent review of #2916 opened three official WhatsApp pages directly on November 6, 2026, reached through `whatsappbusiness.com`: the pricing page [S19], the FAQ [S29] and the Business Messaging Policy [S28]. Section 6 cites what the review found on the first two; every other source is still "seen in search" only.

To close the gap, the session network must allow `developers.facebook.com`, `developers.secure.facebook.com`, `business.whatsapp.com` and `www.whatsapp.com` (owner decision, see section 9).

## 1. Which API path

| Path | What the creator needs | Notes (search, Nov 6, 2026) |
| --- | --- | --- |
| Instagram API with Instagram Login (Business Login for Instagram) | Instagram professional account (Business or Creator). No Facebook Page needed. | Covers publishing, comment moderation, insights, mentions and messaging; no ads, no tagging. Meta's Messenger docs send accounts without a Page here. [S1][S2] |
| Instagram API with Facebook Login for Business | Instagram professional account **connected to a Facebook Page**. | All calls on `graph.facebook.com`; adds hashtag search and product tagging. [S1][S3] |
| "Unified Login" (newer) | Either login, no Page. | The current overview calls it the recommended setup for new integrations; details not read. [S1] |
| Messenger Platform (Facebook Page inbox, Page comments) | A Facebook Page the creator manages. | Page access token. [S9][S10] |
| WhatsApp Business Platform (Cloud API) | The creator's own WhatsApp Business Account (WABA) and phone number, onboarded through Embedded Signup. | Section 6. [S14][S15] |

Working assumption for AutoDM on Instagram: Instagram Login, because most creators have no Page. A creator who also wants the Facebook Page inbox connects the Page separately.

## 2. Permissions per feature

| Feature | Instagram Login | Facebook Login | Source |
| --- | --- | --- | --- |
| Read comments, reply publicly | `instagram_business_basic`, `instagram_business_manage_comments` | `instagram_basic`, `instagram_manage_comments`, `pages_read_engagement` (plus `ads_management` or `ads_read` when the user's Page role comes from Business Manager) | [S4][S5] |
| Private reply to a comment (the AutoDM itself) | `instagram_business_basic`, `instagram_business_manage_messages` (secondary guides say `..._manage_comments` too; request both) | `instagram_manage_comments`, `pages_messaging` (secondary guides add `instagram_manage_messages`, `pages_read_engagement`) | [S4][S6] |
| Instagram inbox (read and answer DMs) | `instagram_business_basic`, `instagram_business_manage_messages` | `instagram_manage_messages`, `pages_messaging` | [S6][S7] |
| Facebook Page inbox (Messenger) | — | `pages_messaging` | [S9] |
| Facebook Page comments | — | Not confirmed. `pages_manage_engagement` did not appear in any official result; `pages_read_engagement` did. **Unknown** | [S5] |
| WhatsApp | `whatsapp_business_messaging` (send/receive, phone number settings), `whatsapp_business_management` (account settings, templates) | same | [S15] |

Webhook fields: `comments` and `live_comments` (Instagram, both logins), `messages` for DMs. The comment webhook carries the comment id, the commenter's Instagram-scoped id and the media id; Meta recommends webhooks over polling. [S5][S8]

## 3. Access level, App Review, Business Verification

- **Advanced Access** is needed to serve professional accounts Marktmorgen does not own or manage, used by people with no role on the app. It **requires App Review and Business Verification**. [S1][S11]
- `instagram_business_manage_comments` and `instagram_business_manage_messages` are among the permissions requested with Advanced Access. [S11]
- Before requesting it: at least one successful API call per permission, a clear use-case description, screen recordings, and reviewer login instructions. [S11][S12]
- Escalation to a human must be shown in review: thread ownership moves to the inbox and the agent can reply there. [S10]
- The **HUMAN_AGENT tag** is a separate application in the App Dashboard, even for already approved apps. [S9][S10]
- WhatsApp as a **Tech Provider** needs Advanced Access to both WhatsApp permissions; without it, calls on accounts the business does not own return error 200. Tech Providers also verify the business may access other portfolios' data. [S1][S15]
- Business Verification verifies a legal business. Marktmorgen's would be Solrenning LLC, which is not formed yet (see `docs/us-llc-owner-roadmap-2026-10-28.md`). **Unknown:** whether Meta accepts the LLC's documents, how long it takes, and whether the existing ads integration (`lib/meta-ads.ts`, `ads_read`) already has an app the owner wants to extend.

## 4. Messaging windows, tags and comment replies

| Rule | Value seen | Source |
| --- | --- | --- |
| Standard window (Instagram and Messenger) | 24 hours after the person's last message; promotional content allowed inside it | [S9][S10] |
| HUMAN_AGENT tag | Up to 7 days, human replies only; **automated messages are a disallowed use**. On Instagram it is the only tag | [S9][S10] |
| Other Messenger tags | `CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE`, `POST_PURCHASE_UPDATE` return error 100 from April 27, 2026 (changelog); one reference page still lists them as "upcoming", so **re-check** | [S13] |
| Private reply time limit | Within **7 days** of the comment; Instagram Live: only during the broadcast | [S6] |
| Private reply count | **One** private reply per comment, a single message. A follow-up only if the person answers, and then inside 24 hours of that answer | [S6] |
| Public reply | POST to the comment's `/replies`; top-level comments only; not supported on Live (use a private reply) | [S5] |
| Bot disclosure | Where law requires it (California and Germany named), say it is automated at the start, after a long gap and when returning from a human; Meta recommends it always | [S10] |
| Responsiveness | An experience marked automated must answer every input within 30 seconds | [S10] |
| Opt-out | A legally sufficient, ongoing way to opt out; block, discontinue and opt-out requests honored at once | [S10][S16] |
| Longest message text | **Unknown** (not in any result). `REPLY_MAX_CHARS` 500 is our own cap and must stay at or below Meta's | — |

## 5. Rate limits

| Limit | Value seen | Source |
| --- | --- | --- |
| Send API, text/link/reaction/sticker | 300 calls per second per Instagram professional account (changelog of October 8, 2024, up from 100). The overview page still says 100. **Working assumption: 100 calls per second**, the stricter, until both are read on the page and dated | [S1][S7][S8] |
| Send API, audio/video | 10 calls per second (overview) | [S1] |
| Private replies, posts and reels | 750 calls per hour. **Discrepancy:** the Graph API page says per Instagram professional account; the Messenger page says per Facebook Page. Use the stricter reading until read | [S8][S17] |
| Private replies, Live comments | 100 calls per second per account | [S8] |
| Too many messages to one thread | May be rate limited; no number seen | [S17] |

The creator's repeat interval (`REPEAT_CHOICES`) is stricter per person than Meta's per-comment rule; it never replaces Meta's limits.

## 6. WhatsApp

**Pricing (who pays).** Since July 1, 2025 Meta bills **per delivered message**, by category (marketing, utility, authentication, service) and by the recipient's market (search). Messages from people to the business are not charged. **The official sources conflict on replies inside the open window.** The official WhatsApp FAQ, opened directly in Codex T's review on November 6, 2026, says service messages are charged from October 1, 2026, after the first 1,000 service messages per business phone number each month [S29]; the same FAQ still carries an older conversation-based description elsewhere, so it is not wholly current. The official pricing page, opened directly the same day, still says service messages and utility responses to users are not charged [S19]. The October 1, 2026 date and the 1,000-message allowance rest on the FAQ. Whether utility replies inside the window are charged from that date too, and at which rate (search showed the market's utility/authentication rate, from S14 and S18, neither read), is **unverified** and stays unknown until one dated official source settles it; it is not usable for code or for any cost. For planning only, the stricter reading applies: service messages and utility replies inside the window are treated as charged per message, at an amount still unknown. Click-to-WhatsApp ad entry points open a 72-hour free window for templates (search). The billed party is the **business that owns the WhatsApp Business Account**; on a Solution Partner's credit line the partner is billed. [S14][S18][S19][S29]

Consequences for Marktmorgen:

- The only design compatible with the margin rule is **Tech Provider + Embedded Signup**: the creator owns the WABA, adds their own payment method, and Meta bills the creator. Marktmorgen must **never** share a credit line (Solution Partner model), because then Meta bills Marktmorgen per message with no ceiling we control. [S15][S20]
- Embedded Signup customers own all their WhatsApp assets; the provider cannot restrict their WhatsApp Manager. Sends fail without a valid payment method. Embedded Signup v2 is deprecated on October 8, 2026 (changelog); v4 is current. [S15]
- Per-country rates were **not read** (rate card host blocked). Nothing here says the creator's cost is zero. A WhatsApp send in Marktmorgen must show the creator that Meta charges them per message.
- **Opt-in:** the person must have given their number and an opt-in naming the business and saying they agree to receive its messages; the business chooses the method and answers for local law. Outside the 24-hour window only approved templates may be sent. Violations bring escalating restrictions up to removal. [S21][S28]
- Marktmorgen's own cost (webhooks, storage, compute per message) is **not priced** and is not zero.

## 7. Privacy policy and data deletion

- A privacy policy at a public, crawlable, non-geoblocked URL, entered in the App Dashboard; it must explain how users request deletion. A broken link is a violation. [S22][S23]
- Publishing needs a data deletion URL: instructions **or** a callback. One page says either is enough; an older "Build and Test" page says a callback is required once a use case is implemented. Working assumption: a callback. HTTPS, JSON answer with a status URL and a confirmation code. [S24][S25]
- **What exists:** `app/api/integrations/meta/deauthorize/route.ts` is registered (per its comment) as both the Deauthorize and Data Deletion Request callback for the **ads** connection (Facebook Login, `signed_request`, forgets every connection of that person, answers with a code). **Missing:** the same for an Instagram Login connection (whether Instagram Login sends the same `signed_request` is **unknown**), deletion of kept commenter ids and conversations, and privacy-policy and terms text for AutoDM, inbox and WhatsApp (`app/privacy/page.tsx` today mentions Meta only for pixels and ads).

## 8. What the code enforces today, and what is missing

`lib/autodm-rules.ts` and `lib/autodm-reply-rules.ts` (480 [SB3], units 1 and 2) are pure: nothing is read, sent or kept, and no Meta number is in them.

| Requirement | Today | Missing before any channel code |
| --- | --- | --- |
| Off until approval | `AUTODM_LIVE = false`; `decideReply` keeps its own lock | Turn on only after App Review (owner) |
| Test before live | Test mode with up to 3 creator test accounts; server-kept test fingerprint | — |
| Keyword matching, repeat interval, counts without personal data | Done (`matchingKeyword`, `REPEAT_CHOICES` default 12h, `AutoDmCounts`, `dmLinkTag`) | — |
| Own comments never answered | Done (`own`) | — |
| Reply text bounded, no hand-typed links | 500 characters, our cap | Confirm Meta's maximum; keep ours at or below it |
| 7-day comment age; Live only during broadcast | Not checked | Add to `decideReply` from the comment's timestamp |
| One private reply per comment | Not checked (the repeat interval is per person) | Dedupe by comment id |
| 24-hour window for any follow-up; no automated HUMAN_AGENT use | Not modeled | Window clock per thread; tag only for human replies |
| 750/hour private replies (stricter scope) and 100/s send (the stricter of the overview's 100 and the changelog's 300; both pending a dated read on Meta's page) | Not modeled | Per-account and per-Page counters before each call |
| Webhook receipt and signature check | Not built | Verify Meta's signature header (name to confirm on the webhooks page), bounded body, idempotent |
| Bot disclosure, opt-out word, human hand-off | Not built for DMs (`HANDOFF_WORDS` exists for the store assistant) | Reuse hand-over to `lib/inbox.ts`; honor "stop" at once |
| Commenter id retention (repeat interval) and deletion | Not built | Keep only the id and time for the chosen interval; delete on request and on disconnect |
| Cost per comment received and reply sent | Not priced | Price with source, cap before each call (MR rule) |
| WhatsApp | Nothing beyond names and links | Embedded Signup as Tech Provider, opt-in record, templates, creator-billed |

## 9. Depende do dono (forbidden for agents)

1. Create or extend the Meta app (Instagram, Messenger and WhatsApp use cases), and decide whether to reuse the ads app.
2. Business Verification of the business (Solrenning LLC once formed), with its documents.
3. App Review submission: use-case text, screen recordings, reviewer login; HUMAN_AGENT tag application.
4. Becoming a WhatsApp Tech Provider (never a Solution Partner with a shared credit line).
5. Accepting Meta's Platform Terms, Developer Policies and WhatsApp Business terms.
6. Allowing `developers.facebook.com`, `developers.secure.facebook.com`, `business.whatsapp.com` and `www.whatsapp.com` in the session network so every figure above can be read on the page and dated.

## 10. TikTok (480 [SB3] asked)

Search on November 6, 2026 shows an official TikTok Business Messaging API (business-api.tiktok.com, v1.3) with direct messages, automatic messages, comment replies and an endpoint to enable or disable Comment-to-Message; in-app automatic messages need Advanced Access and a Verified Business Account. Not opened; eligibility, permissions and limits are **unknown**. [S26][S27]

## Sources

All seen on November 6, 2026 **through web search only**; the pages themselves were not opened because the session network refuses Meta's hosts. The exceptions are S19, S28 and S29, which Codex T's review of #2916 opened directly the same day (section 0); S29 was added from that review. "Index note" is what the search tool reported about the page's age.

| # | Page | URL | Index note |
| --- | --- | --- | --- |
| S1 | Instagram Platform overview | https://developers.facebook.com/documentation/instagram-platform/overview | Some copies ~654 days old |
| S2 | Instagram API with Instagram Login | https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/ | — |
| S3 | Instagram API with Facebook Login | https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login | — |
| S4 | Comment Moderation | https://developers.facebook.com/documentation/instagram-platform/comment-moderation.md | — |
| S5 | IG Comment Replies | https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-comment/replies | v25.0 examples |
| S6 | Private replies (Instagram Messaging) | https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/private-replies | Reported updated July 2, 2026 |
| S7 | Send Messages (Instagram Login) | https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api | — |
| S8 | Graph API rate limits | https://developers.facebook.com/docs/graph-api/overview/rate-limiting/ | — |
| S9 | Send API reference | https://developers.facebook.com/docs/messenger-platform/reference/send-api/ | Partly stale |
| S10 | Messenger Platform and IG Messaging API policy | https://developers.facebook.com/documentation/business-messaging/messenger-platform/policy | — |
| S11 | App Review for Instagram API | https://developers.facebook.com/documentation/instagram-platform/app-review | ~654 days |
| S12 | Create a Meta App for Instagram Platform | https://developers.facebook.com/documentation/development/create-an-app/other-app-types/instagram-apis | — |
| S13 | Messenger Platform changelog | https://developers.secure.facebook.com/documentation/business-messaging/messenger-platform/changelog | — |
| S14 | Pricing on the WhatsApp Business Platform | https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing | Age stamp conflicts with content |
| S15 | Embedded Signup | https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview | — |
| S16 | Developer Policies | https://developers.facebook.com/devpolicy/ | — |
| S17 | Messenger Platform rate limits | https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview/rate-limiting | — |
| S18 | Upcoming pricing updates (service and utility) | https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/non-template-messages | — |
| S19 | WhatsApp Business Platform Pricing | https://business.whatsapp.com/products/platform-pricing | Rate card not read. Opened directly in the review (redirects to whatsappbusiness.com): says service messages and utility responses are not charged |
| S20 | Become a Tech Provider | https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers | — |
| S21 | Get opt-in for WhatsApp | https://developers.facebook.com/documentation/business-messaging/whatsapp/getting-opt-in | — |
| S22 | Privacy Policy Expectations | https://developers.facebook.com/documentation/development/terms-and-policies/privacy-policy | — |
| S23 | Platform Terms | https://developers.secure.facebook.com/terms/ | — |
| S24 | Data Deletion Request Callback | https://developers.facebook.com/documentation/development/create-an-app/app-dashboard/data-deletion-callback | — |
| S25 | Build and Test | https://developers.secure.facebook.com/documentation/development/build-and-test | ~550 days |
| S26 | TikTok Business Messaging API | https://business-api.tiktok.com/portal/docs/business-messaging-api/v1.3 | — |
| S27 | TikTok auto messages (help) | https://ads.tiktok.com/help/article/how-to-set-up-auto-messages-for-business-accounts | ~540 days |
| S28 | WhatsApp Business Messaging Policy | https://business.whatsapp.com/policy | Opened directly in the review (redirects to whatsappbusiness.com/policy/); page says last updated September 23, 2026 |
| S29 | WhatsApp Business FAQ, pricing subsection | https://whatsappbusiness.com/resources/faq/ | Opened directly in the review: service messages charged from October 1, 2026 after 1,000 a month per number; also keeps an older conversation-based description |

## State

Study written from search-indexed official pages; not read on the pages (except the three WhatsApp pages the review opened, section 0), not verified against a live app. No feature is available to customers; AutoDM stays off. Accessibility: document only, no interface; steps and decisions 0 → 0.
